import { relayRoomFromPath } from '../network/relayAddress';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  RELAY_HOST_OCTET_MAX,
  RELAY_HOST_OCTET_MIN,
  RELAY_MAX_BUFFERED_BYTES,
  RELAY_MAX_LAN_MEMBERS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_SUBNET_PREFIX,
  RelayWireError,
  decodeRelayFrame,
  encodeRelayFrame,
  isRelayBroadcastAddress,
  isRelayClientId,
  isRelayCompatibilityHash,
} from '../network/relayWire';
import type { RelayWire } from '../network/relayWire';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { RelayFaults, type RelayFaultConfig } from './relayFaults';

const HEARTBEAT_INTERVAL_MS = 15_000;
const HELLO_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_ROOMS = 256;
/** 每连接限速：令牌桶，超限丢包，持续滥用断开。 */
const RATE_PACKETS_PER_SEC = 512;
const RATE_BYTES_PER_SEC = 1024 * 1024;
const RATE_ABUSE_CLOSE_PACKETS = 8192;

/** 房间层只要求消息边界与连接生命周期；由 WS 适配。 */
export interface RelayConnectionSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: RawData, binary: boolean) => void): unknown;
  on(event: 'pong' | 'close' | 'error', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

export interface GameRelayLimits {
  ratePacketsPerSec: number;
  rateBytesPerSec: number;
  rateAbuseClosePackets: number;
  maxBufferedBytes: number;
}

export interface GameRelaySocketAdapter {
  isOpen(socket: RelayConnectionSocket): boolean;
  bufferedAmount(socket: RelayConnectionSocket): number;
  send(socket: RelayConnectionSocket, frame: Uint8Array): void;
  close(socket: RelayConnectionSocket, code: number, reason: string): void;
}

export interface GameRelayOptions {
  maxConnections?: number;
  codec?: { encode: typeof encodeRelayFrame; decode: typeof decodeRelayFrame };
  /** 服务端显式启用；客户端不能通过 URL 开启或修改弱网规则。 */
  faults?: RelayFaultConfig;
  heartbeatIntervalMs?: number;
  helloTimeoutMs?: number;
  logger?: (message: string) => void;
  now?: () => number;
  limits?: Partial<GameRelayLimits>;
  socketAdapter?: GameRelaySocketAdapter;
}

export interface GameRelayStats {
  packets: number;
  bytes: number;
  datagramsRouted: number;
  datagramsDropped: number;
  rateLimited: number;
}

interface RelayConnection {
  id: number;
  clientId: string;
  socket: RelayConnectionSocket;
  roomId: string | null;
  pathRoom?: string;
  addr: number;
  name: Uint8Array;
  compatibilityHash: string;
  alive: boolean;
  helloTimer: ReturnType<typeof globalThis.setTimeout> | null;
  protocolCloseTimer: ReturnType<typeof globalThis.setTimeout> | null;
  disconnected: boolean;
  packetTokens: number;
  byteTokens: number;
  lastRateAt: number;
  rateDrops: number;
}

interface RelayRoom {
  id: string;
  epoch: number;
  members: Set<RelayConnection>;
  /** 单播按虚拟地址直达，避免每个数据报分配成员数组并线性搜索。 */
  byAddress: Map<number, RelayConnection>;
  usedAddrs: Set<number>;
  compatibilityHash: string;
}

function frameBuffer(frame: Uint8Array): Buffer {
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const combined = Buffer.concat(data);
    return new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
  }
  throw new RelayWireError('protocol', 'WebSocket data is not binary');
}

