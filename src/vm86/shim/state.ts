import type {
  GuestMemory,
  MciWindowState,
  MessageState,
  MmioState,
  MultimediaTimerState,
  PeImport,
  TimerState,
  VmCallbackState,
  VmHeapState,
  Win32Call,
  Win32Result,
  Win32ShimOptions,
} from '../win32';
import {
  GUEST_CALLBACK_BASE,
  GUEST_CALLBACK_STRIDE,
  GUEST_CALLBACK_SLOTS,
  GUEST_CALLBACK_OWNERS,
  HYPERCALL_CALLBACK_DEPTH,
  GUEST_THREAD_FPU_CONTEXTS,
  GUEST_THREAD_FPU_CONTEXT_BYTES,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_LIMIT,
  GUEST_THREAD_RUN_STATES,
  GUEST_WINDOW_ENTRY_BYTES,
  GUEST_WINDOW_EXSTYLE,
  GUEST_WINDOW_EXTRA0,
  GUEST_WINDOW_EXTRA12,
  GUEST_WINDOW_EXTRA4,
  GUEST_WINDOW_EXTRA8,
  GUEST_WINDOW_HEIGHT,
  GUEST_WINDOW_ID,
  GUEST_WINDOW_PARENT,
  GUEST_WINDOW_STYLE,
  GUEST_WINDOW_TABLE,
  GUEST_WINDOW_TABLE_MAX,
  GUEST_WINDOW_USERDATA,
  GUEST_WINDOW_VALID,
  GUEST_WINDOW_WIDTH,
  GUEST_WINDOW_WNDPROC,
  GUEST_WINDOW_X,
  GUEST_WINDOW_Y,
  HYPERCALL_ACTIVE_SHELL_SURFACE,
  HYPERCALL_CURSOR_X,
  HYPERCALL_CURSOR_Y,
  HYPERCALL_LAST_ERROR,
  HYPERCALL_PEEK_BUDGET,
  HYPERCALL_THREAD_COUNT,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_THREAD_NEXT,
} from '../pe';
import { ScaledClock } from '../clock';
import { decodeGuestNarrow } from './text';
import {
  EMPTY_GAME_SHIM_PROFILE,
  type CampaignMenuCompatibility,
  type GameShimProfile,
  type RegistryDefaultValue,
} from './gameProfile';

/** mixin 链用的泛型构造器：实例类型为 T。 */
export type Constructor<T> = new (...args: any[]) => T;

/** 每次确认消息队列为空后允许的客体内 PeekMessageA 快速返回次数。 */
const FAST_PEEK_EMPTY_BUDGET = 255;

export interface LoadedGuestDll {
  name: string;
  base: number;
  size: number;
  entry: number;
  initialized: boolean;
  exports: Map<string, number>;
}

/** 驱动器类型常量（Win32 GetDriveType 返回值）。 */
export const DRIVE_NO_ROOT_DIR = 1;
export const DRIVE_FIXED = 3;
export const DRIVE_CDROM = 5;

/** 每台 VM 只有一个客体进程；与窗口归属查询共享身份，不使用宿主进程号。 */
export const GUEST_PROCESS_ID = 1;

// 0x70000-0x70fff 是 FS/TEB；0x71000-0x72fff 是固件未使用的保留 RAM。
// 静态/动态桩从 0x80000/0xc0000 开始，因此这里不会和 import/vtable 桩重叠。
export const FAST_FILE_TABLE = 0x0007_1000;
export const FAST_FILE_HANDLE_BASE = 0x4000;
export const FAST_FILE_TABLE_ENTRIES = 512;
export const FAST_FILE_ENTRY_BYTES = 16;
/** 每线程 64 个 TLS 槽，位于快速文件表和调度状态表之后。 */
export const FAST_TLS_TABLE = 0x0007_4000;
export const FAST_TLS_ENTRIES = 64;
export const FAST_TLS_THREAD_BYTES = FAST_TLS_ENTRIES * 4;
export interface GuestCallbackFrame {
  depth: number;
  trampoline: number;
  ownerAddress: number;
}

export interface GuestThreadState {
  id: number;
  handle: number;
  runnable: boolean;
  terminated: boolean;
  wakeAt: number;
  wait?: GuestWaitState;
  criticalSection?: number;
  /** 尚未保存统一上下文时完成的等待结果，由 host delay 返回路径取走。 */
  waitResult?: number;
}

export interface GuestWaitState {
  handles: number[];
  waitAll: boolean;
  deadline?: number;
}

export interface GuestEventObject {
  manualReset: boolean;
  signaled: boolean;
  name: string;
  handles: Set<number>;
}

export interface GuestMutexObject {
  ownerThreadId: number | null;
  recursion: number;
  abandoned: boolean;
  name: string;
  handles: Set<number>;
}

// 镜像的默认软上限：镜像从游戏堆分配、关闭即还，占用会随打开的文件数起伏；
// 超限时该文件退回 hypercall 读。镜像绝不能挖走固定区间——原版反复读档后
// 客体内存足迹会逼近 126MB 上限，固定 48MB 镜像区会让游戏提前耗尽地址空间。
export const FAST_FILE_MIRROR_LIMIT = 48 * 1024 * 1024;

/** 诊断追踪开关：仅 Node 冒烟经 process.env 打开；浏览器/worker 无 process，恒为 false。 */
export function shimTraceEnabled(name: string): boolean {
  return typeof process !== 'undefined' && !!process.env?.[name];
}

