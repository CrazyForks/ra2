import type { RelaySocket } from 'relay-package/client';
import { RelayClient, normalizeRelayAddress } from 'relay-package/client';
import {
  RA2NET_HOST_OCTET_COUNT,
  RA2NET_HOST_OCTET_MIN,
  RA2NET_SUBNET_PREFIX,
  decodeRa2NetworkFrame,
  encodeRa2NetworkFrame,
  isRa2ExeHash,
  isRa2BroadcastAddress,
  isRa2NetworkWire,
} from './networkWire';
import type { Ra2NetworkWire } from './networkWire';

/** BroadcastChannel 频道前缀；房间 id 直接拼在后面（开发链路不做鉴权）。 */
export const RA2NET_BROADCAST_CHANNEL_PREFIX = 'ra2-winsock-lan:';
/** WebSocket 中继的默认路径（与资源 /game/*、DirectPlay /game 升级区分开）。 */
export const RA2NET_WEBSOCKET_PATH = '/ra2';

export interface Ra2NetworkPeer {
  id: string;
  addr: number;
  name: Uint8Array;
}

export interface Ra2NetworkConfig {
  room: string;
  exeHash: string;
  relayUrl?: string;
}

/** 红警页面与 Worker 共用确定性规则，不发起 WSS/WS 探测或 DNS 查询。 */
export function parseRa2RelayUrl(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeRelayAddress(value, 'ra2');
  const url = new URL(/^wss?:\/\//.test(normalized) ? normalized : `ws://${normalized}`);
  const authority = value
    .trim()
    .replace(/^wss?:\/\//i, '')
    .split(/[/?#]/, 1)[0]!;
  const port = authority.match(/:(\d+)$/)?.[1];
  if (port && Number(port) === 0) throw new Error('relay 必须使用 1–65535 的端口');
  url.protocol = isLocalRelayHost(url.hostname) ? 'ws:' : 'wss:';
  // 改协议不能把显式 :80 / :443 变成新协议的默认端口。
  if (port) url.port = port;
  return url.href;
}

function isLocalRelayHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = (parts: number[]) =>
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return ipv4(host.split('.').map(Number));
  if (!host.startsWith('[')) return false;
  const literal = host.slice(1, -1);
  if (literal === '::1') return true;
  const first = Number.parseInt(literal.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  // URL 将 IPv4-mapped IPv6 规范化为十六进制，按其内嵌 IPv4 判断。
  const mapped = literal.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1]!, 16),
    low = Number.parseInt(mapped[2]!, 16);
  return ipv4([high >>> 8, high & 255, low >>> 8, low & 255]);
}

export interface Ra2NetworkTransportHandlers {
  /** 房间握手完成：拿到自己的虚拟地址与当前成员快照。 */
  onReady(self: Ra2NetworkPeer, peers: Ra2NetworkPeer[]): void;
  onPeerJoin(peer: Ra2NetworkPeer): void;
  onPeerLeave(id: string, addr: number): void;
  /** 中继已按连接覆写源地址；BroadcastChannel 链路是对端自报（仅开发用）。 */
  onDatagram(srcAddr: number, srcPort: number, destPort: number, payload: Uint8Array): void;
  onClose?(reason: string): void;
  onError?(error: unknown): void;
  /** 浏览器到中继的应用层往返耗时，不代表玩家间 RTT 或游戏逻辑进度。 */
  onLatency?(rttMs: number): void;
}

export interface Ra2NetworkTransport {
  readonly clientId: string;
  /** 握手完成、拿到虚拟地址后才为 true；此前的出站数据报按 UDP 语义丢弃。 */
  readonly ready: boolean;
  readonly selfAddr: number;
  sendDatagram(destAddr: number, destPort: number, srcPort: number, payload: Uint8Array): boolean;
  close(): void;
}

export interface Ra2NetworkJoin extends Ra2NetworkConfig {
  name: Uint8Array;
}

export type Ra2NetworkTransportFactory = (
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
) => Ra2NetworkTransport;

function newClientId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const random = new Uint32Array(4);
  cryptoObject?.getRandomValues(random);
  return `vm-${[...random].map((part) => part.toString(16).padStart(8, '0')).join('')}-${Math.random().toString(36).slice(2)}`;
}

function report(handlers: Ra2NetworkTransportHandlers, error: unknown): void {
  handlers.onError?.(error);
}

/** 自分配虚拟地址（BroadcastChannel 无中继）：clientId 散列进 10.247.x.y。
 *  主机号范围与中继分配共用 relay 包的同一组边界，两端不再各写一份 1/254。 */
export function selfAssignAddress(clientId: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < clientId.length; i++) {
    hash = Math.imul(hash ^ clientId.charCodeAt(i), 0x0100_0193) >>> 0;
  }
  const high = RA2NET_HOST_OCTET_MIN + (((hash >>> 8) & 0xfe) % RA2NET_HOST_OCTET_COUNT);
  const low = RA2NET_HOST_OCTET_MIN + ((hash & 0xfe) % RA2NET_HOST_OCTET_COUNT);
  return (RA2NET_SUBNET_PREFIX | (high << 8) | low) >>> 0;
}