function isOpen(socket: RelayConnectionSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

const DEFAULT_LIMITS: GameRelayLimits = {
  ratePacketsPerSec: RATE_PACKETS_PER_SEC,
  rateBytesPerSec: RATE_BYTES_PER_SEC,
  rateAbuseClosePackets: RATE_ABUSE_CLOSE_PACKETS,
  maxBufferedBytes: RELAY_MAX_BUFFERED_BYTES,
};

const DEFAULT_SOCKET_ADAPTER: GameRelaySocketAdapter = {
  isOpen,
  bufferedAmount: (socket) => socket.bufferedAmount,
  send: (socket, frame) => socket.send(frameBuffer(frame)),
  close: (socket, code, reason) => socket.close(code, reason),
};

export function sendGameRelayFrame(
  socket: RelayConnectionSocket,
  frame: Uint8Array,
  limits: Pick<GameRelayLimits, 'maxBufferedBytes'> = DEFAULT_LIMITS,
  adapter: GameRelaySocketAdapter = DEFAULT_SOCKET_ADAPTER,
): boolean {
  if (!adapter.isOpen(socket)) return false;
  if (adapter.bufferedAmount(socket) > limits.maxBufferedBytes) {
    adapter.close(socket, 1008, 'slow consumer');
    return false;
  }
  try {
    adapter.send(socket, frame);
    return true;
  } catch {
    return false;
  }
}

/** 房间虚拟地址：10.247.high.low，两个主机号八位组都避开 0/255（与客户端自分配同界）；
 *  中继按连接分配，客户端不可自选。 */
function allocateAddress(room: RelayRoom): number | null {
  for (let high = RELAY_HOST_OCTET_MIN; high <= RELAY_HOST_OCTET_MAX; high++) {
    for (let low = RELAY_HOST_OCTET_MIN; low <= RELAY_HOST_OCTET_MAX; low++) {
      const addr = (RELAY_SUBNET_PREFIX | (high << 8) | low) >>> 0;
      if (!room.usedAddrs.has(addr)) return addr;
    }
  }
  return null;
}

/**
 * 通用虚拟局域网房间中继：内存房间表、虚拟地址分配、数据报路由与限速。
 * 中继不解释客体 payload；源地址一律按连接覆写，客户端声明不被信任。
 */
export class GameRelay {
  private readonly encode: typeof encodeRelayFrame;
  private readonly decode: typeof decodeRelayFrame;
  private faults?: RelayFaults;
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME_BYTES });
  private readonly connections = new Set<RelayConnection>();
  private readonly rooms = new Map<string, RelayRoom>();
  private readonly shutdownTimers = new Map<RelayConnection, ReturnType<typeof globalThis.setTimeout>>();
  private readonly shutdownTracked = new Set<RelayConnection>();
  private readonly log: (message: string) => void;
  private readonly helloTimeoutMs: number;
  private readonly now: () => number;
  private readonly limits: GameRelayLimits;
  private readonly socketAdapter: GameRelaySocketAdapter;
  private readonly heartbeatTimer: ReturnType<typeof globalThis.setInterval>;
  private nextConnectionId = 1;
  private nextEpoch = 1;
  private closed = false;
  private closingCount = 0;
  private draining = false;
  private readonly maxConnections: number;
  private drainedResolve: (() => void) | null = null;
  private readonly stats: GameRelayStats = {
    packets: 0,
    bytes: 0,
    datagramsRouted: 0,
    datagramsDropped: 0,
    rateLimited: 0,
  };

  constructor(options: GameRelayOptions = {}) {
    this.encode = options.codec?.encode ?? encodeRelayFrame;
    this.decode = options.codec?.decode ?? decodeRelayFrame;
    this.maxConnections = options.maxConnections ?? 2048;
    if (!Number.isInteger(this.maxConnections) || this.maxConnections < 1) throw new Error('中继连接上限无效');
    this.faults = options.faults ? new RelayFaults(options.faults) : undefined;
    this.log = options.logger ?? ((message) => console.log(message));
    if (options.faults)
      this.log(`[game-relay] 已启用应用数据报弱网模拟（非 TCP 弱网）：${JSON.stringify(options.faults)}`);
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.socketAdapter = options.socketAdapter ?? DEFAULT_SOCKET_ADAPTER;
    this.server.on('connection', (socket: RelayConnectionSocket, request: IncomingMessage) => {
      this.acceptConnection(socket, request);
    });
    this.heartbeatTimer = globalThis.setInterval(
      () => this.heartbeat(),
      options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    );
    const timer = this.heartbeatTimer as ReturnType<typeof globalThis.setInterval> & { unref?: () => void };
    timer.unref?.();
  }

  /** Attach this relay to a Node HTTP upgrade event after the caller filters the pathname. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    try {
      relayRoomFromPath(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, (client) => {
      this.server.emit('connection', client, request);
    });
  }

  getStats(): GameRelayStats {
    return { ...this.stats };
  }

  getHealth() {
    return {
      draining: this.draining,
      connections: this.connections.size,
      rooms: this.rooms.size,
      players: [...this.rooms.values()].reduce((sum, room) => sum + room.members.size, 0),
    };
  }

  /** 维护时只停止接纳新玩家；现有对局继续路由，不把部署变成全员掉线。 */
  beginDrain(): void {
    this.draining = true;
    this.log('[game-relay] 停止接纳新玩家，等待已有连接退出');
  }

  getFaultStats() {
    return this.faults?.getStats() ?? { queuedPackets: 0, queuedBytes: 0, dropped: 0, delayed: 0 };
  }

  /** 管理端/测试代码在开局后注入故障；不暴露客户端可调用的网络接口。 */
  setFaults(config?: RelayFaultConfig): void {
    if (this.closed) throw new Error('中继已关闭');
    // 未发消息不能因切换规则被提前放行或丢弃，否则会掩盖故障及破坏保序。
    if (this.faults?.getStats().queuedPackets) throw new Error('弱网队列未排空，不能切换规则');
    const next = config ? new RelayFaults(config) : undefined;
    this.faults?.close();
    this.faults = next;
    this.log(`[game-relay] 弱网规则切换：${JSON.stringify(config ?? null)}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.faults?.close();
    globalThis.clearInterval(this.heartbeatTimer);
    for (const connection of [...this.connections]) {
      if (connection.helloTimer !== null) globalThis.clearTimeout(connection.helloTimer);
      const socket = connection.socket;
      if (socket.readyState !== WebSocket.CLOSED) {
        this.trackShutdown(connection);
        // 服务关闭先接管连接，再清掉协议拒绝计时器，避免 CLOSING 连接失去兜底。
        this.clearProtocolCloseTimer(connection);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1001, 'relay closing');
        }
        const hardStop = this.shutdownTimers.get(connection);
        if (hardStop !== undefined)
          (hardStop as ReturnType<typeof globalThis.setTimeout> & { unref?: () => void }).unref?.();
      }
    }
    this.connections.clear();
    this.rooms.clear();
    this.server.close();
  }

  /** 等待 close() 的所有连接真正收口（对端回 close 帧或 2s 强杀），最多等 timeoutMs。 */
  async drained(timeoutMs = 2500): Promise<void> {
    if (this.closingCount === 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof globalThis.setTimeout>;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        this.drainedResolve = null;
        resolve();
      };
      timer = globalThis.setTimeout(finish, timeoutMs);
      this.drainedResolve = finish;
    });
  }

  private trackShutdown(connection: RelayConnection): void {
    if (this.shutdownTracked.has(connection)) return;
    this.shutdownTracked.add(connection);
    this.closingCount++;
    connection.socket.once('close', () => this.finishShutdown(connection));
    const hardStop = globalThis.setTimeout(() => {
      if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
    }, CLOSE_GRACE_MS);
    this.shutdownTimers.set(connection, hardStop);
  }

  private finishShutdown(connection: RelayConnection): void {
    const timer = this.shutdownTimers.get(connection);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    this.shutdownTimers.delete(connection);
    if (!this.shutdownTracked.delete(connection)) return;
    this.closingCount--;
    if (this.closingCount === 0) this.drainedResolve?.();
  }

  private clearProtocolCloseTimer(connection: RelayConnection): void {
    if (connection.protocolCloseTimer === null) return;
    globalThis.clearTimeout(connection.protocolCloseTimer);
    connection.protocolCloseTimer = null;
  }

  private acceptConnection(socket: RelayConnectionSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    this.acceptTransport(socket, url.searchParams.get('clientId'), relayRoomFromPath(url.pathname));
  }

  acceptTransport(socket: RelayConnectionSocket, suppliedClientId: string | null, pathRoom?: string): void {
    if (this.closed || this.draining || this.connections.size >= this.maxConnections) {
      socket.close(1013, this.draining ? 'relay draining' : 'relay busy');
      return;
    }
    if (suppliedClientId !== null && !isRelayClientId(suppliedClientId)) {
      socket.close(1008, 'invalid clientId');
      return;
    }
    const connection: RelayConnection = {
      id: this.nextConnectionId++,
      clientId: suppliedClientId ?? `anonymous-${this.nextConnectionId}`,
      socket,
      roomId: null,
      pathRoom,
      addr: 0,
      name: new Uint8Array(0),
      compatibilityHash: '',
      alive: true,
      helloTimer: null,
      protocolCloseTimer: null,
      disconnected: false,
      packetTokens: this.limits.ratePacketsPerSec,
      byteTokens: this.limits.rateBytesPerSec,
      lastRateAt: this.now(),
      rateDrops: 0,
    };
    // 首帧必须是 hello；超时未握手即关闭，避免空连接占资源。
    connection.helloTimer = globalThis.setTimeout(() => {
      if (!connection.roomId) this.closeForProtocol(connection, 1008, 'hello timeout');
    }, this.helloTimeoutMs);
    this.connections.add(connection);
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (data: RawData, isBinary: boolean) => this.receive(connection, data, isBinary));
    socket.on('close', () => this.disconnect(connection));
    socket.on('error', () => undefined);
    this.log(`[game-relay] connected #${connection.id} client=${connection.clientId.slice(0, 12)}`);
  }

  private receive(connection: RelayConnection, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      this.closeForProtocol(connection, 1002, 'binary frames required');
      return;
    }
    let frame: Uint8Array;
    try {
      frame = rawDataBytes(data);
    } catch (error: unknown) {
      this.closeForProtocol(connection, 1002, error instanceof Error ? error.message : 'invalid binary frame');
      return;
    }
    if (frame.byteLength > RELAY_MAX_FRAME_BYTES) {
      this.closeForProtocol(connection, 1009, 'frame too large');
      return;
    }
    let message: RelayWire;
    try {
      message = this.decode(frame);
    } catch (error: unknown) {
      const code =
        error instanceof RelayWireError
          ? error.code === 'too-large'
            ? 1009
            : error.code === 'invalid-hash'
              ? 1008
              : 1002
          : 1002;
      this.closeForProtocol(connection, code, error instanceof Error ? error.message : 'invalid frame');
      return;
    }
    this.stats.packets++;
    this.stats.bytes += frame.byteLength;
    if (!connection.roomId) {
      // 握手前只接受 hello。
      if (message.t !== 'hello') {
        this.closeForProtocol(connection, 1008, 'hello required');
        return;
      }
      this.handleHello(connection, message);
      return;
    }
    switch (message.t) {
      case 'hello':
        this.closeForProtocol(connection, 1008, 'duplicate hello');
        return;
      case 'datagram':
        this.handleDatagram(connection, message);
        return;
      case 'ping':
        this.send(connection, this.encode({ t: 'pong', n: message.n, at: message.at }));
        return;
      case 'pong':
        connection.alive = true;
        return;
      default:
        // welcome/peer-join/peer-leave/room-close 只能由中继发出。
        this.closeForProtocol(connection, 1008, `client must not send ${message.t}`);
    }
  }

  private handleHello(connection: RelayConnection, message: Extract<RelayWire, { t: 'hello' }>): void {
    if (this.draining) {
      connection.socket.close(1013, 'relay draining');
      return;
    }
    if (connection.helloTimer !== null) {
      globalThis.clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
    }
    if (!isRelayCompatibilityHash(message.exe)) {
      this.closeForProtocol(connection, 1008, 'valid compatibility hash required');
      return;
    }
    // 路径是服务端约束，不能靠伪造 hello 加入另一房间。
    const roomId = connection.pathRoom ?? message.room;
    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) {
        this.closeForProtocol(connection, 1008, 'too many rooms');
        return;
      }
      room = {
        id: roomId,
        epoch: this.nextEpoch++,
        members: new Set(),
        byAddress: new Map(),
        usedAddrs: new Set(),
        compatibilityHash: message.exe,
      };
      this.rooms.set(roomId, room);
    }
    // 版本隔离：同一房间只允许相同且非空的应用兼容性 SHA-256。
    if (room.compatibilityHash !== message.exe) {
      this.closeForProtocol(connection, 1008, 'version mismatch');
      return;
    }
    if (room.members.size >= RELAY_MAX_LAN_MEMBERS) {
      this.closeForProtocol(connection, 1008, 'room full');
      return;
    }
    const addr = allocateAddress(room);
    if (addr === null) {
      this.closeForProtocol(connection, 1008, 'address pool exhausted');
      return;
    }
    room.usedAddrs.add(addr);
    connection.roomId = room.id;
    connection.addr = addr;
    connection.name = message.n.slice();
    connection.compatibilityHash = message.exe;
    this.send(connection, this.encode({ t: 'welcome', peer: connection.clientId, addr, epoch: room.epoch }));
    // 先入成员逐个通知新成员，再把新成员广播给先入成员。
    for (const member of room.members) {
      this.send(
        connection,
        this.encode({
          t: 'peer-join',
          peer: member.clientId,
          addr: member.addr,
          exe: member.compatibilityHash,
          n: member.name,
        }),
      );
    }
    room.members.add(connection);
    room.byAddress.set(addr, connection);
    this.broadcastRoom(
      room,
      this.encode({
        t: 'peer-join',
        peer: connection.clientId,
        addr,
        exe: connection.compatibilityHash,
        n: connection.name,
      }),
      connection,
    );
    this.log(
      `[game-relay] #${connection.id} joined room=${room.id} addr=${(addr >>> 24) & 0xff}.${(addr >>> 16) & 0xff}.${(addr >>> 8) & 0xff}.${addr & 0xff} members=${room.members.size}`,
    );
  }

  private handleDatagram(connection: RelayConnection, message: Extract<RelayWire, { t: 'datagram' }>): void {
    const room = connection.roomId ? this.rooms.get(connection.roomId) : undefined;
    if (!room || !room.members.has(connection)) return;
    const expectedRecipients = isRelayBroadcastAddress(message.dest) ? Math.max(0, room.members.size - 1) : 1;
    if (!this.allowRate(connection, message.a.byteLength)) {
      this.stats.rateLimited++;
      this.stats.datagramsDropped += expectedRecipients;
      connection.rateDrops++;
      if (connection.rateDrops >= this.limits.rateAbuseClosePackets) {
        this.closeForProtocol(connection, 1008, 'rate limit exceeded');
      }
      return;
    }
    // 源地址按连接覆写：客户端不能伪造其他玩家身份。
    const frame = this.encode({
      t: 'datagram',
      src: connection.addr,
      sport: message.sport,
      dest: message.dest,
      dport: message.dport,
      a: message.a,
    });
    if (isRelayBroadcastAddress(message.dest)) {
      for (const member of room.members) {
        if (member !== connection) this.routeDatagram(room, connection, member, frame);
      }
      return;
    }
    const target = room.byAddress.get(message.dest);
    if (!target) {
      // 目标不在房间：按 UDP 语义静默丢弃。
      this.stats.datagramsDropped++;
      return;
    }
    this.routeDatagram(room, connection, target, frame);
  }

  private routeDatagram(room: RelayRoom, source: RelayConnection, target: RelayConnection, frame: Uint8Array): void {
    const finish = (deliver: boolean): void => {
      // 延迟期间退出的旧连接不能把消息投递给地址复用后的新玩家。
      if (deliver && !this.closed && room.members.has(source) && room.members.has(target) && this.send(target, frame)) {
        this.stats.datagramsRouted++;
      } else this.stats.datagramsDropped++;
    };
    if (this.faults) this.faults.route(room.id, source, target, frame.byteLength, finish);
    else finish(true);
  }

  /** 令牌桶限速：按秒补充；突发允许到一倍桶容。 */
  private allowRate(connection: RelayConnection, bytes: number): boolean {
    const now = Math.max(connection.lastRateAt, this.now());
    const elapsed = Math.max(0, now - connection.lastRateAt) / 1000;
    connection.packetTokens = Math.min(
      this.limits.ratePacketsPerSec,
      connection.packetTokens + elapsed * this.limits.ratePacketsPerSec,
    );
    connection.byteTokens = Math.min(
      this.limits.rateBytesPerSec,
      connection.byteTokens + elapsed * this.limits.rateBytesPerSec,
    );
    connection.lastRateAt = now;
    if (connection.packetTokens < 1 || connection.byteTokens < bytes) return false;
    connection.packetTokens--;
    connection.byteTokens -= bytes;
    return true;
  }

  private broadcastRoom(
    room: RelayRoom,
    frame: Uint8Array,
    excluded: RelayConnection | null,
  ): { sent: number; dropped: number } {
    let sent = 0;
    let dropped = 0;
    for (const member of room.members) {
      if (member === excluded) continue;
      if (this.send(member, frame)) sent++;
      else dropped++;
    }
    return { sent, dropped };
  }

  private send(connection: RelayConnection, frame: Uint8Array): boolean {
    return sendGameRelayFrame(connection.socket, frame, this.limits, this.socketAdapter);
  }

  private closeForProtocol(connection: RelayConnection, code: 1002 | 1008 | 1009, reason: string): void {
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.close(code, reason);
      if (connection.protocolCloseTimer === null) {
        connection.protocolCloseTimer = globalThis.setTimeout(() => {
          connection.protocolCloseTimer = null;
          if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
        }, CLOSE_GRACE_MS);
      }
    }
  }

  private disconnect(connection: RelayConnection): void {
    if (connection.disconnected) return;
    connection.disconnected = true;
    this.connections.delete(connection);
    this.faults?.disconnect(connection.id);
    this.clearProtocolCloseTimer(connection);
    if (connection.helloTimer !== null) globalThis.clearTimeout(connection.helloTimer);
    const room = connection.roomId ? this.rooms.get(connection.roomId) : undefined;
    if (room && room.members.has(connection)) {
      room.members.delete(connection);
      room.byAddress.delete(connection.addr);
      room.usedAddrs.delete(connection.addr);
      this.broadcastRoom(
        room,
        this.encode({
          t: 'peer-leave',
          peer: connection.clientId,
          addr: connection.addr,
        }),
        null,
      );
      // 房间人去楼空即销毁：旧 epoch 不会跨房间重放。
      if (room.members.size === 0) this.rooms.delete(room.id);
    }
    this.finishShutdown(connection);
    this.log(`[game-relay] disconnected #${connection.id} client=${connection.clientId.slice(0, 12)}`);
  }

  private heartbeat(): void {
    if (this.closed) return;
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      if (isOpen(connection.socket)) connection.socket.ping();
      // 令牌桶按心跳周期补充（15s 一次充满，允许短时突发）。
    }
  }
}

export function createGameRelay(options: GameRelayOptions = {}): GameRelay {
  return new GameRelay(options);
}