/**
 * 通用 Win32 shim 的基础状态：堆/虚拟内存、线程、窗口、消息、输入、内存访问
 * 辅助与诊断快照。文件层、客体 DLL、同步对象、图形对象各自拆成 mixin
 * （stateFiles / stateGuestDll / stateSync / stateGraphics），由 win32.ts
 * 与各 Win32 分派模块按序组合。
 */
export class ShimState {
  protected get lastError(): number {
    return this.readU32(HYPERCALL_LAST_ERROR);
  }
  protected set lastError(value: number) {
    this.writeU32(HYPERCALL_LAST_ERROR, value >>> 0);
  }

  /** 最近打开失败的文件路径（最多 16 条，连续重复去重）；崩溃报告里定位缺失文件。 */
  readonly failedOpens: string[] = [];
  /** dispatch 停在边界（返回 null）时，随 blocked 状态一起展示的详情；
   *  vmCore 读取后清空。目前只有 CoCreateInstance 用它报 rclsid/riid。 */
  unimplementedDetail: string | null = null;
  // 堆从游戏栈上方开始；大映像游戏可通过 heapBase 后移。
  protected nextHeap: number;
  protected peakHeap: number;
  protected readonly heapBase: number;
  protected readonly allocations = new Map<number, number>();
  protected readonly freeBlocks: Array<{ ptr: number; size: number }> = [];
  /** VirtualAlloc 保留区（wemu 模型）：与堆 arena 互斥，MEM_DECOMMIT 不清除保留。
   *  原版 VC6 CRT 在启动时 VirtualAlloc(NULL, 1MB, MEM_RESERVE)，随后在保留区内
   *  逐 32KB 块 COMMIT/DECOMMIT；这些地址绝不能进入堆空闲链表，否则文件镜像
   *  等 HeapAlloc 会复用游戏正在使用的块（历史 CPU #6 @EIP=0x8f 崩溃的根源）。 */
  protected readonly virtualRegions = new Map<number, { size: number }>();
  /** MEM_RELEASE 归还的区域（wemu try_free 模型）：只供后续 VirtualAlloc 复用，
   *  不进入堆空闲链表——保留区与堆是两个互斥 arena，HeapAlloc 拿不到这里。 */
  protected readonly virtualFreeBlocks: Array<{ ptr: number; size: number }> = [];
  protected readonly virtualTop: number;
  protected readonly virtualBase: number;
  protected readonly heapTop: number;
  protected readonly warnedVirtual = new Set<number>();
  protected readonly tls = new Map<number, number>();
  protected nextTls = 0;
  /** 协作式客体线程 id/句柄计数器。 */
  protected nextThreadId = 1;
  protected nextThreadHandle = 0x0001_1000;
  protected readonly guestThreads = new Map<number, GuestThreadState>();
  protected readonly guestThreadHandles = new Map<number, number>();
  protected threadExitStub = 0;
  protected threadReturnTrampoline = 0;
  protected readonly commandLine = 0x0006_1000;
  protected readonly modulePath = 0x0006_1100;
  protected readonly environmentA = 0x0006_1200;
  protected readonly environmentW = 0x0006_1300;
  /** 动态导入 id 与动态 stub 分配器；登记逻辑在 stateGuestDll mixin。 */
  protected nextDynamicId: number;
  protected nextDynamicStub = 0x000c_0000;
  protected readonly windowClasses = new Map<string, number>();
  protected readonly windows = new Map<number, number>();
  protected readonly windowClassNames = new Map<number, string>();
  protected readonly windowTexts = new Map<number, string>();
  protected readonly windowLongs = new Map<string, number>();
  protected readonly windowParents = new Map<number, number>();
  /** 窗口客户区矩形；子窗口坐标相对父窗口，顶层窗口坐标相对桌面。 */
  protected readonly windowRects = new Map<number, { x: number; y: number; width: number; height: number }>();
  /** 有效区域尚未被 BeginPaint/ValidateRect 消耗的窗口。 */
  protected readonly invalidatedWindows = new Set<number>();
  protected readonly dialogChildren = new Map<string, number>();
  protected readonly controlIds = new Map<number, number>();
  /** 系统控件默认过程的轻量状态；RA2 Skirmish 设置页依赖这些消息返回值。 */
  protected readonly trackbarStates = new Map<number, { min: number; max: number; pos: number }>();
  protected readonly buttonChecks = new Map<number, number>();
  protected readonly controlItems = new Map<number, Array<{ text: string; data: number }>>();
  protected readonly controlSelections = new Map<number, number>();
  protected readonly controlItemHeights = new Map<number, number>();
  /** ListBox 滚动：顶部可见条目序号（LB_GETTOPINDEX/LB_SETTOPINDEX/WM_VSCROLL 同步）。 */
  protected readonly listboxTopIndices = new Map<number, number>();
  protected readonly comboStates = new Map<
    number,
    {
      selectionHeight: number;
      itemHeight: number;
      dropped: boolean;
      droppedWidth: number;
      droppedHeight: number;
    }
  >();
  protected readonly mciWindows = new Map<number, MciWindowState>();
  protected readonly timers = new Map<string, TimerState>();
  protected readonly multimediaTimers = new Map<number, MultimediaTimerState>();
  protected nextMultimediaTimer = 1;
  protected readonly messages: MessageState[] = [];
  protected readonly pendingHostMessages: MessageState[] = [];
  /** gamemd launcher 握手的共享内存内容；由 WM_BEEF 的 lParam 句柄映射。 */
  protected launcherProtectedDataPointer = 0;
  protected launcherResponseQueued = false;
  /** RA2 shell 只 Peek 不 Dispatch；host 输入在下一 API 边界同步投递。 */
  protected readonly pendingHostDispatches: MessageState[] = [];
  /** 最近一次宿主输入的命中与分派记录；用于区分坐标命中、队列和 WndProc 故障。 */
  protected readonly hostInputTrace: Array<{
    phase: 'post' | 'dispatch';
    hwnd: number;
    message: number;
    callback: number;
    className: string;
    lParam: number;
  }> = [];
  /** 已同步进入 WM_DESTROY、等待客体回调退栈后再释放的窗口根。 */
  protected readonly pendingWindowDestroys = new Map<number, number>();
  protected hostInputDispatchCount = 0;
  protected readonly keyStates = new Map<number, boolean>();
  protected lastHostKeyMessage = 0;
  protected lastHostKeyVirtualKey = 0;
  protected campaignHoverDispatchCount = 0;
  /** 合成 WM_TIMER 的分派次数；供跨线程探针判断客体是否还在泵消息。 */
  protected wmTimerDispatchCount = 0;

