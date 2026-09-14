import { GamePerformanceMeter, type GameFrameReader, type GamePerformanceSample } from './gamePerformance';
import { V86 } from 'v86';
import { RangePrefetch } from './rangePrefetch';
import { readGuestFileSearch } from './fileSearch';
import v86WasmUrl from 'v86/build/v86.wasm?url';
import bootUrl from '../vm86/boot.bin?url';
import {
  HYPERCALL_EAX,
  HYPERCALL_EDX,
  HYPERCALL_ENTRY,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_HALTED,
  HYPERCALL_EXCEPTION,
  HYPERCALL_EXCEPTION_EAX,
  HYPERCALL_EXCEPTION_EBP,
  HYPERCALL_EXCEPTION_EBX,
  HYPERCALL_EXCEPTION_CS,
  HYPERCALL_EXCEPTION_ECX,
  HYPERCALL_EXCEPTION_EDI,
  HYPERCALL_EXCEPTION_EIP,
  HYPERCALL_EXCEPTION_EDX,
  HYPERCALL_EXCEPTION_ERROR,
  HYPERCALL_EXCEPTION_ESP,
  HYPERCALL_EXCEPTION_EFLAGS,
  HYPERCALL_EXCEPTION_ESI,
  HYPERCALL_REQUEST,
  HYPERCALL_STACK,
  HYPERCALL_STACK_TOP,
  loadPe,
  makeConstantImportStub,
  type PeImage,
  type PeImport,
} from '../vm86/pe';
import {
  annotateWin32Modules,
  decodeGuestNarrow,
  readStackArgs,
  makeWin32ImportStub,
  makeWin32ImportStubWithFastRead,
  type Win32Call,
  type Win32AudioSink,
} from '../vm86/win32';
import { normalizeGuestPath } from '../vm86/paths';
import type { Win32ShimBase } from '../vm86/win32';
import type { GuestMemRecordResult } from './memRecord';
import { accumulateChangedWords, diffMemory } from '../utils/memoryDiff';
import { normalizeGameClockRate } from '../vm86/clock';
import type { GameFileProvider, ResourcePolicy } from '../resources/contracts';
import type { GameSource } from '../games/source';
import type { VmPointerState } from './vmShell';
import type { GameVmCallbacks, VmStatus } from '../app/session/runtimeEvents';

const DEFAULT_GUEST_MEMORY_SIZE = 128 * 1024 * 1024;
/** 录制期间采样间隔：v86 无逐写钩子，修改次数按采样窗口近似（每窗 +1）。 */
const MEM_RECORD_SAMPLE_MS = 500;
/** 计数地址上限：堆/栈高频改动区域防撑爆计数表，超限只累加已有地址。 */
const MEM_RECORD_MAX_ADDRESSES = 100_000;
/** 回传主线程的地址统计条数上限（UI 只显示前 200 条）。 */
const MEM_RECORD_MAX_REPORT = 10_000;
/** 堆 arena 顶与客体总内存之间留 2MB 余量（与历史上 0x7e00000/128MB 的布局一致）。 */
const GUEST_MEMORY_MARGIN = 2 * 1024 * 1024;
// RA2 映像止于 0xb46000；staging 必须覆盖最高映像地址而非只按文件大小估算。
const STAGING_SIZE = 16 * 1024 * 1024;
const STUB_BASE = 0x0008_0000;
// 多线程 import 桩包含寄存器/SEH/TLS 上下文切换；RA2 的 369 个导入已超过
// 原 64KiB 区间。0x80000..0xc0000 留给静态桩，仍远低于 0x400000 PE 映像。
const STUB_LIMIT = 0x000c_0000;
/** 连续处理少量 hypercall 后让一次宿主宏任务运行，保证输入/网络事件不会被微任务链饿死。 */
const HYPERCALLS_PER_HOST_YIELD = 128;
/** 按调用数让出不等于按时间让出：复杂客体帧会把 128 次拉长到几十毫秒。 */
const HOST_SLICE_MS = 4;

/** Win32 音频输出加宿主的主音量、全停与销毁能力。 */
export interface VmAudioSink extends Win32AudioSink {
  setMasterVolume(linear: number): void;
  stopAll(): void;
  destroy(): Promise<void>;
}

