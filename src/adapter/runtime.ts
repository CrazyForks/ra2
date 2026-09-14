import type { GamePerformanceSample } from '../games/performance';
import { serveRelayPort, relayAddressCandidates, relayRoomFromPath } from 'relay-package/client';
import { createBrowserEmulator } from '../platform/browser/emulator';
import { DEFAULT_MASTER_VOLUME, WebAudioPcmSink } from './audio';
import { gameVmConfiguration } from '../games/vmConfiguration';
import {
  collectDirectoryOverlays,
  directoryHandleOf,
  directoryScopeOf,
} from '../platform/browser/files/directoryAccess';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { ScopedGameFileProvider } from '../resources/providers/scoped';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { serveFileProvider } from './fileProviderPort';
import { mountCustomMapFiles, prepareDynamicMaps } from './customMapPackage';
import { VmCore, type VmCorePlatform } from './vmCore';
import { WorkerVmClient, type WorkerVmClientOptions } from './vmClient';
import type { GuestMemRecordResult } from './memRecord';
import type { GameFileEntry, VmInitConfig } from './vmProtocol';
import type { VmPointerState, VmShell } from './vmShell';
import type { GameVmCallbacks } from '../app/session/runtimeEvents';
import { withGameResolutionOverride } from '../games/resolution';
import { randomMultiplayerName, validateMultiplayerName, withMultiplayerNameOverride } from '../games/multiplayerName';
import { parseRa2RelayUrl, type Ra2NetworkConfig } from '../games/ra2/networkTransport';

export type { VmShell } from './vmShell';

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function hashRa2Executable(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持联机所需的 SHA-256');
  const digest = await subtle.digest('SHA-256', bytes.slice() as BufferSource);
  let hash = '';
  for (const byte of new Uint8Array(digest)) hash += byte.toString(16).padStart(2, '0');
  return hash;
}

export async function resolveRa2NetworkConfig(source: GameSource): Promise<Ra2NetworkConfig | undefined> {
  if (!['ra2', 'yr'].includes(source.game.id) || typeof window === 'undefined') return undefined;
  const query = new URLSearchParams(window.location.search);
  if (query.get('network') === '0' || !(query.get('network') === '1' || query.has('relay'))) return undefined;
  // 房间只来自 URL 路径，避免页面配置与服务端实际房间分歧。
  const relayUrl = parseRa2RelayUrl(query.get('relay'));
  const room = relayUrl ? relayRoomFromPath(new URL(relayAddressCandidates(relayUrl)[0]!).pathname) : 'ra2';
  return { room, exeHash: await hashRa2Executable(source.executableBytes), ...(relayUrl ? { relayUrl } : {}) };
}

/** 只识别会话来源，不枚举/压平资源字节；端口服务始终保留整个覆盖链。 */
function sessionFilesOf(provider: GameFileProvider): SessionGameFileProvider | null {
  let current: GameFileProvider = provider;
  while (current instanceof ScopedGameFileProvider || current instanceof OverlayGameFileProvider) {
    current = current.parent;
  }
  if (!(current instanceof SessionGameFileProvider)) return null;
  return current;
}

/** 逐文件复制出独立缓冲并登记 transfer：会话包文件通常是大解码缓冲的切片视图，
 *  直接 transfer 会带走整个底层缓冲，必须先复制成精确大小的独立缓冲。 */
function collectTransferEntries(files: ReadonlyMap<string, Uint8Array>, transfer: Transferable[]): GameFileEntry[] {
  return [...files].map(([path, bytes]) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    transfer.push(copy.buffer);
    return { path, bytes: copy };
  });
}