  protected nextWindow = 0x2000;
  protected primaryWindow = 0;
  protected focusWindow = 0;
  protected activeWindow = 0;
  protected foregroundWindow = 0;
  protected captureWindow = 0;
  /** USER32 Button 的按下目标；捕获保证同一次点击的抬起不会落到新页面控件。 */
  protected pressedButton = 0;
  protected inputReady = false;
  protected cursorX = 400;
  protected cursorY = 300;
  /** 硬件光标图像缓存：HCURSOR → 解码后的 RGBA。RA2 用 Win32 LoadCursor/SetCursor
   * 切换硬件光标、并不画进 DirectDraw 帧；宿主把这张小纹理独立叠在 framebuffer
   * 上，Pointer Lock 下仍可见，又无需为每次移动复制整张 800×600 画面。 */
  protected readonly cursorImages = new Map<
    number,
    { width: number; height: number; hotspotX: number; hotspotY: number; rgba: Uint8Array }
  >();
  /** module:id → HCURSOR，避免重复解码同一光标资源。 */
  protected readonly cursorHandleById = new Map<string, number>();
  /** 当前 SetCursor 选中的 HCURSOR（0 = 无光标/未设置）。 */
  protected currentCursorHandle = 0;
  /** RegisterClassA 的类光标（hCursor）：RA2 菜单靠类光标显示，不调 SetCursor。 */
  protected classCursor = 0;
  protected cursorDebugCount = 0;
  protected nextCursorHandle = 0x9000;
  protected displayWidth = 800;
  protected displayHeight = 600;
  protected displayBpp = 8;
  /** 最后一张真正交给前端的帧尺寸。输入必须跟随用户正在看的画面，而不是
   * 当前 primary 句柄；RA2 转场可能在旧帧仍显示时先创建下一张 800×600 primary。 */
  protected presentedWidth = 800;
  protected presentedHeight = 600;
  /** 假 BINK 视频：句柄（客体堆里 BINK 结构指针）→ 是否已 Close。结构字段被游戏直读。 */
  protected readonly binkVideos = new Set<number>();
  /** 假 BINK 帧 pacing：句柄 → 下一帧到期的客体时钟毫秒。BinkWait 据此返回 0/1。 */
  protected readonly binkNextFrameAt = new Map<number, number>();
  /** 原版 Bink 当前正在解码完整文件；其后续方法必须继续桥回同一个客体 DLL。 */
  protected nativeBinkPlaybackActive = false;
  protected nativeBinkPlaybackOpens = 0;
  /** Bink 1.0p 的 DirectSound 后端是 DLL 全局状态；重复初始化会破坏其回调。 */
  protected nativeBinkSoundSystemReady = false;
  /** 原版 Bink 播放期间固定发起线程；避免 DLL 调用间的 PIT 切换污染旧版运行库状态。 */
  protected nativeBinkPinnedThread: number | null = null;
  /** BinkClose 重定向已建立，等客体关闭代码安全进入原子桥后再释放跨调用锁。 */
  protected nativeBinkThreadReleasePending = false;
  protected primarySurface = 0;
  /** RA2 shell 当前活跃 800×600 surface：游戏把不同屏幕画到不同 surface
   * （主菜单→primary，二级页面→OFFSCREENPLAIN 层，游戏内菜单→caps=0 层），
   * 且呈现靠 primary 的 emitFrame 触发。最近 Unlock/Blt 目标即当前屏幕内容所在层。 */
  protected activeShellSurface = 0;
  /** shell 软件表面的最近绘制顺序；不能依赖 Map 创建顺序选择合成层。 */
  protected shellSurfaceDrawSerial = 0;
  /** 当前 RA2 对话框模板的标题资源键；用于区分纯 shell 菜单与内容页。 */
  protected shellPageTitle = '';
  protected readonly clock: ScaledClock;
  protected frameScheduled = false;
  protected disposed = false;
  protected lastCallbackState: VmCallbackState | null = null;
  protected readonly driveTypes = new Map<string, number>();
  /** 内存注册表：键名（小写）→ 值字节。 */
  protected readonly registryValues = new Map<string, Uint8Array>();
  protected readonly registrySessionDefaults = new Map<string, RegistryDefaultValue>();
  protected readonly registryHandles = new Map<number, string>();
  protected nextRegistryHandle = 0x6000;
  protected readonly staticImports: readonly PeImport[];
  protected readonly moduleName: string;
  protected currentDirectory = 'C:\\GAME';
  protected readonly gameProfile: GameShimProfile;
  protected readonly mmioHandles = new Map<number, MmioState>();
  protected nextMmioHandle = 0x5000;

