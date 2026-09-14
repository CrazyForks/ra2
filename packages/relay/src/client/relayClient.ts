import { relayAddressCandidates, relayRoomFromPath } from '../network/relayAddress';
import { WsRelaySocket } from './wsRelaySocket';
import type { RelaySocket } from './relaySocket';
import {
  RELAY_MAX_BUFFERED_BYTES,
  RelayWireError,
  encodeRelayFrame,
  decodeRelayFrame,
  isRelayClientId,
  isRelayCompatibilityHash,
  isRelayRoomId,
  type RelayWire,
} from '../network/relayWire';

export interface RelayPeer {
  id: string;
  addr: number;
  metadata: Uint8Array;
}
export interface RelayClientHandlers {
  /** welcome 后就绪；已有成员随后逐个触发 onPeerJoin。 */
  onReady?(self: RelayPeer, peers: RelayPeer[]): void;
  onPeerJoin?(peer: RelayPeer): void;
  onPeerLeave?(id: string, addr: number): void;
  onDatagram?(srcAddr: number, srcPort: number, destPort: number, payload: Uint8Array): void;
  onClose?(reason: string): void;
  onError?(error: unknown): void;
  /** 到 relay 的应用层 RTT，不是到其他玩家的 RTT。 */
  onLatency?(rttMs: number): void;
}
export interface RelayClientOptions {
  url: string;
  /** URL 未带路径时的默认房间；显式路径优先。 */
  room?: string;
  compatibilityHash: string;
  metadata?: Uint8Array;
  clientId?: string;
  handshakeTimeoutMs?: number;
  socketFactory?: (url: string) => RelaySocket;
  codec?: { encode: typeof encodeRelayFrame; decode: typeof decodeRelayFrame };
}
function report(handlers: RelayClientHandlers, error: unknown): void {
  handlers.onError?.(error);
}
function newClientId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const random = new Uint32Array(4);
  cryptoObject?.getRandomValues(random);
  return `vm-${[...random].map((part) => part.toString(16).padStart(8, '0')).join('')}-${Math.random().toString(36).slice(2)}`;
}

/** 自动连接、握手和心跳；close 释放会话，不自动重连或重放旧数据报。 */
export class RelayClient {
  readonly clientId: string;
  private readonly urls: string[];
  private attempt = 0;
  private socket: RelaySocket | null = null;
  private closed = false;
  private welcomed = false;
  private assignedAddr = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private latencyTimer: ReturnType<typeof setInterval> | undefined;
  private pingSequence = 0;
  private pendingPing: { n: number; sentAt: number } | undefined;

  constructor(
    private readonly options: RelayClientOptions,
    private readonly handlers: RelayClientHandlers = {},
  ) {
    this.clientId = options.clientId ?? newClientId();
    if (!isRelayClientId(this.clientId)) throw new Error('Invalid relay client ID');
    if (!isRelayCompatibilityHash(options.compatibilityHash))
      throw new Error('Relay requires a SHA-256 compatibility hash');
    if (options.room !== undefined && !isRelayRoomId(options.room)) throw new Error('Invalid relay room');
    this.urls = relayAddressCandidates(options.url, options.room ?? 'default').map((address) => {
      const url = new URL(address);
      url.searchParams.set('clientId', this.clientId);
      return url.href;
    });
    this.join = {
      room: relayRoomFromPath(new URL(this.urls[0]!).pathname),
      metadata: (options.metadata ?? new Uint8Array()).slice(),
      compatibilityHash: options.compatibilityHash,
    };
    // 在创建连接之前校验全部握手字段；非法配置不留下连接或计时器。
    encodeRelayFrame({
      t: 'hello',
      room: this.join.room,
      exe: this.join.compatibilityHash,
      nonce: this.clientId.slice(0, 32),
      n: this.join.metadata,
    });
    this.connect();
  }

  private readonly join: { room: string; metadata: Uint8Array; compatibilityHash: string };

  get ready(): boolean {
    return this.welcomed && !this.closed && this.socket?.readyState === 1;
  }

  get selfAddr(): number {
    return this.assignedAddr;
  }

  private connect(): void {
    if (this.closed) return;
    let socket: RelaySocket;
    try {
      socket = (this.options.socketFactory ?? ((url) => new WsRelaySocket(url)))(this.urls[this.attempt]!);
    } catch (error) {
      if (++this.attempt < this.urls.length) {
        this.connect();
        return;
      }
      this.closed = true;
      report(this.handlers, error);
      this.handlers.onClose?.('connection failed');
      return;
    }
    let opened = false;
    const tryNext = () => {
      if (opened || this.closed || this.socket !== socket || this.attempt + 1 >= this.urls.length) return false;
      this.socket = null;
      this.clearTimers();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      this.attempt++;
      this.connect();
      return true;
    };
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    // 每种协议各有建连/握手预算；仅在 WS 打开前回退，不重连已建立的游戏会话。
    this.handshakeTimer = setTimeout(() => {
      if (!this.closed && !this.welcomed && this.socket === socket && !tryNext()) {
        this.closeWithReason(socket, 4000, 'handshake timeout');
      }
    }, this.options.handshakeTimeoutMs ?? 10000);
    socket.onopen = () => {
      if (this.closed || this.socket !== socket) return;
      opened = true;
      this.sendFrame({
        t: 'hello',
        room: this.join.room,
        exe: this.join.compatibilityHash,
        // 客户端 ID 允许 128 字符，但线协议 nonce 最多 32；默认 UUID 为 36，
        // 不能原样发送，否则真实浏览器会被中继以「hello 字段无效」拒绝。
        nonce: this.clientId.slice(0, 32),
        n: this.join.metadata,
      });
    };
    socket.onmessage = (event: { data: unknown }) => {
      if (this.closed || this.socket !== socket) return;
      void this.receive(event.data, socket);
    };
    socket.onerror = (event: Event) => {
      // Node 的原生 WebSocket 在 TLS 探测失败时可能只发 error、不发 close。
      // 打开前立即尝试下个候选；tryNext 同时解绑旧 socket，迟到事件不会影响新连接。
      if (this.closed || this.socket !== socket || tryNext()) return;
      if (opened || this.attempt + 1 >= this.urls.length) report(this.handlers, event);
    };
    socket.onclose = (event: { code: number; reason: string }) => {
      if (this.closed || this.socket !== socket || tryNext()) return;
      this.socket = null;
      this.closed = true;
      this.clearTimers();
      this.welcomed = false;
      this.handlers.onClose?.(event.reason || `code=${event.code}`);
    };
  }