/** 平台差异收敛点：主线程与 worker 各自的宿主设施从这里注入，VmCore 不含任何 DOM/window 引用。 */
export interface VmCorePlatform {
  /** 游戏资源策略在组装层注入；核心不按扩展名、游戏名称或 URL 猜测。 */
  resourcePolicy: ResourcePolicy<GameSource>;
  startupPage?: string;
  /** 固件 boot.bin 的字节获取（主线程与 worker 的 fetch 语义一致）。 */
  fetchBytes(url: string): Promise<Uint8Array>;
  /** 帧发射时机：主线程 rAF 合并、worker 直接发射（postMessage 天然异步）。 */
  scheduleFrame(emit: () => void): void;
  /** Worker mailbox 满时延后取快照；默认 false 保持主线程的呈现边界语义。 */
  deferFrameSnapshot?: boolean;
  packedRgb565Frames?: boolean;
  takeFrameBuffer?: (size: number) => ArrayBuffer;
  audio: VmAudioSink;
  /** 客体内高速 _lread 桩开关（?fast-files=0 退回逐次 hypercall 慢路径）。 */
  fastFileRead: boolean;
  /** 宿主注入 emulator 构造与调度；shim 始终由外层组装。 */
  createEmulator?: (options: ConstructorParameters<typeof V86>[0]) => V86;
  createShim: (emulator: V86, options: ConstructorParameters<typeof Win32ShimBase>[1]) => Win32ShimBase;
}

/** 平台无关的 VM 驱动：v86 + PE 装载 + Win32 shim + hypercall 轮询 + 帧转发。
 *  主线程模式（Win32GameVm）与 worker 模式（vmWorker.ts）共用此核心。 */
export class VmCore {
  private readonly rangePrefetch = new RangePrefetch();
  private emulator: V86 | null = null;
  private image: PeImage | null = null;
  private shim: Win32ShimBase | null = null;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private handling = false;
  private calls = 0;
  private readonly recentCalls: string[] = [];
  private lastCallStack: { key: string; stack: number; returnAddress: number } | null = null;
  private readonly pendingFileWrites = new Set<Promise<void>>();
  private pendingFileWriteError: Error | null = null;
  private gameClockRate = 1;
  private frameReader: Promise<GameFrameReader | null> | null = null;
  private readonly gamePerformance = new GamePerformanceMeter();
  private guestMemoryBytes = DEFAULT_GUEST_MEMORY_SIZE;
  private memRecordBase: Uint8Array | null = null;
  private memRecordPrev: Uint8Array | null = null;
  private memRecordCounts = new Map<number, number>();
  private memRecordSamples = 0;
  private memRecordTruncated = false;
  private memRecordTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  /** MessageChannel 是无最小延迟的宿主任务边界；没有它时才退回 setTimeout(0)。 */
  private readonly hostYieldChannel: MessageChannel | null =
    typeof globalThis.MessageChannel === 'function' ? new globalThis.MessageChannel() : null;
  private hostYieldPending = false;
  private nextHostYieldAt = performance.now() + HOST_SLICE_MS;
  // v86 正在 WASM I/O 回调栈上时不能重入 read_memory，放到紧随当前 CPU slice 的微任务。
  // v86 的 serial 回调不能直接重入 read_memory，正常路径放到微任务；但不能让
  // serial → microtask → serial 无限链独占 worker，否则鼠标、WebSocket、stop 等
  // 外部消息会一直排在后面，表现为人物卡住不动。
  private readonly hypercallListener = () => {
    if (this.calls > 0 && (this.calls % HYPERCALLS_PER_HOST_YIELD === 0 || performance.now() >= this.nextHostYieldAt)) {
      this.yieldToHost();
    } else {
      queueMicrotask(() => void this.poll());
    }
  };
  private lastShellPageTitle = '';

  constructor(
    private readonly callbacks: GameVmCallbacks,
    private source: GameSource,
    private readonly platform: VmCorePlatform,
  ) {
    this.hostYieldChannel?.port1.addEventListener('message', () => {
      this.hostYieldPending = false;
      this.nextHostYieldAt = performance.now() + HOST_SLICE_MS;
      void this.poll();
    });
    this.hostYieldChannel?.port1.start();
  }

  /** 替换文件层 provider（worker 挂载附加地图时）；其余 source 字段不变。 */
  setFileProvider(files: GameFileProvider): void {
    this.missingStaticGuestFiles.clear();
    this.source = { ...this.source, files };
  }