  constructor(
    protected readonly memory: GuestMemory,
    protected readonly options: Win32ShimOptions = {},
  ) {
    this.clock = new ScaledClock();
    this.nextDynamicId = options.firstDynamicId ?? 1;
    this.virtualTop = options.virtualTop ?? 0x07e0_0000;
    this.virtualBase = options.virtualBase ?? 0x004b_e000;
    this.heapTop = options.heapTop ?? 0x07e0_0000;
    this.heapBase = options.heapBase ?? 0x0070_0000;
    this.nextHeap = this.heapBase;
    this.peakHeap = this.heapBase;
    this.guestThreads.set(0, {
      id: 0,
      handle: 0xffff_fffe,
      runnable: true,
      terminated: false,
      wakeAt: 0,
    });
    this.writeU32(HYPERCALL_THREAD_CURRENT, 0);
    this.writeU32(HYPERCALL_THREAD_NEXT, 0);
    this.writeU32(HYPERCALL_THREAD_COUNT, 1);
    this.writeU32(GUEST_THREAD_RUN_STATES, 1);
    this.zero(GUEST_CALLBACK_OWNERS, GUEST_CALLBACK_SLOTS * 4);
    this.writeU32(HYPERCALL_CALLBACK_DEPTH, 0);
    for (let id = 0; id < GUEST_THREAD_LIMIT; id++) {
      const context = GUEST_THREAD_FPU_CONTEXTS + id * GUEST_THREAD_FPU_CONTEXT_BYTES;
      this.zero(context, GUEST_THREAD_FPU_CONTEXT_BYTES);
      this.writeU32(context, 0x037f); // x87 默认 control word
      this.writeU32(context + 8, 0xffff); // 全部寄存器为空的 tag word
    }
    this.writeU32(HYPERCALL_ACTIVE_SHELL_SURFACE, 0);
    this.writeU32(HYPERCALL_PEEK_BUDGET, 0);
    this.writeU32(HYPERCALL_CURSOR_X, this.cursorX);
    this.writeU32(HYPERCALL_CURSOR_Y, this.cursorY);
    // 缺省用中性占位名：通用层不假设客体主程序叫什么，RA2/YR 的 EXE 名
    // 由各自游戏模块经 options.moduleName 传入。
    this.moduleName = options.moduleName || 'app.exe';
    this.staticImports = options.staticImports ?? [];
    this.gameProfile = options.gameProfile ?? EMPTY_GAME_SHIM_PROFILE;
    // 参数只进入命令行，不改变模块身份。保留 0x61000..0x610ff 的 NUL 边界，
    // 超长/嵌入 NUL 的配置直接拒绝，不能截断参数或覆盖后面的模块路径。
    const argumentsText = options.commandLineArguments?.trim() ?? '';
    const commandLine = this.moduleName + (argumentsText ? ` ${argumentsText}` : '');
    if (commandLine.includes('\0') || commandLine.length >= this.modulePath - this.commandLine) {
      throw new Error('客体命令行过长或包含 NUL');
    }
    this.writeAscii(this.commandLine, commandLine);
    this.writeAscii(this.modulePath, `C:\\GAME\\${this.moduleName}`);
    this.memory.write_memory(new Uint8Array([0, 0]), this.environmentA);
    this.memory.write_memory(new Uint8Array([0, 0, 0, 0]), this.environmentW);
    const driveTypes = options.driveTypes ?? { C: DRIVE_FIXED };
    for (const [letter, type] of Object.entries(driveTypes)) {
      if (/^[a-z]$/i.test(letter)) this.driveTypes.set(letter.toUpperCase(), type >>> 0);
    }
  }

  inspectCallbackState(): VmCallbackState | null {
    return this.lastCallbackState;
  }

  /** 当前 RA2 shell 页标题资源键；供状态驱动的输入测试等待真实菜单创建完成。 */
  inspectShellPageTitle(): string {
    return this.shellPageTitle;
  }