/**
 * BroadcastChannel structured-clones the complete backing ArrayBuffer of a
 * typed-array view. Guest-memory reads are views into the VM's full WASM
 * memory, so copy only the logical payload before posting it.
 */
function copyStructuredPayload(message: Ra2NetworkWire): Ra2NetworkWire {
  switch (message.t) {
    case 'hello':
    case 'peer-join':
      return { ...message, n: message.n.slice() };
    case 'datagram':
      return { ...message, a: message.a.slice() };
    case 'welcome':
    case 'peer-leave':
    case 'ping':
    case 'pong':
    case 'room-close':
      return message;
  }
}

/**
 * 同源多标签页/Node 冒烟传输：无中继，地址自分配，成员靠 peer-join 互答收敛。
 * 只覆盖同源同浏览器配置文件的页面，是开发与自动回归链路，不代表真实局域网。
 */
export class Ra2BroadcastChannelTransport implements Ra2NetworkTransport {
  readonly clientId: string;
  readonly selfAddr: number;
  private readonly channel: BroadcastChannel;
  private readonly peers = new Map<string, Ra2NetworkPeer>();
  private closed = false;
  private announced = false;

  constructor(
    private readonly handlers: Ra2NetworkTransportHandlers,
    join: Ra2NetworkJoin,
    channelPrefix = RA2NET_BROADCAST_CHANNEL_PREFIX,
  ) {
    this.clientId = newClientId();
    if (!isRa2ExeHash(join.exeHash)) throw new Error('RA2 联机需要有效的 EXE SHA-256');
    this.selfAddr = selfAssignAddress(this.clientId);
    if (typeof globalThis.BroadcastChannel !== 'function') {
      throw new Error('BroadcastChannel is unavailable in this runtime');
    }
    const channel = new globalThis.BroadcastChannel(`${channelPrefix}${join.room}:${join.exeHash}`);
    this.channel = channel;
    this.name = join.name.slice(0, 64);
    this.exeHash = join.exeHash;
    channel.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    channel.onmessageerror = (event: MessageEvent<unknown>) => report(handlers, event);
    // 先就绪再广播：onReady 之后 shim 才会发包，peer-join 必须让对端看到完整状态。
    globalThis.queueMicrotask(() => {
      if (this.closed) return;
      handlers.onReady({ id: this.clientId, addr: this.selfAddr, name: this.name.slice() }, []);
      this.announce();
    });
  }

  private readonly name: Uint8Array;
  private readonly exeHash: string;

  get ready(): boolean {
    return this.announced && !this.closed;
  }

  private announce(): void {
    if (this.closed) return;
    this.announced = true;
    this.post({ t: 'peer-join', peer: this.clientId, addr: this.selfAddr, exe: this.exeHash, n: this.name });
  }

  private post(message: Ra2NetworkWire): boolean {
    if (this.closed) return false;
    try {
      this.channel.postMessage(copyStructuredPayload(message));
      return true;
    } catch (error: unknown) {
      report(this.handlers, error);
      return false;
    }
  }