/** Worker 探测失败才回退主线程；探测在 VM 初始化前完成，不产生双 V86 实例。 */
export async function createVmShell(
  callbacks: GameVmCallbacks,
  source: GameSource,
  options: WorkerVmClientOptions = {},
): Promise<VmShell> {
  // 必须显式携带到 Worker：仅在页面包一层 overlay，HTTP 后端会丢失它。
  const additionalFiles = source.additionalFiles;
  const mainThreadSource = additionalFiles ? mountCustomMapFiles(source, additionalFiles) : source;
  const ra2Network = await resolveRa2NetworkConfig(source);
  // 在创建时只生成一次，Worker 初始化失败回退时也沿用同名；未来登录身份从选项传入。
  const playerName = validateMultiplayerName(options.playerName ?? randomMultiplayerName());
  // ?vm-worker=0 强制主线程模式：回退路径手测/对比基线用。
  if (
    typeof Worker === 'undefined' ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('vm-worker') === '0')
  ) {
    return new Win32GameVm(
      callbacks,
      await withMultiplayerNameOverride(
        await withGameResolutionOverride(mainThreadSource, options.resolution),
        playerName,
      ),
      ra2Network,
      options.startupPage,
    );
  }
  const handle = directoryHandleOf(source.files);
  const transfer: Transferable[] = [];
  let closeFilePort: (() => void) | undefined;
  let provider: VmInitConfig['provider'];
  if (sessionFilesOf(source.files)) {
    // 首次导入和缓存恢复统一按需读取，既不丢未解压文件，也不在 init 复制整包。
    // 服务整个已选 source（含作用域及覆盖层），Worker 因而使用游戏根相对路径。
    const names = (await source.files.list('')) ?? [];
    const channel = new MessageChannel();
    closeFilePort = serveFileProvider(source.files, channel.port1);
    provider = { kind: 'port', port: channel.port2, names, label: source.files.label };
    transfer.push(channel.port2);
  } else if (handle) {
    // 目录后端：叠加层按最内层→最外层压平（后层覆盖前层，与 Overlay 链一致）。
    const layers = collectDirectoryOverlays(source.files) ?? [];
    const flattened = new Map<string, Uint8Array>();
    for (const layer of layers) for (const [path, bytes] of layer) flattened.set(path, bytes);
    provider = flattened.size
      ? { kind: 'directory', handle, overlays: collectTransferEntries(flattened, transfer) }
      : { kind: 'directory', handle };
  } else {
    // 非会话、非授权目录来源维持开发 HTTP 后端。
    provider = { kind: 'http' };
  }
  const config: VmInitConfig = {
    provider,
    // 页面 manifest 闸门已选择/校验 EXE。所有后端都带同一份启动字节，避免
    // HTTP 丢 overlay、目录 parent-first 或重新发现时选回旧版；不改磁盘文件。
    selectedExecutable: collectTransferEntries(
      new Map([
        [
          [provider.kind === 'port' ? '' : directoryScopeOf(source.files), source.game.executable]
            .filter(Boolean)
            .join('/'),
          source.executableBytes,
        ],
      ]),
      transfer,
    )[0]!,
    preferredGameId: source.game.id,
    ...(additionalFiles?.size ? { additionalFiles: collectTransferEntries(additionalFiles, transfer) } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    playerName,
    startupPage: options.startupPage,
    ...(ra2Network ? { ra2Network } : {}),
    fastFileRead:
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fast-files') !== '0',
    clockRate: 1,
    masterVolume: DEFAULT_MASTER_VOLUME,
    traceCalls: typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1',
  };
  let closeRelayPort: (() => void) | undefined;
  if (ra2Network) {
    const channel = new MessageChannel();
    const stopRelay = serveRelayPort(channel.port1);
    closeRelayPort = () => {
      stopRelay();
      channel.port2.close();
    };
    config.relayPort = channel.port2;
    transfer.push(channel.port2);
  }
  let client: WorkerVmClient;
  try {
    client = new WorkerVmClient(callbacks, config, {
      ...options,
      initTransfer: transfer.length ? transfer : options.initTransfer,
      onTerminated: () => {
        closeFilePort?.();
        closeRelayPort?.();
        options.onTerminated?.();
      },
    });
  } catch (error) {
    closeFilePort?.();
    closeRelayPort?.();
    throw error;
  }
  try {
    await client.waitProbe();
    return client;
  } catch (error) {
    console.warn('[VM] worker 模式不可用，回退主线程模式：', error);
    await client.destroy();
    return new Win32GameVm(
      callbacks,
      await withMultiplayerNameOverride(
        await withGameResolutionOverride(mainThreadSource, options.resolution),
        playerName,
      ),
      ra2Network,
      options.startupPage,
    );
  }
}