  async start(): Promise<void> {
    if (this.emulator) throw new Error('VM 已创建');
    this.hasPresentedFrame = false;
    try {
      this.source = await this.platform.resourcePolicy.prepareSource(this.source);
      const { game, files: gameFiles, executableBytes: exe } = this.source;
      const guestMemoryBytes = game.guestMemoryBytes ?? DEFAULT_GUEST_MEMORY_SIZE;
      this.guestMemoryBytes = guestMemoryBytes;
      this.status('loading', `读取原版 ${game.executable} 和 VM 固件…`);
      const preloadSpecs = game.preloadFiles ?? [];
      const [bios, ...preloadBytes] = await Promise.all([
        this.platform.fetchBytes(bootUrl),
        ...preloadSpecs.map((file) => {
          this.status('loading', `正在读取 ${file.path}…`);
          return gameFiles.read(file.path);
        }),
      ]);
      await Promise.all(
        preloadSpecs.map(async (file, index) => {
          if (preloadBytes[index] !== null) return;
          const fallbackUrl = this.platform.resourcePolicy.preloadFallbackUrl(file.path);
          if (fallbackUrl) preloadBytes[index] = await this.platform.fetchBytes(fallbackUrl);
        }),
      );
      const preloadedFiles = new Map<string, Uint8Array>();
      preloadSpecs.forEach((file, index) => {
        const bytes = preloadBytes[index];
        if (bytes) preloadedFiles.set(file.path, bytes);
      });
      const staging = new Uint8Array(STAGING_SIZE);
      let stubNext = STUB_BASE;
      const defaultImportStub = this.platform.fastFileRead ? makeWin32ImportStubWithFastRead : makeWin32ImportStub;
      const importStub = (dll: string, name: string, id: number, argBytes: number): Uint8Array =>
        game.shimProfile.skipGuestOleSaveToStream && `${dll.toUpperCase()}!${name}` === 'OLE32.DLL!OleSaveToStream'
          ? makeConstantImportStub(0, argBytes)
          : defaultImportStub(dll, name, id, argBytes);
      const image = loadPe(
        staging,
        exe,
        (bytes) => {
          const address = stubNext;
          stubNext = (stubNext + bytes + 15) & ~15;
          if (stubNext > STUB_LIMIT) throw new Error('import stub 区不足');
          return address;
        },
        game.argBytes,
        importStub,
      );
      annotateWin32Modules(image.importList);
      this.image = image;
      this.status('loading', `PE 已解析：入口 0x${image.entry.toString(16)}，${image.importList.length} 个 Win32 导入`);

      const emulator = (this.platform.createEmulator ?? ((options) => new V86(options)))({
        wasm_path: v86WasmUrl,
        memory_size: guestMemoryBytes,
        bios: { buffer: exactBuffer(bios) },
        autostart: false,
        // UART IRQ 握手会在 host 释放前挂起客体；JIT 已通过长时战场调用压测。
        disable_jit: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
      });
      this.emulator = emulator;
      await onceReady(emulator);
      emulator.add_listener('serial0-output-byte', this.hypercallListener);

      // 只写实际用到的两段，不把整个 64MB 空镜像复制进 WASM。
      emulator.write_memory(staging.subarray(HYPERCALL_STACK, stubNext), HYPERCALL_STACK);
      emulator.write_memory(staging.subarray(image.imageBase, image.imageBase + image.sizeOfImage), image.imageBase);
      game.runtimeHooks?.prepareImage?.(emulator);
      if (this.platform.startupPage) {
        const prepare = game.runtimeHooks?.prepareStartupPage;
        if (!prepare) throw new Error(`${game.id} 尚不支持启动页面直达`);
        const { sha256Hex } = await import('../utils/sha256');
        prepare(emulator, this.platform.startupPage, await sha256Hex(exe), (size) => {
          const address = stubNext;
          if (!Number.isInteger(size) || size <= 0 || address + size > STUB_LIMIT) throw new Error('启动导航桩区不足');
          stubNext = (address + size + 15) & ~15;
          return address;
        });
      }
      this.writeU32(HYPERCALL_ENTRY, image.entry);
      this.writeU32(HYPERCALL_CALLBACK_DEPTH, 0);
      this.writeU32(HYPERCALL_STACK_TOP, game.stackTop ?? 0x0070_0000);
      this.shim = this.platform.createShim(emulator, {
        firstDynamicId: image.importList.length + 1,
        staticImports: image.importList,
        enableFastFileMirror: this.platform.fastFileRead,
        virtualTop: game.arenaTop ?? guestMemoryBytes - GUEST_MEMORY_MARGIN,
        virtualBase: game.heapBase,
        heapTop: game.arenaTop ?? guestMemoryBytes - GUEST_MEMORY_MARGIN,
        heapBase: game.heapBase ?? game.stackTop,
        importArgBytes: game.argBytes,
        dynamicImportStub: importStub,
        // 显式镜像区按配置边界取值；未配置时按客体内存的一半兜底。
        fastFileMirrorLimit:
          game.fastFileMirrorBase !== undefined && game.fastFileMirrorTop !== undefined
            ? Math.max(0, Math.min(game.fastFileMirrorTop, guestMemoryBytes) - game.fastFileMirrorBase)
            : game.guestMemoryBytes
              ? Math.floor(game.guestMemoryBytes / 2)
              : undefined,
        fastFileMirrorBase: game.fastFileMirrorBase,
        // 配置来自游戏 profile，但绝不能越过本次实际创建的 v86 RAM；
        // 否则大 MIX 镜像会在 write_memory 中触发 WASM unreachable。
        fastFileMirrorTop:
          game.fastFileMirrorTop === undefined ? undefined : Math.min(game.fastFileMirrorTop, guestMemoryBytes),
        fastFileMirrorFiles: game.fastFileMirrorFiles,
        onFrame: (frame) => {
          this.hasPresentedFrame = true;
          this.callbacks.onFrame?.(frame);
        },
        onLogicFrame: () => this.callbacks.onLogicFrame?.(1),
        scheduleFrame: this.platform.scheduleFrame,
        deferFrameSnapshot: this.platform.deferFrameSnapshot,
        packedRgb565Frames: this.platform.packedRgb565Frames,
        takeFrameBuffer: this.platform.takeFrameBuffer,
        gameProfile: game.shimProfile,
        files: preloadedFiles,
        audio: this.platform.audio,
        moduleName: game.executable,
        // Worker 与主线程回退共用这里；只开放原版战役速度控制，不修改速度/时钟。
        commandLineArguments: game.commandLineArguments,
        onFileWrite: (path, bytes) => this.queueFileWrite(path, bytes),
        driveTypes: game.driveTypes,
      });
      let linkedEntry = image.entry;
      for (const file of preloadSpecs) {
        if (!preloadedFiles.has(file.path)) continue;
        if (file.linkBeforeEntry) {
          linkedEntry = this.shim.linkGuestDllBeforeEntry(file.path, linkedEntry, image.importList);
        } else if (file.initializeBeforeEntry) {
          linkedEntry = this.shim.initializeGuestDllBeforeEntry(file.path, linkedEntry);
        }
      }
      if (linkedEntry !== image.entry) this.writeU32(HYPERCALL_ENTRY, linkedEntry);
      this.shim.setGameClockRate(this.gameClockRate);
      this.status('ready', `游戏内存已就绪：${game.title}，目录：${gameFiles.label}`);

      // 端口事件是主通道；50ms 轮询只用于 CPU 异常和极端情况下的兜底。
      this.pollTimer = globalThis.setInterval(() => void this.poll(), 50);
      await emulator.run();
      this.status('running', `${game.executable} 正在 v86 中执行（入口 0x${image.entry.toString(16)}）`);
    } catch (error) {
      this.status('error', error instanceof Error ? error.message : String(error));
      await this.destroy();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.gamePerformance.reset();
    this.clearPoll();
    if (this.emulator?.is_running()) await this.emulator.stop();
    this.platform.audio.stopAll();
    this.status('stopped', 'VM 已停止');
  }

  postMessage(message: number, wParam = 0, lParam = 0): void {
    if (!this.emulator || !this.shim) return;
    this.source.game.runtimeHooks?.beforeHostMessage?.(this.emulator, message);
    this.shim.postMessage(message, wParam, lParam);
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.shim?.setKeyState(virtualKey, down);
  }

  setCursorPosition(x: number, y: number): void {
    this.shim?.setCursorPosition(x, y);
  }

  setGameClockRate(rate: number): number {
    this.gameClockRate = normalizeGameClockRate(rate);
    this.shim?.setGameClockRate(this.gameClockRate);
    return this.gameClockRate;
  }

  /** 主音量：所有客体音频汇合后的线性增益 0..1。 */
  setMasterVolume(linear: number): void {
    this.platform.audio.setMasterVolume(linear);
  }

  /** 与游戏无关的 shim 最终指针状态，用于验证 Worker 侧实际钳制边界。 */
  getPointerState(): VmPointerState | null {
    return this.shim?.inspectPointerState() ?? null;
  }

  async getGamePerformance(): Promise<GamePerformanceSample | null> {
    const emulator = this.emulator;
    const create = this.source.game.runtimeHooks?.createFrameReader;
    if (!emulator || !this.image || !create || this.currentPhase === 'loading') return null;
    // 首次显式采样才校验 EXE，不为普通运行增加逐帧 Hook 或定时器。
    this.frameReader ??= import('../utils/sha256').then(async ({ sha256Hex }) => {
      const hash = await sha256Hex(this.source.executableBytes);
      return this.emulator === emulator ? create(emulator, hash) : null;
    });
    const reader = await this.frameReader;
    if (this.emulator !== emulator) return null;
    const counters = reader?.();
    if (!counters) {
      this.gamePerformance.reset();
      return null;
    }
    return this.gamePerformance.sample(
      counters,
      performance.now(),
      this.currentPhase === 'running' && this.shim?.inspectShellPageTitle() === '',
    );
  }

  /** 写入当前游戏显式提供的速度状态；未提供时返回 null。 */
  setGameSpeedFlag(value: number): number | null {
    const hooks = this.source.game.runtimeHooks;
    if (!this.emulator || !hooks?.writeGameSpeedFlag) return null;
    return hooks.writeGameSpeedFlag(this.emulator, value);
  }

  /** 内存改动录制：快照当前客体 RAM 为基线，并启动周期性采样计数。 */
  startMemRecord(): boolean {
    if (!this.emulator) return false;
    // 重复开始 = 重新录制：先停掉旧采样器。
    if (this.memRecordTimer !== null) {
      globalThis.clearInterval(this.memRecordTimer);
      this.memRecordTimer = null;
    }
    // read_memory 返回客体内存的视图而非拷贝：快照必须立即复制，
    // 否则视图内容随游戏运行同步变化，结束时 diff 恒为空。
    const snapshot = this.emulator.read_memory(0, this.guestMemoryBytes).slice();
    this.memRecordBase = snapshot;
    this.memRecordPrev = snapshot;
    this.memRecordCounts.clear();
    this.memRecordSamples = 0;
    this.memRecordTruncated = false;
    this.memRecordTimer = globalThis.setInterval(() => this.sampleMemRecord(), MEM_RECORD_SAMPLE_MS);
    return true;
  }

  /** 结束录制：最后一次采样 + 与起始基线 diff，释放全部录制状态；未在录制中返回 null。 */
  stopMemRecord(): GuestMemRecordResult | null {
    if (!this.emulator || !this.memRecordBase || !this.memRecordPrev) return null;
    if (this.memRecordTimer !== null) {
      globalThis.clearInterval(this.memRecordTimer);
      this.memRecordTimer = null;
    }
    const current = this.emulator.read_memory(0, this.guestMemoryBytes).slice();
    this.sampleMemRecordAgainst(current);
    this.memRecordSamples++;
    const diff = diffMemory(this.memRecordBase, current);
    const counts = [...this.memRecordCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, MEM_RECORD_MAX_REPORT)
      .map(([address, count]) => ({ address, count }));
    const result: GuestMemRecordResult = {
      totalBytes: diff.totalBytes,
      rangeCount: diff.ranges.length,
      samples: this.memRecordSamples,
      truncated: this.memRecordTruncated,
      counts,
    };
    this.memRecordBase = null;
    this.memRecordPrev = null;
    this.memRecordCounts.clear();
    return result;
  }

  /** 周期性采样：与前一次快照 diff，被改动字的计数 +1（v86 无逐写钩子，次数按采样近似）。 */
  private sampleMemRecord(): void {
    if (!this.emulator || !this.memRecordPrev) return;
    this.sampleMemRecordAgainst(this.emulator.read_memory(0, this.guestMemoryBytes).slice());
    this.memRecordSamples++;
  }

  private sampleMemRecordAgainst(current: Uint8Array): void {
    if (!this.memRecordPrev) return;
    if (accumulateChangedWords(this.memRecordPrev, current, this.memRecordCounts, MEM_RECORD_MAX_ADDRESSES)) {
      this.memRecordTruncated = true;
    }
    this.memRecordPrev = current;
  }

  /** 卸载路径无法 await 时的尽力提交：pagehide 与 worker flush 消息共用。 */
  async flushFiles(): Promise<void> {
    await Promise.allSettled([...this.pendingFileWrites]);
    const writeError = this.pendingFileWriteError;
    this.pendingFileWriteError = null;
    let flushError: unknown = null;
    try {
      await this.source.files.flush();
    } catch (error) {
      flushError = error;
    }
    if (writeError) throw writeError;
    if (flushError) throw flushError instanceof Error ? flushError : new Error(String(flushError));
  }

  async destroy(): Promise<void> {
    this.rangePrefetch.clear();
    this.clearPoll();
    this.hostYieldPending = false;
    this.hostYieldChannel?.port1.close();
    this.hostYieldChannel?.port2.close();
    const emulator = this.emulator;
    const shim = this.shim;
    this.emulator = null;
    this.frameReader = null;
    this.gamePerformance.reset();
    this.shim = null;
    this.image = null;
    if (this.memRecordTimer !== null) {
      globalThis.clearInterval(this.memRecordTimer);
      this.memRecordTimer = null;
    }
    this.memRecordBase = null;
    this.memRecordPrev = null;
    this.memRecordCounts.clear();
    shim?.dispose();
    if (emulator) {
      emulator.remove_listener('serial0-output-byte', this.hypercallListener);
      await emulator.destroy();
    }
    await Promise.allSettled([...this.pendingFileWrites]);
    await this.source.files.flush();
    await this.platform.audio.destroy();
  }

  private async poll(): Promise<void> {
    if (this.handling || !this.emulator || !this.image || !this.shim) return;
    const exception = this.readU32(HYPERCALL_EXCEPTION);
    if (exception !== 0) {
      this.clearPoll();
      if (this.emulator.is_running()) await this.emulator.stop();
      const vector = exception - 1;
      const eip = this.readU32(HYPERCALL_EXCEPTION_EIP);
      const error = this.readU32(HYPERCALL_EXCEPTION_ERROR);
      const cs = this.readU32(HYPERCALL_EXCEPTION_CS);
      const esp = this.readU32(HYPERCALL_EXCEPTION_ESP);
      const eflags = this.readU32(HYPERCALL_EXCEPTION_EFLAGS);
      const registers = [
        ['EAX', HYPERCALL_EXCEPTION_EAX],
        ['ECX', HYPERCALL_EXCEPTION_ECX],
        ['EDX', HYPERCALL_EXCEPTION_EDX],
        ['EBX', HYPERCALL_EXCEPTION_EBX],
        ['EBP', HYPERCALL_EXCEPTION_EBP],
        ['ESI', HYPERCALL_EXCEPTION_ESI],
        ['EDI', HYPERCALL_EXCEPTION_EDI],
      ]
        .map(([name, address]) => `${name}=0x${this.readU32(address as number).toString(16)}`)
        .join(' ');
      const stack = [...this.emulator.read_memory(esp, 32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const runtimeHooks = this.source.game.runtimeHooks;
      const heap = this.shim.inspectHeapState();
      const callback = this.shim.inspectCallbackState();
      const knownHint =
        runtimeHooks?.crashHint?.(vector, eip) ||
        (vector === 0 ? '；除零异常：游戏内除法以 0 为除数，通常伴随数据文件缺失或读取失败' : '');
      this.status(
        'error',
        `CPU 异常 #${vector}：CS:EIP=0x${cs.toString(16)}:0x${eip.toString(16)} ` +
          `ESP=0x${esp.toString(16)} EFLAGS=0x${eflags.toString(16)} error=0x${error.toString(16)}；` +
          `${registers} stack=${stack}；` +
          `堆=live:${heap.liveBytes}/free:${heap.freeBytes}/next:0x${heap.nextAddress.toString(16)}/` +
          `虚拟区:${heap.virtualRegions}×${heap.virtualBytes}/已释放:${heap.virtualFreeBytes}；` +
          `回调=${
            callback
              ? `hwnd=0x${callback.hwnd.toString(16)},msg=0x${callback.message.toString(16)},` +
                `proc=0x${callback.callback.toString(16)},stack=0x${callback.callStack.toString(16)},` +
                `ret=0x${callback.originalReturn.toString(16)},tramp=0x${callback.trampoline.toString(16)},depth=${callback.depth}`
              : '无'
          }；` +
          `最近栈=${
            this.lastCallStack
              ? `${this.lastCallStack.key}@0x${this.lastCallStack.stack.toString(16)}` +
                `→0x${this.lastCallStack.returnAddress.toString(16)}`
              : '无'
          }；` +
          `最近调用：${this.recentCalls.join(' → ') || '无'}；` +
          `打开失败=${this.shim.failedOpens.length ? this.shim.failedOpens.slice(-8).join(' → ') : '无'}${knownHint}`,
      );
      return;
    }
    // 固件停机标记：PE 入口直接返回（未走 ExitProcess 的退出路径）时按退出处理，
    // 否则页面会毫无反应地停在 FPS 0。
    if (this.readU32(HYPERCALL_HALTED) === 1) {
      this.clearPoll();
      if (this.emulator.is_running()) await this.emulator.stop();
      this.status('exited', `${this.source.game.executable} 已返回（固件停机，未走 ExitProcess）`);
      return;
    }
    const id = this.readU32(HYPERCALL_REQUEST);
    if (id === 0) return;
    this.handling = true;
    try {
      const imported: PeImport | undefined = this.image.importList[id - 1] ?? this.shim.resolveDynamicImport(id);
      if (!imported || imported.id !== id) throw new Error(`非法 hypercall id: ${id}`);
      const stack = this.readU32(HYPERCALL_STACK);
      const call: Win32Call = {
        imported,
        stack,
        args: readStackArgs(this.emulator, stack, imported.argBytes),
      };
      this.lastCallStack = { key: imported.key, stack, returnAddress: this.readU32(stack) };
      this.calls++;
      this.recentCalls.push(imported.key);
      if (this.recentCalls.length > 16) this.recentCalls.shift();
      this.callbacks.onCall?.(call, this.calls);

      // Win32 API 是同步的；host 可以在 hypercall 桩等待时完成浏览器的异步 fetch。
      if (imported.key === 'KERNEL32.DLL!FindFirstFileA' && call.args[0] && call.args[1]) {
        const pattern = this.readCString(call.args[0]);
        this.shim.setFileSearchResults(pattern, await readGuestFileSearch(this.source.files, pattern));
      }
      if (
        (imported.key === 'KERNEL32.DLL!CreateFileA' ||
          imported.key === 'KERNEL32.DLL!_lopen' ||
          imported.key === 'WINMM.DLL!mmioOpenA' ||
          imported.key === 'KERNEL32.DLL!LoadLibraryA') &&
        call.args[0]
      ) {
        const sync = this.syncGuestFile(call.args[0]);
        if (sync) await sync;
      }

      // MOVIES*.MIX 只常驻索引前缀。原版 seek 到其中某段 BIK 后，在同步
      // ReadFile 边界按 2MiB 页补取真实字节；不下载/复制整个 300+MiB 影片包。
      if (
        (imported.key === 'KERNEL32.DLL!ReadFile' || imported.key === 'KERNEL32.DLL!_lread') &&
        call.args[0] &&
        call.args[2]
      ) {
        const range = this.shim.inspectFileReadRequest(call.args[0], call.args[2]);
        if (range && this.source.files.readRange) {
          const bytes = await this.rangePrefetch.read(
            this.source.files,
            range.path,
            range.offset,
            range.length,
            range.totalSize,
          );
          if (bytes) this.shim.mountFileRange(range.path, range.offset, bytes);
        }
      }

      const result = this.shim.dispatch(call);
      const shellPageTitle = this.shim.inspectShellPageTitle();
      if (shellPageTitle !== this.lastShellPageTitle) {
        this.lastShellPageTitle = shellPageTitle;
        this.callbacks.onShellPage?.(shellPageTitle);
      }
      if (!result) {
        this.clearPoll();
        if (this.emulator.is_running()) await this.emulator.stop();
        const detail = this.shim.unimplementedDetail;
        this.shim.unimplementedDetail = null;
        this.status('blocked', `Win32 接口待实现：${imported.key}${detail ? `（${detail}）` : ''}`);
        this.callbacks.onBlocked?.(call);
        return;
      }

      let threadDelay = this.shim.prepareGuestThreadReturn(call, result);
      while (threadDelay) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, threadDelay));
        const completion = this.shim.completeGuestThreadDelay();
        if (completion.result !== undefined) result.eax = completion.result;
        threadDelay = completion.delayMs;
      }

      // 先写返回寄存器，最后清 request；清零就是客体继续执行的 release 信号。
      this.writeU32(HYPERCALL_EAX, result.eax);
      this.writeU32(HYPERCALL_EDX, result.edx ?? 0);
      this.writeU32(HYPERCALL_REQUEST, 0);
      this.emulator.serial0_send('\0');

      if (result.exit) {
        this.clearPoll();
        if (this.emulator.is_running()) await this.emulator.stop();
        this.status('exited', `${this.source.game.executable} 已退出，code=${result.eax | 0}`);
      }
    } catch (error) {
      this.clearPoll();
      if (this.emulator?.is_running()) await this.emulator.stop();
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = this.shim
        ? `；最近栈=${
            this.lastCallStack
              ? `${this.lastCallStack.key}@0x${this.lastCallStack.stack.toString(16)}→0x${this.lastCallStack.returnAddress.toString(16)}`
              : '无'
          }；最近调用：${this.recentCalls.join(' → ') || '无'}；` +
          `打开失败=${this.shim.failedOpens.length ? this.shim.failedOpens.slice(-8).join(' → ') : '无'}` +
          (error instanceof Error && error.stack
            ? `；宿主栈=${error.stack
                .split('\n')
                .slice(1, 21)
                .map((line) => line.trim())
                .join(' ← ')}`
            : '')
        : '';
      this.status('error', `${message}${diagnostic}`);
    } finally {
      this.handling = false;
    }
  }