  private receive(data: unknown): void {
    if (this.closed || !isRa2NetworkWire(data)) return;
    switch (data.t) {
      case 'peer-join': {
        if (data.peer === this.clientId) return;
        if (data.exe !== this.exeHash) return;
        const known = this.peers.has(data.peer);
        this.peers.set(data.peer, { id: data.peer, addr: data.addr, name: data.n });
        if (!known) {
          // 新成员入场：回播自己，让加入方收敛出完整成员表。
          this.post({ t: 'peer-join', peer: this.clientId, addr: this.selfAddr, exe: this.exeHash, n: this.name });
          this.handlers.onPeerJoin({ id: data.peer, addr: data.addr, name: data.n });
        }
        return;
      }
      case 'peer-leave': {
        if (this.peers.delete(data.peer)) this.handlers.onPeerLeave(data.peer, data.addr);
        return;
      }
      case 'datagram': {
        if (data.src === this.selfAddr) return; // 不回声自己的包（BroadcastChannel 本不回声，防御中继混接）
        if (data.dest !== this.selfAddr && !isRa2BroadcastAddress(data.dest)) return;
        this.handlers.onDatagram(data.src, data.sport, data.dport, data.a);
        return;
      }
      case 'ping':
        this.post({ t: 'pong', n: data.n, at: data.at });
        return;
      default:
        return;
    }
  }

  sendDatagram(destAddr: number, destPort: number, srcPort: number, payload: Uint8Array): boolean {
    if (!this.announced) return false;
    return this.post({
      t: 'datagram',
      src: this.selfAddr,
      sport: srcPort,
      dest: destAddr,
      dport: destPort,
      a: payload,
    });
  }

  close(): void {
    if (this.closed) return;
    this.post({ t: 'peer-leave', peer: this.clientId, addr: this.selfAddr });
    this.closed = true;
    this.channel.close();
    this.handlers.onClose?.('closed');
  }
}

interface Ra2WebSocketTransportOptions {
  url?: string;
  clientId?: string;
  handshakeTimeoutMs?: number;
  socketFactory?: (url: string) => RelaySocket;
  codec?: { encode: typeof encodeRa2NetworkFrame; decode: typeof decodeRa2NetworkFrame };
}

function websocketUrl(clientId: string, suppliedUrl?: string): string {
  if (suppliedUrl) return parseRa2RelayUrl(suppliedUrl)!;
  const pageLocation = globalThis.location;
  if (!pageLocation) throw new Error('A WebSocket URL is required outside a browser page');
  const base = new URL(
    RA2NET_WEBSOCKET_PATH,
    pageLocation.origin && pageLocation.origin !== 'null' ? `${pageLocation.origin}/` : pageLocation.href,
  );
  if (base.protocol === 'http:') base.protocol = 'ws:';
  if (base.protocol === 'https:') base.protocol = 'wss:';
  base.searchParams.set('clientId', clientId);
  return base.href;
}

/**
 * WebSocket 房间中继传输：连接后先送 hello，等 welcome 分配虚拟地址。
 * 断线按 UDP 语义处理——不自动重连进旧房间（旧 epoch 的帧会污染新对局），
 * 由 shim 把掉线映射为玩家离开。
 */
export class Ra2WebSocketTransport extends RelayClient implements Ra2NetworkTransport {
  constructor(handlers: Ra2NetworkTransportHandlers, join: Ra2NetworkJoin, options: Ra2WebSocketTransportOptions = {}) {
    const clientId = options.clientId ?? newClientId();
    super(
      {
        ...options,
        url: websocketUrl(clientId, options.url),
        clientId,
        room: join.room,
        compatibilityHash: join.exeHash,
        metadata: join.name.slice(0, 64),
      },
      {
        ...handlers,
        onReady: (self, peers) =>
          handlers.onReady(
            { id: self.id, addr: self.addr, name: self.metadata },
            peers.map((peer) => ({ id: peer.id, addr: peer.addr, name: peer.metadata })),
          ),
        onPeerJoin: (peer) => handlers.onPeerJoin({ id: peer.id, addr: peer.addr, name: peer.metadata }),
      },
    );
  }
}

export function createRa2BroadcastChannelTransport(
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
): Ra2NetworkTransport {
  return new Ra2BroadcastChannelTransport(handlers, join);
}

export function createRa2WebSocketTransport(
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
  options: Ra2WebSocketTransportOptions = {},
): Ra2NetworkTransport {
  return new Ra2WebSocketTransport(handlers, join, options);
}

/** 浏览器默认 WebSocket 中继；Node 冒烟显式注入 BroadcastChannel 工厂。 */
export function createDefaultRa2NetworkTransport(
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
): Ra2NetworkTransport {
  if (globalThis.location && typeof globalThis.WebSocket === 'function') {
    return createRa2WebSocketTransport(handlers, join);
  }
  if (!globalThis.location && typeof globalThis.BroadcastChannel === 'function') {
    return new Ra2BroadcastChannelTransport(handlers, join);
  }
  throw new Error('No default RA2 network transport is available');
}