/** 主线程模式：v86 + shim 直接在页面线程运行。 */
export class Win32GameVm implements VmShell {
  private readonly audio = new WebAudioPcmSink({
    onError: (error) => console.warn('[VM audio]', error),
  });
  private readonly core: VmCore;
  private removeAudioUnlock: (() => void) | null = null;
  private removePagehideFlush: (() => void) | null = null;
  private fileProvider: GameFileProvider;

  constructor(callbacks: GameVmCallbacks, source: GameSource, ra2Network?: Ra2NetworkConfig, startupPage?: string) {
    this.fileProvider = source.files;
    const platform: VmCorePlatform = {
      createEmulator: createBrowserEmulator,
      ...gameVmConfiguration(source.game, callbacks.onNetworkStatus, ra2Network),
      startupPage,
      fetchBytes,
      scheduleFrame: (emit) => {
        window.requestAnimationFrame(emit);
      },
      packedRgb565Frames: true,
      audio: this.audio,
      // 客体内高速 _lread 桩默认启用：?fast-files=0 可退回可观测的慢路径。
      fastFileRead:
        typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fast-files') !== '0',
    };
    this.core = new VmCore(callbacks, source, platform);
  }

  async start(): Promise<void> {
    // 音频上下文必须由用户手势解锁；卸载路径无法 await，pagehide 尽力 flush 存档写入。
    this.removeAudioUnlock = this.audio.installUserGestureUnlock(document);
    const flushOnPagehide = () => {
      void this.core.flushFiles();
    };
    window.addEventListener('pagehide', flushOnPagehide);
    this.removePagehideFlush = () => window.removeEventListener('pagehide', flushOnPagehide);
    try {
      await this.core.start();
    } catch (error) {
      this.removePagehideFlush?.();
      this.removePagehideFlush = null;
      this.removeAudioUnlock?.();
      this.removeAudioUnlock = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  flushFiles(): Promise<void> {
    return this.core.flushFiles();
  }

  async attachMapFiles(files: ReadonlyMap<string, Uint8Array>) {
    const { provider, result } = await prepareDynamicMaps(this.fileProvider, files);
    this.core.setFileProvider(provider);
    this.fileProvider = provider;
    return result;
  }

  postMessage(message: number, wParam = 0, lParam = 0): void {
    this.core.postMessage(message, wParam, lParam);
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.core.setKeyState(virtualKey, down);
  }

  setCursorPosition(x: number, y: number): void {
    this.core.setCursorPosition(x, y);
  }

  setGameClockRate(rate: number): number {
    return this.core.setGameClockRate(rate);
  }

  /** 主音量：所有客体音频汇合后的线性增益 0..1。 */
  setMasterVolume(linear: number): void {
    this.core.setMasterVolume(linear);
  }

  getGamePerformance(): Promise<GamePerformanceSample | null> {
    return this.core.getGamePerformance();
  }

  async getPointerState(): Promise<VmPointerState | null> {
    return this.core.getPointerState();
  }

  async setGameSpeedFlag(value: number): Promise<number | null> {
    return this.core.setGameSpeedFlag(value);
  }

  async startMemRecord(): Promise<boolean> {
    return this.core.startMemRecord();
  }

  async stopMemRecord(): Promise<GuestMemRecordResult | null> {
    return this.core.stopMemRecord();
  }

  setCallTracing(_enabled: boolean): void {
    // 主线程路径的 onCall 已在页面按 panelCreated 门控，无跨线程成本。
  }

  async destroy(): Promise<void> {
    this.removeAudioUnlock?.();
    this.removeAudioUnlock = null;
    this.removePagehideFlush?.();
    this.removePagehideFlush = null;
    await this.core.destroy();
  }
}