  private yieldToHost(): void {
    if (this.hostYieldPending) return;
    this.hostYieldPending = true;
    if (this.hostYieldChannel) {
      this.hostYieldChannel.port2.postMessage(0);
    } else {
      globalThis.setTimeout(() => {
        this.hostYieldPending = false;
        this.nextHostYieldAt = performance.now() + HOST_SLICE_MS;
        void this.poll();
      }, 0);
    }
  }

  private readU32(address: number): number {
    const b = this.emulator!.read_memory(address, 4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  private writeU32(address: number, value: number): void {
    this.emulator!.write_memory(
      [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff],
      address,
    );
  }

  /** 本会话确认不存在的静态资源；避免 RA2 对 MIX 内文件的数千次松散文件探测
   * 每次都跨 File System Access/HTTP provider。写入同名文件时会立即失效。 */
  private readonly missingStaticGuestFiles = new Set<string>();

  /** 客体打开文件前，把 provider 的当前内容同步进 Win32 文件层。
   *  每次打开都重读：真实 Win9x 上磁盘文件被外部替换（例如在 Windows 端玩了同一
   *  份存档）后，下一次打开必然读到新内容。之前按「打开过就不再读」缓存，
   *  页面会话内换入的 Windows 存档永远读不到旧快照之外的内容——读档状态错乱。 */
  private syncGuestFile(pathPtr: number): Promise<void> | null {
    const guestPath = this.readCString(pathPtr);
    const normalized = normalizeGuestPath(guestPath);
    if (!normalized) return null;
    const sessionStatic = this.platform.resourcePolicy.isSessionStatic(normalized);
    if (sessionStatic && (this.missingStaticGuestFiles.has(normalized) || this.shim!.hasMountedFile(normalized)))
      return null;
    // discover 阶段已经取得 HTTP 游戏目录清单；若清单和 IndexedDB 索引都
    // 确认不存在，同步结束本次 loose-name 探测，不为每个 MIX 内素材 await。
    if (sessionStatic && this.source.files.hasKnownFile?.(guestPath) === false) {
      this.missingStaticGuestFiles.add(normalized);
      return null;
    }
    const sparsePrefix = Object.entries(this.source.game.sparseFilePrefixes ?? {}).find(([path]) => {
      const candidate = normalizeGuestPath(path);
      return normalized === candidate || normalized.endsWith(`/${candidate}`);
    })?.[1];
    return (async () => {
      const provider = this.source.files;
      if (!this.hasPresentedFrame && ['loading', 'ready', 'running'].includes(this.currentPhase)) {
        this.status(this.currentPhase, `正在读取 ${guestPath}…`);
      }
      const sparse = sparsePrefix ? await provider.readPrefix?.(guestPath, sparsePrefix) : null;
      const bytes = sparse?.bytes ?? (await provider.read(guestPath));
      // 静态资源不存在也缓存；RA2 会先把 MIX 内每个素材名当松散文件探测。
      if (!bytes) {
        // 热挂载可能发生在异步读取期间，旧 provider 的 miss 不能重新污染新缓存。
        if (sessionStatic && provider === this.source.files) this.missingStaticGuestFiles.add(normalized);
        return;
      }
      this.missingStaticGuestFiles.delete(normalized);
      // provider.read returns a fresh buffer. Transfer its ownership into the
      // synchronous file layer so a 282MiB MIX is not cloned once more before it
      // is copied into the guest fast-read mirror.
      this.shim!.mountFile(guestPath, bytes, true, sparse?.totalSize ?? bytes.length);
      if (sparse && sparse.totalSize > sparse.bytes.length && this.source.files.readRange) {
        this.shim!.markFileRangeBacked(guestPath);
      }
    })();
  }

  private queueFileWrite(path: string, bytes: Uint8Array): void {
    this.rangePrefetch.clear();
    this.missingStaticGuestFiles.delete(normalizeGuestPath(path));
    let write: Promise<void>;
    try {
      write = this.source.files.write(path, bytes);
    } catch (error) {
      write = Promise.reject(error);
    }
    this.pendingFileWrites.add(write);
    void write
      .catch((error) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        this.pendingFileWriteError ??= reason;
        this.status('error', `写入游戏目录失败：${path}；${reason.message}`);
      })
      .finally(() => this.pendingFileWrites.delete(write));
  }

  private readCString(address: number, max = 1024): string {
    const bytes = this.emulator!.read_memory(address, max);
    const nul = bytes.indexOf(0);
    const end = nul < 0 ? bytes.length : nul;
    return decodeGuestNarrow(bytes.subarray(0, end));
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) globalThis.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private currentPhase: VmStatus['phase'] = 'loading';
  private hasPresentedFrame = false;

  private status(phase: VmStatus['phase'], detail: string): void {
    this.currentPhase = phase;
    this.callbacks.onStatus?.({ phase, detail });
  }
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function onceReady(emulator: V86): Promise<void> {
  return new Promise((resolve) => emulator.add_listener('emulator-ready', resolve));
}