  private sendFrame(message: RelayWire): boolean {
    const socket = this.socket;
    if (this.closed || !socket || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > RELAY_MAX_BUFFERED_BYTES) {
      this.closeWithReason(socket, 4000, 'slow consumer');
      return false;
    }
    try {
      const frame = (this.options.codec?.encode ?? encodeRelayFrame)(message);
      // 只有内置编码器保证每次分配独占帧；自定义编码器可能返回共享视图。
      if (!this.options.codec && socket.sendOwned) socket.sendOwned(frame);
      else socket.send(frame);
      return true;
    } catch (error: unknown) {
      report(this.handlers, error);
      return false;
    }
  }

  private async receive(data: unknown, socket: RelaySocket): Promise<void> {
    try {
      let binary: ArrayBuffer | ArrayBufferView;
      if (data instanceof Blob) binary = await data.arrayBuffer();
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) binary = data;
      else throw new RelayWireError('protocol', 'Relay message is not binary');
      if (this.closed || this.socket !== socket) return;
      this.handle((this.options.codec?.decode ?? decodeRelayFrame)(binary), socket);
    } catch (error: unknown) {
      report(this.handlers, error);
      if (socket.readyState === 1) {
        const closeCode =
          error instanceof RelayWireError
            ? error.code === 'too-large'
              ? 1009
              : error.code === 'invalid-hash'
                ? 1008
                : 1002
            : 1002;
        this.closeWithReason(
          socket,
          closeCode,
          closeCode === 1009 ? 'frame too large' : closeCode === 1008 ? 'version mismatch' : 'protocol error',
        );
      }
    }
  }

  private handle(message: RelayWire, socket: RelaySocket): void {
    if (!this.welcomed && message.t !== 'welcome' && message.t !== 'ping' && message.t !== 'room-close') {
      this.closeWithReason(socket, 1002, 'welcome required');
      return;
    }
    switch (message.t) {
      case 'welcome': {
        if (this.welcomed) return;
        this.welcomed = true;
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.assignedAddr = message.addr;
        this.handlers.onReady?.({ id: message.peer, addr: message.addr, metadata: this.join.metadata.slice() }, []);
        if (this.closed) return;
        this.latencyTimer = setInterval(() => {
          // 只用于观测；浏览器调度慢不能仅因 ping 迟到就把整局踢掉。
          const ping = { n: ++this.pingSequence >>> 0, sentAt: performance.now() };
          this.pendingPing = ping;
          this.sendFrame({ t: 'ping', n: ping.n, at: Date.now() });
        }, 2000);
        return;
      }
      case 'peer-join':
        if (message.exe !== this.join.compatibilityHash) {
          this.closeWithReason(socket, 1008, 'version mismatch');
          return;
        }
        this.handlers.onPeerJoin?.({ id: message.peer, addr: message.addr, metadata: message.n });
        return;
      case 'peer-leave':
        this.handlers.onPeerLeave?.(message.peer, message.addr);
        return;
      case 'datagram':
        this.handlers.onDatagram?.(message.src, message.sport, message.dport, message.a);
        return;
      case 'ping':
        this.sendFrame({ t: 'pong', n: message.n, at: message.at });
        return;
      case 'room-close':
        this.closeWithReason(socket, 4001, message.reason);
        return;
      case 'pong':
        if (this.pendingPing?.n === message.n) {
          this.handlers.onLatency?.(Math.round(performance.now() - this.pendingPing.sentAt));
          this.pendingPing = undefined;
        }
        return;
      default:
        return;
    }
  }

  sendDatagram(destAddr: number, destPort: number, srcPort: number, payload: Uint8Array): boolean {
    if (!this.welcomed) return false;
    return this.sendFrame({ t: 'datagram', src: 0, sport: srcPort, dest: destAddr, dport: destPort, a: payload });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.welcomed = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
      socket.close(1000, 'client closed');
    }
    this.handlers.onClose?.('closed');
  }

  private closeWithReason(socket: RelaySocket, code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.welcomed = false;
    this.clearTimers();
    if (this.socket === socket) this.socket = null;
    if (socket.readyState === 1 || socket.readyState === 0) {
      socket.close(code, reason);
    }
    this.handlers.onClose?.(reason);
  }

  private clearTimers(): void {
    clearTimeout(this.handshakeTimer);
    clearInterval(this.latencyTimer);
    this.handshakeTimer = undefined;
    this.latencyTimer = undefined;
    this.pendingPing = undefined;
  }
}
