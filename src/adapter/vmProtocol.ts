import type { GamePerformanceSample } from '../games/performance';
import type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';
import type { VmFrame, Win32Call, VmNetworkStatus } from '../vm86/win32';
import type { SupportedGameId } from '../games/catalog';
import type { GuestMemRecordResult } from './memRecord';
import type { VmAttachResult, VmPointerState } from './vmShell';
import type { VmCallBatch, VmPhase } from '../app/session/runtimeEvents';
import type { GameResolution } from '../games/resolution';
import type { Ra2NetworkConfig } from '../games/ra2/networkTransport';

/** 主线程 ↔ worker 的消息协议。数组字段（PCM/帧/EXE）走 transfer，靠单通道 FIFO 保序。 */

/** 随 init 消息传给 worker 的游戏文件（会话包/叠加层）。字节缓冲随消息 transfer，
 *  主线程在组装时已复制出独立缓冲，transfer 不影响页面持有的 provider。 */
export interface GameFileEntry {
  path: string;
  bytes: Uint8Array;
}

export interface VmInitConfig {
  startupPage?: string;
  /** 文件层后端：目录句柄（transfer/克隆）、会话包内存文件（在线 ZIP 解压产物
   *  随消息 transfer）或 dev 的 HTTP 提供器标记。
   *  provider 实例不可结构化克隆，worker 内重建并重新 discover（游戏 sourceTransform 随之重建）。
   *  directory 的 overlays 是目录之上的在线包叠加层（最内层在前，后层覆盖前层），
   *  与页面侧的 Overlay 链读取优先级一致。 */
  provider:
    | { kind: 'directory'; handle: FileSystemDirectoryHandle; overlays?: GameFileEntry[] }
    | { kind: 'memory'; files: GameFileEntry[]; label: string }
    /** 两层加载：完整目录先传，字节按请求经端口读取，未解压文件等待生产者。 */
    | { kind: 'port'; port: MessagePort; names: string[]; label: string }
    | { kind: 'http' };
  /** 多游戏目录时选中项；worker 内重新 discover 后按此选择。 */
  preferredGameId: SupportedGameId;
  /** 页面实际选中的 EXE；路径相对底层 provider 根。Worker 发现游戏前强制覆盖，
   * 不能重新读取开发目录/授权目录的同名旧版。缓冲为独立 transfer 副本。 */
  selectedExecutable?: GameFileEntry;
  /** 自定义地图/文本包，优先于游戏本体；不依赖底层是 HTTP、目录还是内存包。 */
  additionalFiles?: GameFileEntry[];
  /** 读取原版 INI 后仅在内存 provider 层覆盖的启动分辨率；不写回用户目录。 */
  resolution?: GameResolution;
  /** Worker 重建 provider 后覆盖 INI，HTTP 开发版也不能丢失用户名。 */
  playerName?: string;
  /** 显式启用 RA2 联机时使用的房间与 EXE SHA-256；缺省表示单机。 */
  ra2Network?: Ra2NetworkConfig;
  /** 页面持有 WS 连接，Worker 经端口收发；端口随 init transfer。 */
  relayPort?: MessagePort;
  fastFileRead: boolean;
  clockRate: number;
  masterVolume: number;
  /** F2/?debug 调用热点；关闭时 worker 每次 HC 只做整数累加。 */
  traceCalls: boolean;
}

export type MainToWorkerMessage =
  | { type: 'game-performance'; requestId: number }
  | { type: 'attach-maps'; files: GameFileEntry[]; requestId: number }
  | { type: 'init'; config: VmInitConfig; requestId: number }
  | { type: 'wm'; m: number; w: number; l: number }
  | { type: 'key'; vk: number; down: boolean }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'clock'; rate: number }
  | { type: 'volume'; linear: number }
  | { type: 'call-tracing'; enabled: boolean }
  | { type: 'state'; kind: 'pointer'; requestId: number }
  | { type: 'guest-speed-flag'; value: number; requestId: number }
  | { type: 'mem-record-start'; requestId: number }
  | { type: 'mem-record-stop'; requestId: number }
  /** 主线程已经在显示刷新边界消费该帧；worker 据此释放下一帧。 */
  | { type: 'frame-ack'; frameId: number }
  /** 页面不再引用的上一帧；与 ACK 分开，当前画面还需用于鼠标重绘。 */
  | { type: 'recycle-frame'; buffer: ArrayBuffer }
  | { type: 'flush'; requestId: number }
  | { type: 'control'; action: 'start'; requestId: number }
  | { type: 'control'; action: 'stop'; requestId: number };

export type WorkerToMainMessage =
  | { type: 'game-performance-reply'; requestId: number; value: GamePerformanceSample | null }
  | { type: 'network-status'; status: VmNetworkStatus }
  | { type: 'attach-maps-done'; result: VmAttachResult; requestId: number }
  | { type: 'probe'; ready: true }
  | { type: 'status'; phase: VmPhase; detail: string }
  | { type: 'shell-page'; title: string }
  | { type: 'call-batch'; batch: VmCallBatch }
  | { type: 'blocked'; call: Win32Call }
  | { type: 'frame'; frameId: number; frame: VmFrame }
  | {
      type: 'state-reply';
      requestId: number;
      kind: 'pointer';
      value: VmPointerState | null;
    }
  | { type: 'guest-speed-flag-reply'; requestId: number; value: number | null }
  | { type: 'mem-record-start-reply'; requestId: number; ok: boolean }
  | { type: 'mem-record-stop-reply'; requestId: number; result: GuestMemRecordResult | null }
  | { type: 'audio'; op: AudioOp }
  | { type: 'audio-control'; action: 'master-volume'; linear: number }
  | { type: 'audio-control'; action: 'stop-all' }
  | { type: 'audio-control'; action: 'destroy' }
  | { type: 'init-done'; requestId: number }
  | { type: 'flush-done'; requestId: number }
  | { type: 'control-done'; action: 'start' | 'stop'; requestId: number }
  | { type: 'error'; message: string; requestId?: number };

/** 音频操作镜像 Win32AudioSink（win32.ts:105-118）。getState 恒不出现：
 *  跨线程无法同步回读，ProxyAudioSink.getState 返回 null，由 shim 本地记账兜底。 */
export type AudioOp =
  | { op: 'createBuffer'; id: number; byteLength: number; format: PcmWaveFormat }
  | { op: 'duplicateBuffer'; sourceId: number; destinationId: number }
  | { op: 'setFormat'; id: number; format: PcmWaveFormat }
  | { op: 'writeBuffer'; id: number; offset: number; bytes: Uint8Array }
  | { op: 'play'; id: number; options?: PcmPlayOptions }
  | { op: 'stop'; id: number }
  | { op: 'setCurrentPosition'; id: number; byteOffset: number }
  | { op: 'setVolume'; id: number; volume: number }
  | { op: 'setPan'; id: number; pan: number }
  | { op: 'setFrequency'; id: number; frequency: number }
  | { op: 'releaseBuffer'; id: number };

let nextRequestId = 1;
/** 单调递增 requestId（会话内唯一；两线程各自维护不影响关联）。 */
export function createRequestId(): number {
  return nextRequestId++;
}