  /** 窗口及其祖先均带 WS_VISIBLE 才实际可见。 */
  protected isWindowTreeVisible(start: number): boolean {
    const seen = new Set<number>();
    let hwnd = start;
    while (hwnd && !seen.has(hwnd)) {
      seen.add(hwnd);
      if (((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x1000_0000) === 0) return false;
      hwnd = this.windowParents.get(hwnd) ?? 0;
    }
    return true;
  }

  /** shell 菜单由游戏资源登记的页标题状态与可见 dialog 共同标识。 */
  protected isShellVisible(): boolean {
    if (!this.gameProfile.shell?.compositeRgb565Layers) return false;
    const titleControlId = this.gameProfile.shell.titleControlId;
    if (titleControlId !== undefined) {
      if (!this.shellPageTitle) return false;
      for (const [hwnd, id] of this.controlIds) {
        if (id === titleControlId && ((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x1000_0000) !== 0) return true;
      }
      return false;
    }
    for (const [hwnd, className] of this.windowClassNames) {
      if (className.toLowerCase() !== '#32770' || !this.isWindowTreeVisible(hwnd)) continue;
      const rect = this.windowRects.get(hwnd);
      if (rect && rect.width >= this.displayWidth && rect.height >= this.displayHeight) return true;
    }
    return false;
  }

  /**
   * 当前壳页是游戏登记的 Campaign 页时返回其控件登记，否则 undefined。
   * RGBA 合成、隐藏列表边框修补与徽标 hover 诊断共用这一处判断，
   * 未登记能力的游戏不做任何 Campaign 页专属补偿。
   */
  protected campaignMenu(): CampaignMenuCompatibility | undefined {
    const menu = this.gameProfile.shell?.campaignMenu;
    if (!menu) return undefined;
    const title = this.shellPageTitle.toLowerCase();
    return menu.titleKeys.some((key) => title.includes(key)) ? menu : undefined;
  }

  /** listbox/combobox 内容诊断快照（RA2 地图/下拉枚举验证）。 */
  inspectControlItems(): Array<{ hwnd: number; className: string; selection: number; items: string[] }> {
    return [...this.controlItems.entries()].map(([hwnd, items]) => ({
      hwnd,
      className: this.windowClassNames.get(hwnd) ?? '',
      selection: this.controlSelections.get(hwnd) ?? -1,
      items: items.map((item) => item.text),
    }));
  }

  inspectHostInputTrace(): Array<{
    phase: 'post' | 'dispatch';
    hwnd: number;
    message: number;
    callback: number;
    className: string;
    lParam: number;
  }> {
    return this.hostInputTrace.map((entry) => ({ ...entry }));
  }

  /** User32 布局/命中诊断快照；只返回副本，避免测试修改窗口管理状态。 */
  inspectWindowState(): Array<{
    hwnd: number;
    callback: number;
    parent: number;
    id: number;
    className: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number } | null;
    style: number;
  }> {
    return [...this.windows].map(([hwnd, callback]) => ({
      hwnd,
      callback,
      parent: this.windowParents.get(hwnd) ?? 0,
      id: this.controlIds.get(hwnd) ?? 0,
      className: this.windowClassNames.get(hwnd) ?? '',
      text: this.windowTexts.get(hwnd) ?? '',
      rect: this.windowRects.get(hwnd) ? { ...this.windowRects.get(hwnd)! } : null,
      style: this.windowLongs.get(`${hwnd}:-16`) ?? 0,
    }));
  }

  /** 调试器使用的客体线程快照；避免暴露可变的内部调度状态。 */
  inspectGuestThreads(): Array<{
    id: number;
    handle: number;
    current: boolean;
    next: boolean;
    runnable: boolean;
    terminated: boolean;
    wakeInMs: number;
    waitHandles?: number[];
    waitForThread?: number;
    waitForCriticalSection?: number;
    waitInMs?: number;
    runState: number;
    criticalDepth: number;
  }> {
    const now = this.clock.now();
    const current = this.readU32(HYPERCALL_THREAD_CURRENT);
    const next = this.readU32(HYPERCALL_THREAD_NEXT);
    return [...this.guestThreads.values()].map((thread) => {
      const waitedThread =
        thread.wait?.handles.length === 1 ? this.guestThreadHandles.get(thread.wait.handles[0]!) : undefined;
      return {
        id: thread.id,
        handle: thread.handle,
        current: thread.id === current,
        next: thread.id === next,
        runnable: thread.runnable,
        terminated: thread.terminated,
        wakeInMs: thread.wakeAt > 0 ? Math.max(0, thread.wakeAt - now) : 0,
        runState: this.readU32(GUEST_THREAD_RUN_STATES + thread.id * 4),
        criticalDepth: this.readU32(GUEST_THREAD_CRITICAL_DEPTH + thread.id * 4),
        ...(thread.criticalSection === undefined ? {} : { waitForCriticalSection: thread.criticalSection }),
        ...(thread.wait ? { waitHandles: [...thread.wait.handles] } : {}),
        ...(waitedThread === undefined ? {} : { waitForThread: waitedThread }),
        ...(thread.wait?.deadline === undefined ? {} : { waitInMs: Math.max(0, thread.wait.deadline - now) }),
      };
    });
  }

  /** 游戏 mixin 在共用 DLL 分派之前拦截的专属导入；默认无。 */
  protected dispatchExclusive(_call: Win32Call): Win32Result | null {
    return null;
  }

  /** 游戏组合层可选接管 Winsock；纯共用 shim 默认停在未实现边界。 */
  protected dispatchGameWinsock(_key: string, _args: number[]): Win32Result | null {
    return null;
  }

  /** 游戏组合层释放自己的网络资源；纯共用 shim 无操作。 */
  protected disposeGameNetwork(): void {}

  /** 在 host 生成阶段占槽；不同线程或未开始执行的桥也不能复用。 */
  protected reserveGuestCallback(): GuestCallbackFrame {
    for (let depth = 0; depth < GUEST_CALLBACK_SLOTS; depth++) {
      const ownerAddress = GUEST_CALLBACK_OWNERS + depth * 4;
      if (this.readU32(ownerAddress) !== 0) continue;
      this.writeU32(ownerAddress, this.readU32(HYPERCALL_THREAD_CURRENT) + 1);
      this.writeU32(HYPERCALL_CALLBACK_DEPTH, this.readU32(HYPERCALL_CALLBACK_DEPTH) + 1);
      return { depth, trampoline: GUEST_CALLBACK_BASE + depth * GUEST_CALLBACK_STRIDE, ownerAddress };
    }
    throw new Error(`客体回调槽耗尽（${GUEST_CALLBACK_SLOTS} 个活动回调）`);
  }

  protected releaseExitedThreadCallbacks(threadId: number): void {
    let released = 0;
    for (let slot = 0; slot < GUEST_CALLBACK_SLOTS; slot++) {
      const address = GUEST_CALLBACK_OWNERS + slot * 4;
      if (this.readU32(address) !== threadId + 1) continue;
      this.writeU32(address, 0);
      released++;
    }
    // ExitThread 不会经过桥尾部。此时 import 握手仍屏蔽线程切换，
    // 且该线程永不恢复，因此可以安全回收它的全部嵌套回调。
    this.writeU32(HYPERCALL_CALLBACK_DEPTH, this.readU32(HYPERCALL_CALLBACK_DEPTH) - released);
  }

  protected appendGuestCallbackReturn(code: number[], frame: GuestCallbackFrame, originalReturn: number): void {
    const emit32 = (value: number) =>
      code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
    // 释放槽后到 RET 必须不可抢占，否则另一线程可能覆盖仍在执行的尾部。
    code.push(0xfa, 0xff, 0x0d);
    emit32(HYPERCALL_CALLBACK_DEPTH); // cli; dec [active]
    code.push(0xc7, 0x05);
    emit32(frame.ownerAddress);
    emit32(0);
    code.push(0x68);
    emit32(originalReturn); // push return，保留回调 EAX
    code.push(0x8b, 0x0d);
    emit32(HYPERCALL_THREAD_CURRENT);
    code.push(0x83, 0x3c, 0x8d);
    emit32(GUEST_THREAD_CRITICAL_DEPTH);
    code.push(0);
    code.push(0x75, 0x01, 0xfb, 0xc3); // jne ret; sti; ret（STI 的中断阴影覆盖 RET）
    if (code.length > GUEST_CALLBACK_STRIDE) throw new Error(`客体回调桥超出槽位: ${code.length}`);
  }

  /** 在 host 侧生成动态桩代码；文件、DLL、同步与图形 mixin 共用。 */
  protected allocateDynamicCode(code: Uint8Array | number[]): number {
    const bytes = code instanceof Uint8Array ? code : new Uint8Array(code);
    let address = this.nextDynamicStub;
    // 0xf0000..0xfffff 是正在运行的固件、GDT 和 IDT，绝不能写入动态桩。
    if (address < 0x0010_0000 && address + bytes.length > 0x000f_0000) address = 0x0010_0000;
    const end = Math.ceil((address + bytes.length) / 16) * 16;
    if (end > 0x0020_0000) throw new Error('动态 stub 区不足');
    this.memory.write_memory(bytes, address);
    this.nextDynamicStub = end;
    return address;
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.keyStates.set(virtualKey >>> 0, down);
  }

  /** 当前实际呈现面的鼠标坐标与边界；供跨线程输入探针验证最终钳制结果。 */
  inspectPointerState(): {
    x: number;
    y: number;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    lastKeyMessage: number;
    lastKeyVirtualKey: number;
    lastMouseMessage: number;
    lastMouseHwnd: number;
    lastMouseControlId: number;
    lastMouseCallback: number;
    lastMouseDispatchHwnd: number;
    lastMouseDispatchControlId: number;
    lastMouseDispatchCallback: number;
    campaignHoverDispatches: number;
    wmTimerDispatches: number;
  } {
    const client = this.windowRects.get(this.primaryWindow);
    let mouse: (typeof this.hostInputTrace)[number] | undefined;
    let dispatchedMouse: (typeof this.hostInputTrace)[number] | undefined;
    for (let index = this.hostInputTrace.length - 1; index >= 0; index--) {
      const entry = this.hostInputTrace[index]!;
      if (!mouse && entry.phase === 'post') mouse = entry;
      if (!dispatchedMouse && entry.phase === 'dispatch') dispatchedMouse = entry;
      if (mouse && dispatchedMouse) break;
    }
    return {
      x: this.cursorX,
      y: this.cursorY,
      width: this.presentedWidth,
      height: this.presentedHeight,
      clientWidth: client?.width ?? 0,
      clientHeight: client?.height ?? 0,
      lastKeyMessage: this.lastHostKeyMessage,
      lastKeyVirtualKey: this.lastHostKeyVirtualKey,
      lastMouseMessage: mouse?.message ?? 0,
      lastMouseHwnd: mouse?.hwnd ?? 0,
      lastMouseControlId: mouse ? (this.controlIds.get(mouse.hwnd) ?? 0) : 0,
      lastMouseCallback: mouse?.callback ?? 0,
      lastMouseDispatchHwnd: dispatchedMouse?.hwnd ?? 0,
      lastMouseDispatchControlId: dispatchedMouse ? (this.controlIds.get(dispatchedMouse.hwnd) ?? 0) : 0,
      lastMouseDispatchCallback: dispatchedMouse?.callback ?? 0,
      campaignHoverDispatches: this.campaignHoverDispatchCount,
      wmTimerDispatches: this.wmTimerDispatchCount,
    };
  }

  setCursorPosition(x: number, y: number): void {
    // 转场时 DirectDraw 的“当前 primary”可能已经是下一页 800×600 surface，
    // 而浏览器仍在显示上一张 1440×900 战场帧。按最后呈现帧钳制，RA2/YR
    // 的前端坐标与 Worker 最终坐标才使用同一个边界。
    const width = this.presentedWidth;
    const height = this.presentedHeight;
    this.cursorX = Math.max(0, Math.min(Math.max(0, width - 1), Math.round(x)));
    this.cursorY = Math.max(0, Math.min(Math.max(0, height - 1), Math.round(y)));
    this.syncCursorPositionToGuest();
  }

  /** host 输入与 SetCursorPos 共用的光标坐标镜像更新。 */
  protected syncCursorPositionToGuest(): void {
    this.writeU32(HYPERCALL_CURSOR_X, this.cursorX >>> 0);
    this.writeU32(HYPERCALL_CURSOR_Y, this.cursorY >>> 0);
  }

  /** 有新消息或定时器状态变化时，强制下一次 PeekMessageA 回 host。 */
  protected invalidateFastPeek(): void {
    this.writeU32(HYPERCALL_PEEK_BUDGET, 0);
  }

  /** 仅在消息队列和两类 timer 都为空时开放有限次数的客体快速空轮询。 */
  protected refreshFastPeekBudget(): void {
    const mustPollHost =
      this.messages.length > 0 ||
      this.pendingHostDispatches.length > 0 ||
      this.pendingHostMessages.length > 0 ||
      this.timers.size > 0 ||
      this.multimediaTimers.size > 0;
    this.writeU32(HYPERCALL_PEEK_BUDGET, mustPollHost ? 0 : FAST_PEEK_EMPTY_BUDGET);
  }

  setGameClockRate(rate: number): number {
    return this.clock.setRate(rate);
  }

  inspectHeapState(): VmHeapState {
    return {
      liveAllocations: this.allocations.size,
      liveBytes: [...this.allocations.values()].reduce((sum, size) => sum + size, 0),
      freeBlocks: this.freeBlocks.length,
      freeBytes: this.freeBlocks.reduce((sum, block) => sum + block.size, 0),
      nextAddress: this.nextHeap,
      peakAddress: this.peakHeap,
      virtualRegions: this.virtualRegions.size,
      virtualBytes: [...this.virtualRegions.values()].reduce((sum, region) => sum + region.size, 0),
      virtualFreeBytes: this.virtualFreeBlocks.reduce((sum, block) => sum + block.size, 0),
    };
  }

  protected readU32(ptr: number): number {
    const b = this.memory.read_memory(ptr, 4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  protected readU8(ptr: number): number {
    return this.memory.read_memory(ptr, 1)[0] ?? 0;
  }

  protected readU16(ptr: number): number {
    const b = this.memory.read_memory(ptr, 2);
    return (b[0]! | (b[1]! << 8)) >>> 0;
  }

  /** writeU32 专用 4 字节暂存：不再每次调用分配数组字面量
   *  （Lock/SetColorKey 等热路径每秒上万次）。write_memory 同步复制，可安全复用。 */
  private readonly writeU32Scratch = new Uint8Array(4);

  protected writeU32(ptr: number, value: number): void {
    const scratch = this.writeU32Scratch;
    scratch[0] = value & 0xff;
    scratch[1] = (value >>> 8) & 0xff;
    scratch[2] = (value >>> 16) & 0xff;
    scratch[3] = (value >>> 24) & 0xff;
    this.memory.write_memory(scratch, ptr);
  }

  /**
   * 把 shim 里的窗口几何/属性镜像到客体表（GUEST_WINDOW_TABLE），供客体快速桩
   * 直接读取。窗口状态的任何变更（创建/移动/SetWindowLong/销毁/对话框项）都必须
   * 调一次，否则客体读到旧值。越界 hwnd 直接忽略（客体桩会回退完整 hypercall）。
   * X/Y 存绝对屏幕坐标（沿父链累加相对偏移），客体桩无需再遍历父链。
   */
  protected syncWindowToGuest(hwnd: number): void {
    const index = hwnd - 0x2000;
    if (index < 0 || index >= GUEST_WINDOW_TABLE_MAX) return;
    const base = GUEST_WINDOW_TABLE + index * GUEST_WINDOW_ENTRY_BYTES;
    let absX = 0;
    let absY = 0;
    {
      let current = hwnd;
      const seen = new Set<number>();
      while (current && !seen.has(current)) {
        seen.add(current);
        const r = this.windowRects.get(current);
        if (r) {
          absX += r.x;
          absY += r.y;
        }
        current = this.windowParents.get(current) ?? 0;
      }
    }
    const rect = this.windowRects.get(hwnd);
    this.writeU32(base + GUEST_WINDOW_X, absX >>> 0);
    this.writeU32(base + GUEST_WINDOW_Y, absY >>> 0);
    this.writeU32(base + GUEST_WINDOW_WIDTH, (rect?.width ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_HEIGHT, (rect?.height ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_PARENT, (this.windowParents.get(hwnd) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_STYLE, (this.windowLongs.get(`${hwnd}:-16`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_ID, (this.windowLongs.get(`${hwnd}:-12`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXSTYLE, (this.windowLongs.get(`${hwnd}:-20`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_WNDPROC, (this.windows.get(hwnd) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_USERDATA, (this.windowLongs.get(`${hwnd}:-21`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA0, (this.windowLongs.get(`${hwnd}:0`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA4, (this.windowLongs.get(`${hwnd}:4`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA8, (this.windowLongs.get(`${hwnd}:8`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_EXTRA12, (this.windowLongs.get(`${hwnd}:12`) ?? 0) >>> 0);
    this.writeU32(base + GUEST_WINDOW_VALID, this.windows.has(hwnd) ? 1 : 0);
  }

  /**
   * 几何或父链变更会影响所有后代的绝对坐标，需级联同步整棵子树。
   * 移动/改父很少发生（多在布局期），O(后代) 级联可接受。
   */
  protected syncWindowTreeToGuest(hwnd: number): void {
    const queue = [hwnd];
    const seen = new Set<number>();
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      this.syncWindowToGuest(current);
      for (const [child, parent] of this.windowParents) {
        if (parent === current && !seen.has(child)) queue.push(child);
      }
    }
  }

  protected readBytes(ptr: number, max: number): Uint8Array {
    return this.memory.read_memory(ptr, max);
  }

  protected readCString(ptr: number, max = 0x1_0000): string {
    if (!ptr) return '';
    const bytes = this.readBytes(ptr, max);
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    return decodeGuestNarrow(bytes.subarray(0, end));
  }

  /** NUL 前的原始字节数（Win32 lstrlenA 语义：GBK 双字节不合并）。 */
  protected narrowStringLength(ptr: number, max = 0x1_0000): number {
    if (!ptr) return 0;
    const bytes = this.readBytes(ptr, max);
    const end = bytes.indexOf(0);
    return end < 0 ? bytes.length : end;
  }

  protected readNarrowBytes(ptr: number, length: number): Uint8Array {
    if (!ptr) return new Uint8Array();
    if (length >= 0) return this.memory.read_memory(ptr, length);
    const bytes = this.memory.read_memory(ptr, 0x1_0000);
    const nul = bytes.indexOf(0);
    return bytes.subarray(0, (nul < 0 ? bytes.length : nul) + 1);
  }

  protected readWideUnits(ptr: number, length: number): number[] {
    if (!ptr) return [];
    const maxUnits = length >= 0 ? length : 0x8000;
    const bytes = this.memory.read_memory(ptr, maxUnits * 2);
    const out: number[] = [];
    for (let i = 0; i < maxUnits; i++) {
      const value = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
      out.push(value);
      if (length < 0 && value === 0) break;
    }
    return out;
  }

  protected writeAscii(ptr: number, value: string): void {
    const out = new Uint8Array(value.length + 1);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0x7f;
    this.memory.write_memory(out, ptr);
  }

  protected writeCharTypes(ptr: number, units: number[]): void {
    if (!ptr) return;
    const out = new Uint8Array(units.length * 2);
    for (let i = 0; i < units.length; i++) {
      const c = units[i]!;
      let type = 0;
      if (c >= 0x41 && c <= 0x5a) type |= 0x0001 | 0x0100;
      if (c >= 0x61 && c <= 0x7a) type |= 0x0002 | 0x0100;
      if (c >= 0x30 && c <= 0x39) type |= 0x0004;
      if (c === 0x20 || (c >= 9 && c <= 13)) type |= 0x0008;
      if (c === 0x20 || c === 9) type |= 0x0040;
      if (c < 0x20 || c === 0x7f) type |= 0x0020;
      if ((c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e))
        type |= 0x0010;
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) type |= 0x0080;
      out[i * 2] = type & 0xff;
      out[i * 2 + 1] = type >>> 8;
    }
    this.memory.write_memory(out, ptr);
  }

  protected writeRect(ptr: number, left: number, top: number, right: number, bottom: number): void {
    this.writeU32(ptr, left);
    this.writeU32(ptr + 4, top);
    this.writeU32(ptr + 8, right);
    this.writeU32(ptr + 12, bottom);
  }

  protected readRect(ptr: number): [number, number, number, number] {
    // 一次 16 字节读代替 4 次 readU32（每次 readU32 各含 2 次 WASM 边界检查）：
    // BltFast/Blt 每秒上万次，RECT 读是固定开销。
    const b = this.memory.read_memory(ptr, 16);
    return [
      b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24) | 0,
      b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24) | 0,
      b[8]! | (b[9]! << 8) | (b[10]! << 16) | (b[11]! << 24) | 0,
      b[12]! | (b[13]! << 8) | (b[14]! << 16) | (b[15]! << 24) | 0,
    ];
  }

  protected mapAsciiCase(c: number, flags: number): number {
    if ((flags & 0x100) !== 0 && c >= 0x41 && c <= 0x5a) return c + 0x20; // LCMAP_LOWERCASE
    if ((flags & 0x200) !== 0 && c >= 0x61 && c <= 0x7a) return c - 0x20; // LCMAP_UPPERCASE
    return c;
  }

  /** 填充暂存区：小块填充（清屏/清表面/清结构）复用同一 buffer，
   *  避免每次分配新 Uint8Array——CreateSurface 每秒上万次的分配热点。 */
  private fillScratch = new Uint8Array(64 * 1024);

  protected writeFilledRegion(ptr: number, size: number, index: number): void {
    if (size <= 0) return;
    const chunk = size <= this.fillScratch.length ? this.fillScratch : new Uint8Array(size);
    chunk.fill(index);
    if (size === chunk.length) {
      this.memory.write_memory(chunk, ptr);
      return;
    }
    let offset = 0;
    while (offset < size) {
      const step = Math.min(chunk.length, size - offset);
      this.memory.write_memory(chunk.subarray(0, step), ptr + offset);
      offset += step;
    }
  }

  protected zero(ptr: number, size: number): void {
    this.writeFilledRegion(ptr, size, 0);
  }
}
