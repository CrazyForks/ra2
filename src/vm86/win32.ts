/** 宿主网络状态；连接存活不代表客体游戏已同步。 */
export interface VmNetworkStatus {
  phase: 'connecting' | 'connected' | 'disconnected' | 'error';
  room: string;
  peers: number;
  detail: string;
  relayRttMs?: number;
}

import {
  makeConstantImportStub,
  makeFirstArgImportStub,
  makeImportStub,
  HYPERCALL_QPC_HIGH,
  HYPERCALL_QPC_LOW,
  HYPERCALL_LAST_ERROR,
  HYPERCALL_CURSOR_COUNT,
  HYPERCALL_CURSOR_X,
  HYPERCALL_CURSOR_Y,
  HYPERCALL_PEEK_BUDGET,
  HYPERCALL_THREAD_CURRENT,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_WINDOW_EXSTYLE,
  GUEST_WINDOW_EXTRA0,
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
  type ImportArgBytes,
  type ImportStubFactory,
  type PeImport,
} from './pe';
import { type PcmPlayOptions, type PcmWaveFormat } from './audio';
import type { DplayTransportFactory } from './shim/dplayTransport';
import type { GameShimProfile } from './shim/gameProfile';

const GUEST_BINK_VIDEO_EXPORTS = new Set([
  '_BinkSetSoundSystem@8',
  '_BinkOpenDirectSound@4',
  '_BinkOpen@8',
  '_BinkClose@4',
  '_BinkDDSurfaceType@4',
  '_BinkGoto@12',
  '_BinkSetVolume@8',
  '_BinkPause@8',
  '_BinkNextFrame@4',
  '_BinkCopyToBuffer@28',
  '_BinkDoFrame@4',
  '_BinkWait@4',
  '_BinkGetError@0',
]);

const GUEST_BINK_SOUND_SETUP_EXPORTS = new Set(['_BinkSetSoundSystem@8', '_BinkOpenDirectSound@4']);

/** Open/Close 留在 host 作为实例生命周期边界；逐帧方法直连客体 DLL，避免每帧
 * CopyToBuffer 都通过 COM1 IRQ 唤醒 v86（用户日志中的精确 panic 边界）。 */
const DIRECT_NATIVE_BINK_EXPORTS = new Set([
  '_BinkDDSurfaceType@4',
  '_BinkGoto@12',
  '_BinkSetVolume@8',
  '_BinkPause@8',
  '_BinkNextFrame@4',
  '_BinkCopyToBuffer@28',
  '_BinkDoFrame@4',
  '_BinkWait@4',
  '_BinkGetError@0',
]);

/** v86 对客体物理内存开放的最小接口。 */
export interface GuestMemory {
  read_memory(offset: number, length: number): Uint8Array;
  write_memory(bytes: Uint8Array | number[], offset: number): void;
}

export interface Win32Result {
  eax: number;
  edx?: number;
  /** WaitMessage 等接口在 host 上挂起这么久后再唤醒客体。 */
  delayMs?: number;
  /** ExitProcess/ExitThread 等会要求 host 停机。 */
  exit?: boolean;
  /** 只终止当前客体线程，由调度器恢复其他线程。 */
  threadExit?: boolean;
}

export interface Win32Call {
  imported: PeImport;
  stack: number;
  args: number[];
}

export interface VmFrame {
  width: number;
  height: number;
  /** 8-bit 调色板模式的索引；RGB565 模式下为空。 */
  pixels: Uint8Array;
  /** DirectDraw PALETTEENTRY：每项 red/green/blue/flags。 */
  palette: Uint8Array;
  /** 16-bit RGB565 表面转换后的浏览器原生 RGBA。 */
  rgba?: Uint8Array;
  /** 无需宿主控件合成时的紧凑 RGB565；无行尾填充，可直接上传整数纹理。 */
  rgb565?: Uint16Array;
  /** Win32 硬件光标的独立小纹理；宿主可移动它而无需重传整张 framebuffer。 */
  cursor?: {
    handle: number;
    width: number;
    height: number;
    hotspotX: number;
    hotspotY: number;
    x: number;
    y: number;
    rgba: Uint8Array;
  };
}

export interface VmSurfaceSnapshot {
  object: number;
  width: number;
  height: number;
  pitch: number;
  bpp: number;
  pixels: Uint8Array;
}

export interface VmGdiDcSnapshot {
  surface: number;
  textColor: number;
  paletteIndex: number;
  paletteColor: [number, number, number];
}

export interface VmHeapState {
  liveAllocations: number;
  liveBytes: number;
  freeBlocks: number;
  freeBytes: number;
  nextAddress: number;
  peakAddress: number;
  /** VirtualAlloc 保留区（与堆互斥，MEM_DECOMMIT 不清除保留）。 */
  virtualRegions: number;
  virtualBytes: number;
  /** MEM_RELEASE 归还、可供后续 VirtualAlloc 复用的字节数。 */
  virtualFreeBytes: number;
}

export interface VmCallbackState {
  hwnd: number;
  message: number;
  callback: number;
  callStack: number;
  originalReturn: number;
  trampoline: number;
  depth: number;
}

export interface Win32ShimOptions {
  /** 静态 PE 导入后的第一个动态 COM hypercall id。 */
  firstDynamicId?: number;
  /** 主模块静态 IAT；原生客体 DLL 活跃时可把高频导出临时直连，避开串口 IRQ 往返。 */
  staticImports?: readonly PeImport[];
  onFrame?: (frame: VmFrame) => void;
  /** 客体完成一轮 DirectDraw 垂直同步，即原版主循环的一帧。 */
  onLogicFrame?: () => void;
  /** 将高频 primary surface 更新合并到下一次宿主绘制机会。 */
  scheduleFrame?: (emit: () => void) => void;
  /** Worker 只在 mailbox 有发送额度时取快照；主线程路径保持 emit 时取快照。 */
  deferFrameSnapshot?: boolean;
  /** 呈现端支持 RGB565 时，避免在 VM 线程将整帧展开成 RGBA。 */
  packedRgb565Frames?: boolean;
  /** 独立呈现缓冲回收池；返回精确尺寸，不能与客体内存共享。 */
  takeFrameBuffer?: (size: number) => ArrayBuffer;
  /** 显式游戏兼容能力；缺省为空，不启用任何游戏专属地址或补丁。 */
  gameProfile?: GameShimProfile;
  /** 启动前已从 /game 取得的同步客体文件。 */
  files?: ReadonlyMap<string, Uint8Array>;
  /** 可选的宿主 PCM 输出；Node 冒烟测试不提供时仍保留完整 DirectSound 状态。 */
  audio?: Win32AudioSink;
  /** DirectPlay 传输工厂；浏览器默认 WebSocket，Node 回归可显式注入 BroadcastChannel。 */
  dplayTransportFactory?: DplayTransportFactory;
  /** 浏览器侧同步字体光栅器；文字最终仍写回客体的 8-bit DirectDraw surface。 */
  textRasterizer?: Win32TextRasterizer;
  /** 可写文件关闭或显式 flush 时通知宿主持久化；bytes 是独立快照。 */
  onFileWrite?: (path: string, bytes: Uint8Array) => void;
  /** 客体 GetCommandLine/GetModuleFileName 看到的真实主程序名。 */
  moduleName?: string;
  /** GetCommandLineA 的参数尾部；独立于模块路径，不能污染 GetModuleFileNameA。 */
  commandLineArguments?: string;
  /** 虚拟 Win32 盘符类型；未提供时只有安装所在的 C: 固定盘。 */
  driveTypes?: Readonly<Record<string, number>>;
  /** GetVolumeInformationA 报告的卷序列号；缺省 0x20010701（Node 侧用 VM_SERIAL 注入）。 */
  volumeSerial?: number;
  /** 启用客体内高速 _lread 桩：文件在打开时镜像（写入时降级），关闭即归还堆。 */
  enableFastFileMirror?: boolean;
  /** 镜像总预算（默认 48MB）；配置持久镜像区时通常取该区实际大小。 */
  fastFileMirrorLimit?: number;
  /** 大型只读文件的持久镜像区；配置后按路径缓存、跨句柄复用，不占游戏堆。 */
  fastFileMirrorBase?: number;
  fastFileMirrorTop?: number;
  /** 配置后只有列出的规范化路径会进入持久镜像区。 */
  fastFileMirrorFiles?: readonly string[];
  /** VirtualAlloc(NULL) 保留区的自顶向下分配上界；默认与堆上限一致。 */
  virtualTop?: number;
  /** 固定地址 VirtualAlloc 的最低合法地址；默认保留原版映像后的 0x4be000。 */
  virtualBase?: number;
  /** 堆 bump 与固定地址 VirtualAlloc 的 arena 顶（默认 0x7e00000）；
   *  与 virtualTop 分离：冒烟把 virtualTop 压到 8MB 验证堆穿过保留区，
   *  堆必须仍能增长到真正的 arena 顶。 */
  heapTop?: number;
  /** shim 堆起点；默认 0x700000。必须位于 PE 映像和主线程栈之后。 */
  heapBase?: number;
  /** 动态来宾 DLL 的静态导入 ABI 查询器。 */
  importArgBytes?: ImportArgBytes;
  /** 动态来宾 DLL 的导入桩工厂；应与主 PE 使用同一快速路径配置。 */
  dynamicImportStub?: ImportStubFactory;
}

/** GetDriveTypeA 盘符类型（Win32 DRIVE_* 常量中本项目用到的一档）。 */

export interface Win32AudioSink {
  createBuffer(id: number, byteLength: number, format: PcmWaveFormat): void;
  duplicateBuffer(sourceId: number, destinationId: number): boolean;
  setFormat(id: number, format: PcmWaveFormat): boolean;
  writeBuffer(id: number, offset: number, bytes: Uint8Array): number;
  play(id: number, options?: PcmPlayOptions): boolean;
  stop(id: number): boolean;
  setCurrentPosition(id: number, byteOffset: number): boolean;
  setVolume(id: number, volume: number): boolean;
  setPan(id: number, pan: number): boolean;
  setFrequency(id: number, frequency: number): boolean;
  getState(id: number): { positionBytes: number; playing: boolean } | null;
  releaseBuffer(id: number): boolean;
}

export interface VmGdiFont {
  height: number;
  width: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  charset: number;
  faceName: string;
}

export interface VmTextBitmap {
  width: number;
  height: number;
  /** 0..255 glyph coverage, tightly packed by row. */
  alpha: Uint8Array;
  /** 覆盖度偏置的中性点（默认 128）：shim 侧按 coverage + (128 - threshold)
   * 得到有效覆盖度，调低更粗、调高更细。 */
  threshold?: number;
  /** 光栅实际使用的 CSS family（诊断用）。 */
  family?: string;
}

export interface Win32TextRasterizer {
  rasterize(text: string, font: VmGdiFont): VmTextBitmap | null;
}

export interface SurfaceState {
  object: number;
  width: number;
  height: number;
  pitch: number;
  bpp: number;
  pixels: number;
  caps: number;
  palette: number;
  attached: number;
  sourceColorKey: [number, number] | null;
  destinationColorKey: [number, number] | null;
  /** GDI 字形保留 COLORREF，调色板换页时可重映射而不变色。 */
  textRuns: GdiTextRun[];
  /** 最近一次 Unlock/Blt/BltFast 的全局递增序号；用于从同规格工作表面中选择最新层。 */
  lastDrawSerial: number;
  /** 自上次 emit 以来像素是否被写过（Blt/Lock/Flip/GDI/换调色板置位）——游戏一帧
   *  里 Blt+vblank×2 会触发三次 emit，内容没变的重复快照纯属垃圾（每帧 3×480KB
   *  分配 + 跨线程消息，60fps 下 GC 压力周期性卡顿）。 */
  dirty: boolean;
}

export interface MciWindowState {
  parent: number;
  playing: boolean;
}

export interface PaletteState {
  object: number;
  caps: number;
  entries: Uint8Array;
}

export interface SoundBufferState {
  object: number;
  data: number;
  size: number;
  /** position 对应的宿主单调时钟锚点；Worker 无法同步读取 WebAudio 时用于估算播放头。 */
  startedAt: number;
  position: number;
  playing: boolean;
  looping: boolean;
  format: PcmWaveFormat;
  volume: number;
  pan: number;
  frequency: number;
}

export interface GdiDcState {
  surface: number;
  /** Window DC 的客户区原点（相对 DirectDraw 主表面）。Surface DC 为 0,0。 */
  originX: number;
  originY: number;
  selectedFont: number;
  selectedBrush: number;
  textColor: number;
  backgroundMode: number;
  backgroundColor: number;
}

/** 抗锯齿文字改过的像素：offset 相对 run 矩形起点（按 surface pitch 计行），
 * original 为绘制前的背景索引，written 为写下的混合色索引。
 * 调色板换页时据此恢复背景并重新混合，保证重映射幂等。 */
export interface GdiTextPixelChange {
  offset: number;
  original: number;
  written: number;
}

export interface GdiTextRun {
  x: number;
  y: number;
  bitmap: VmTextBitmap;
  colorRef: number;
  paletteIndex: number;
  /** null = 超出记录上限，退化为纯实心重映射（边缘混合像素换页后不再修正）。 */
  changed: GdiTextPixelChange[] | null;
}

export interface FileState {
  path: string;
  /** 容量可大于 size，避免小块追加时反复复制整个文件。 */
  bytes: Uint8Array;
  size: number;
  position: number;
  writable: boolean;
  dirty: boolean;
  /** 只读文件在客体内的镜像，供 _lread 快速桩直接拷贝。 */
  mirror?: number;
  /** 指向独立持久镜像区；关闭句柄时不能当普通堆块释放。 */
  sharedMirror?: boolean;
}

export interface MmioState {
  path: string;
  bytes: Uint8Array;
  position: number;
}

export interface TimerState {
  hwnd: number;
  id: number;
  interval: number;
  callback: number;
  next: number;
}

export interface MultimediaTimerState {
  id: number;
  interval: number;
  callback: number;
  user: number;
  periodic: boolean;
  next: number;
}

export interface MessageState {
  hwnd: number;
  message: number;
  wParam: number;
  lParam: number;
  time: number;
  x: number;
  y: number;
  /** 鼠标消息入队时的左右 Shift/Ctrl 快照，保持异步队列中的物理键时间线。 */
  modifierKeyState?: number;
}

import {
  FAST_FILE_HANDLE_BASE,
  FAST_FILE_TABLE,
  FAST_FILE_TABLE_ENTRIES,
  FAST_TLS_ENTRIES,
  FAST_TLS_TABLE,
  ShimState,
  shimTraceEnabled,
} from './shim/state';
import { withShimFiles } from './shim/stateFiles';
import { withShimGuestDll } from './shim/stateGuestDll';
import { withShimSync } from './shim/stateSync';
import { withShimGraphics } from './shim/stateGraphics';
import { withKernel32 } from './shim/kernel32';
import { withUser32 } from './shim/user32';
import { withGdi32 } from './shim/gdi32';
import { withWinmm } from './shim/winmm';
import { withDirectx } from './shim/directx';
import { withDplayx } from './shim/dplayx';
import { withOle32 } from './shim/ole32';
export {
  decodeGuestNarrow,
  win32ModuleOf,
  WIN32_ADVAPI32,
  WIN32_DDRAW,
  WIN32_DDRAW_COM,
  WIN32_DPLAYX,
  WIN32_DPLAYX_COM,
  WIN32_DSOUND,
  WIN32_DSOUND_COM,
  WIN32_GDI32,
  WIN32_KERNEL32,
  WIN32_MSVFW32,
  WIN32_OLE32,
  WIN32_USER32,
  WIN32_WINMM,
  WIN32_WSOCK32,
} from './shim/text';
import {
  win32ModuleOf,
  WIN32_ADVAPI32,
  WIN32_DDRAW,
  WIN32_DDRAW_COM,
  WIN32_DPLAYX,
  WIN32_DPLAYX_COM,
  WIN32_DSOUND,
  WIN32_DSOUND_COM,
  WIN32_GDI32,
  WIN32_KERNEL32,
  WIN32_MSVFW32,
  WIN32_OLE32,
  WIN32_USER32,
  WIN32_WINMM,
  WIN32_WSOCK32,
} from './shim/text';
export { DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR } from './shim/state';
export type { PeImport } from './pe';

/** 纯共用 Win32 门面；具体游戏扩展由 `games/win32Shim.ts` 在外层组合。 */
const CommonWin32Shim = withOle32(
  withDplayx(
    withDirectx(
      withWinmm(
        withUser32(withGdi32(withKernel32(withShimGraphics(withShimSync(withShimGuestDll(withShimFiles(ShimState))))))),
      ),
    ),
  ),
);

export class Win32ShimBase extends CommonWin32Shim {
  dispatch(call: Win32Call): Win32Result | null {
    // _BinkClose 的重定向桩已经开始执行后再释放跨调用锁：若 DLL
    // 内部进口 Win32，本次 dispatch 仍处于 atomicGuestCall 的内层锁中；
    // 若没有进口，则这里已经是 BinkClose 返回后的下一条 Win32 调用。
    if (this.nativeBinkThreadReleasePending) {
      this.nativeBinkThreadReleasePending = false;
      this.releaseNativeBinkThread();
    }
    this.flushDestroyedWindows();
    const exclusive = this.dispatchExclusive(call);
    if (exclusive) return exclusive;
    const { key, name } = call.imported;
    const a = call.args;
    // 游戏专属的成功短路必须在 profile 登记；未知游戏即使导入同名 DLL 也停在边界。
    if (this.gameProfile.successfulImports?.includes(key)) return { eax: 0 };
    // Bink 过场：返回指向客体内存假 BINK 结构的有效句柄，并把 FrameNum 置为
    // >= Frames，使播放循环的 `FrameNum < Frames` 结束判定立即成立——视频视为
    // “已播完”，游戏沿原生路径推进。若 Open 返回空句柄，游戏仍建播放器并直读
    // [0x8]=Frames/[0xc]=FrameNum（空指针读到 IVT 垃圾值），`FrameNum<Frames`
    // 恒真形成 BinkWait/BinkGoto 死循环，加载屏永远无法退出。
    if (key.startsWith('BINKW32.DLL!')) {
      const exportName = key.slice(key.indexOf('!') + 1);
      // RA2/YR 会在每个影片窗口重复调用 SetSoundSystem，但旧 Bink DLL 的后端
      // 是进程级全局对象。第二次进入原生初始化会破坏已缓存回调（YR 可稳定触发
      // #UD）；保留第一次建立的 DirectSound 后端，后续调用按成功返回。
      if (exportName === '_BinkSetSoundSystem@8' && this.nativeBinkSoundSystemReady) {
        return { eax: 1 };
      }
      if (exportName === '_BinkOpen@8') {
        // 协作式 VM 不允许 Bink 后台 I/O 线程与解码调用真并行，使用其公开的
        // BINKNOTHREADEDIO 避免后台 I/O 线程；像素转换仍由原版 DLL 完成。
        this.writeU32(call.stack + 8, (a[1] ?? 0) | 0x0800_0000);
      }
      const binkHandle = a[0] ?? 0;
      const sourceFile =
        exportName === '_BinkOpen@8' && (a[1] ?? 0) & 0x0080_0000 ? this.fileHandles.get(a[0] ?? 0) : undefined;
      const sourceIsComplete =
        !!sourceFile &&
        (sourceFile.sharedMirror === true ||
          sourceFile.bytes.length >= sourceFile.size ||
          this.rangeBackedFiles.has(sourceFile.path));
      const nativeOpenAvailable =
        this.gameProfile.nativeBinkPlaybackLimit === undefined ||
        this.nativeBinkPlaybackOpens < this.gameProfile.nativeBinkPlaybackLimit;
      const useNativeBink =
        GUEST_BINK_SOUND_SETUP_EXPORTS.has(exportName) ||
        (exportName === '_BinkOpen@8'
          ? (!this.gameProfile.skipIncompleteBinkPlayback || sourceIsComplete) && nativeOpenAvailable
          : this.nativeBinkPlaybackActive);
      if (useNativeBink && GUEST_BINK_VIDEO_EXPORTS.has(exportName)) {
        if (exportName === '_BinkSetSoundSystem@8') {
          // 游戏传入的是 IAT/hypercall 桩里的 BinkOpenDirectSound 地址。原生 DLL 会
          // 缓存并在解码线程调用它；必须在进入客体 BinkSetSoundSystem 前改成真正
          // 的客体导出，否则宿主短路返回 0，影片有画面却永远不建立声音缓冲。
          const openDirectSound = this.loadGuestDll('BINKW32.DLL')?.exports.get('_BinkOpenDirectSound@4');
          if (openDirectSound) this.writeU32(call.stack + 4, openDirectSound);
        }
        // SetSoundSystem 与 BinkOpen 都会从 hypercall 返回到客体 DLL。仅靠动态
        // 桥开头的 CLI 仍留下“host 已返回、CLI 尚未执行”的一条指令窗口，PIT
        // 可在此切换线程并让 v86 的 IRQ 状态失配。声音初始化开始就固定当前
        // 客体线程，并一直保持到对应 BinkClose；Open 会复用同一固定深度。
        if (exportName === '_BinkSetSoundSystem@8' || exportName === '_BinkOpen@8') {
          this.pinNativeBinkThread();
        }
        if (exportName === '_BinkClose@4') {
          this.routeStaticGuestDllExports('BINKW32.DLL', DIRECT_NATIVE_BINK_EXPORTS, false);
          this.restoreDynamicGuestDllExports('BINKW32.DLL');
        }
        if (this.redirectGuestDllExport(call, 'BINKW32.DLL', exportName, true)) {
          if (exportName === '_BinkSetSoundSystem@8') {
            this.nativeBinkSoundSystemReady = true;
          } else if (exportName === '_BinkOpen@8') {
            this.nativeBinkPlaybackActive = true;
            this.nativeBinkPlaybackOpens++;
            this.routeStaticGuestDllExports('BINKW32.DLL', DIRECT_NATIVE_BINK_EXPORTS, true);
          } else if (exportName === '_BinkClose@4') {
            this.nativeBinkPlaybackActive = false;
            // 此刻只改写了返回地址，客体 BinkClose 尚未执行。保持外层锁，
            // 等关闭代码进入 atomicGuestCall（或已经完整返回后的下一进口）再放。
            this.nativeBinkThreadReleasePending = true;
            this.binkNextFrameAt.delete(binkHandle);
          } else if (DIRECT_NATIVE_BINK_EXPORTS.has(exportName)) {
            this.routeDynamicGuestDllExport(call, 'BINKW32.DLL', exportName);
          }
          return { eax: 0 };
        }
        if (exportName === '_BinkSetSoundSystem@8' || exportName === '_BinkOpen@8') {
          this.releaseNativeBinkThread();
        }
      }
      switch (key) {
        case 'BINKW32.DLL!_BinkSetSoundSystem@8':
          return { eax: 1 };
        case 'BINKW32.DLL!_BinkOpenDirectSound@4':
          return { eax: 0 };
        case 'BINKW32.DLL!_BinkGetError@0':
          return { eax: 0 };
        case 'BINKW32.DLL!_BinkOpen@8': {
          const handle = this.alloc(0x100, true);
          if (!handle) return { eax: 0 };
          this.writeU32(handle + 0x00, 640); // Width
          this.writeU32(handle + 0x04, 480); // Height
          this.writeU32(handle + 0x08, 1); // Frames
          this.writeU32(handle + 0x0c, 1); // FrameNum（>= Frames，立即完成）
          this.writeU32(handle + 0x10, 1); // LastFrameNum
          this.writeU32(handle + 0x14, 15); // FrameRate
          this.writeU32(handle + 0x18, 1); // FrameRateDiv（非零，避免算帧间隔时除零）
          this.binkVideos.add(handle);
          this.binkNextFrameAt.set(handle, this.clock.now());
          return { eax: handle };
        }
        // BinkWait 按帧率做 pacing：到点返回 0（帧就绪，游戏随之 DoFrame/NextFrame），
        // 否则返回 1（等待）。恒返回 1 会让视频更新虚函数永远返回 al=0，若调用方
        // 循环等待「播了一帧」就形成死循环（战场冻结的根因之一）。
        case 'BINKW32.DLL!_BinkWait@4': {
          const h = a[0] ?? 0;
          if (!this.binkVideos.has(h) && !this.nativeBinkPlaybackActive) return { eax: 0 };
          const now = this.clock.now();
          const next = this.binkNextFrameAt.get(h);
          if (next === undefined || now >= next) {
            const rate = this.readU32(h + 0x14) || 15;
            const div = this.readU32(h + 0x18) || 1;
            this.binkNextFrameAt.set(h, now + Math.max(1, Math.round((1000 * div) / rate)));
            return { eax: 0 };
          }
          return { eax: 1 };
        }
        case 'BINKW32.DLL!_BinkNextFrame@4': {
          const h = a[0] ?? 0;
          if (this.binkVideos.has(h)) {
            const frame = this.readU32(h + 0x0c) + 1;
            this.writeU32(h + 0x0c, frame);
            this.writeU32(h + 0x10, frame - 1);
          }
          return { eax: 0 };
        }
        case 'BINKW32.DLL!_BinkGoto@12': {
          // 循环背景视频会 seek 回第 1 帧；钳到不早于 Frames，保持“已播完”。
          const h = a[0] ?? 0;
          if (shimTraceEnabled('VM_TRACE_BINK')) {
            const caller = this.readU32(call.stack);
            console.log(`🎬 BinkGoto h=0x${h.toString(16)} 跳帧=${a[1]} 调用方=0x${caller.toString(16)}`);
          }
          if (this.binkVideos.has(h)) {
            const frames = this.readU32(h + 0x08);
            this.writeU32(h + 0x0c, Math.max(a[1] ?? 0, frames));
          }
          return { eax: 1 };
        }
        case 'BINKW32.DLL!_BinkClose@4': {
          const h = a[0] ?? 0;
          this.nativeBinkThreadReleasePending = false;
          this.releaseNativeBinkThread();
          this.binkVideos.delete(h);
          this.binkNextFrameAt.delete(h);
          return { eax: 0 };
        }
        case 'BINKW32.DLL!_BinkDoFrame@4':
          return { eax: 0 };
        case 'BINKW32.DLL!_BinkCopyToBuffer@28':
          return { eax: 1 };
        default:
          return { eax: 0 };
      }
    }
    if (key.startsWith('OLEAUT32.DLL!')) {
      switch (key) {
        case 'OLEAUT32.DLL!ord8': // VariantInit
          if (a[0]) this.zero(a[0], 16);
          return { eax: 0 };
        case 'OLEAUT32.DLL!ord9':
          return { eax: 0 }; // VariantClear
        case 'OLEAUT32.DLL!ord161': // LoadTypeLib：RA2 的可选 Automation 元数据不存在
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: 0x8002_9c4a }; // TYPE_E_CANTLOADLIBRARY
        case 'OLEAUT32.DLL!ord200': // GetErrorInfo
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: 1 }; // S_FALSE
        case 'OLEAUT32.DLL!ord201':
          return { eax: 0 }; // SetErrorInfo
        case 'OLEAUT32.DLL!ord33': // RegisterActiveObject
          if (a[3]) this.writeU32(a[3], 1);
          return { eax: 0 };
        case 'OLEAUT32.DLL!ord34':
          return { eax: 0 }; // RevokeActiveObject
        default:
          return { eax: 0x8000_4001 }; // E_NOTIMPL
      }
    }
    if (key === 'COMCTL32.DLL!DllGetVersion') {
      const info = a[0] ?? 0;
      if (!info || this.readU32(info) < 20) return { eax: 0x8000_4003 };
      this.writeU32(info + 4, 5);
      this.writeU32(info + 8, 81);
      this.writeU32(info + 12, 4916);
      this.writeU32(info + 16, 1); // DLLVER_PLATFORM_WINDOWS
      return { eax: 0 };
    }
    if (key.startsWith('COMCTL32.DLL!')) {
      switch (key) {
        case 'COMCTL32.DLL!ord17':
        case 'COMCTL32.DLL!ImageList_EndDrag':
          return { eax: 0 };
        case 'COMCTL32.DLL!ImageList_Destroy':
        case 'COMCTL32.DLL!ImageList_DragShowNolock':
        case 'COMCTL32.DLL!ImageList_DragMove':
        case 'COMCTL32.DLL!ImageList_DragEnter':
        case 'COMCTL32.DLL!ImageList_BeginDrag':
          return { eax: 1 };
      }
    }
    if (key.startsWith('IMM32.DLL!')) {
      switch (key) {
        // shim 不建立输入法上下文；禁用窗口 IME 时返回此前同样为空的 HIMC。
        case 'IMM32.DLL!ImmAssociateContext':
        case 'IMM32.DLL!ImmGetContext':
          return { eax: 0 };
        case 'IMM32.DLL!ImmGetCompositionStringA':
          return { eax: 0xffff_ffff };
        case 'IMM32.DLL!ImmGetCandidateListA':
          return { eax: 0 };
        case 'IMM32.DLL!ImmSetOpenStatus':
        case 'IMM32.DLL!ImmNotifyIME':
          return { eax: 1 };
      }
    }
    // 数值标签在装载时由 annotateWin32Modules 算好；手搓导入（冒烟脚本）走字符串回退。
    const module = call.imported.win32Module ?? win32ModuleOf(call.imported.dll);
    switch (module) {
      case WIN32_DDRAW_COM:
        return this.dispatchDirectDraw(call);
      case WIN32_DSOUND_COM:
        return this.dispatchDirectSound(call);
      case WIN32_KERNEL32:
        return this.dispatchKernel32(call, key, name, a);
      case WIN32_USER32:
        return this.dispatchUser32(call, key, name, a);
      case WIN32_GDI32:
        return this.dispatchGdi32(key, name, a);
      case WIN32_WINMM:
      case WIN32_ADVAPI32:
      case WIN32_MSVFW32:
        return this.dispatchWinmm(call, key, name, a);
      case WIN32_DDRAW:
      case WIN32_DSOUND:
        return this.dispatchDirectx(key, name, a);
      case WIN32_OLE32:
        return this.dispatchOle32(call, key, name, a);
      case WIN32_DPLAYX_COM:
        return this.dispatchDPlay(call);
      case WIN32_DPLAYX:
        return this.dispatchDplayx(key, name, a);
      case WIN32_WSOCK32: {
        if (shimTraceEnabled('VM_TRACE_WINSOCK')) {
          console.log(`🌐 ${key}(${a.map((v) => `0x${(v >>> 0).toString(16)}`).join(',')})`);
        }
        return this.dispatchGameWinsock(key, a);
      }
      default:
        return null;
    }
  }
  dispose(): void {
    this.disposeDplayTransport();
    this.disposeGameNetwork();
    // 页面退出时客体可能还持有句柄；最后再提交一次脏文件。
    for (const file of this.fileHandles.values()) this.flushFile(file);
    this.disposed = true;
    this.frameScheduled = false;
  }
  /** 调试用：显示 COLORREF 在当前离屏 surface 上实际选中的 8-bit 颜色。 */
  inspectGdiDc(handle: number): VmGdiDcSnapshot | null {
    const dc = this.gdiDcs.get(handle);
    const surface = dc ? this.surfaces.get(dc.surface) : undefined;
    if (!dc || !surface) return null;
    const palette = this.paletteForSurface(surface);
    const paletteIndex = this.nearestPaletteIndex(palette, dc.textColor);
    const offset = paletteIndex * 4;
    return {
      surface: surface.object,
      textColor: dc.textColor,
      paletteIndex,
      paletteColor: [palette[offset] ?? 0, palette[offset + 1] ?? 0, palette[offset + 2] ?? 0],
    };
  }
}

/** 可在客体直接返回的常量导入；这里只决定快速桩行为，不登记游戏 ABI。 */
const FAST_CONSTANT_IMPORTS: Readonly<Record<string, number>> = {
  // 当前兼容层对这些函数没有 host 副作用，可直接在客体返回常量。
  'KERNEL32.DLL!DeleteCriticalSection': 0,
  'KERNEL32.DLL!GlobalUnlock': 1,
  // 当前 shim 的 host 分支对这三项始终返回“指针有效”；RA2 战场加载会在同一
  // 对象数组上每秒重复数百次，直接客体返回可省掉无意义的串口/IRQ 往返。
  'KERNEL32.DLL!IsBadCodePtr': 0,
  'KERNEL32.DLL!IsBadReadPtr': 0,
  'KERNEL32.DLL!IsBadWritePtr': 0,
  'USER32.DLL!TranslateMessage': 1,
  // No dialog-manager work is performed by this in-guest constant stub.
  // TRUE would tell the caller that the MSG was already dispatched and makes
  // RA2 swallow every shell WM_PAINT/WM_TIMER before DispatchMessageA.
  'USER32.DLL!IsDialogMessageA': 0,
  // DefWindowProcA 不能走常量桩：退出链依赖它——WndProc 对 WM_CLOSE 走
  // DefWindowProcA，shim 在该分支执行 DestroyWindow→WM_DESTROY→PostQuitMessage。
  // 内联成 ret 0 会让这条链（以及真实 DefWindowProc 的其他语义）永远不执行。
  'DDRAW.COM!IDirectDraw.WaitForVerticalBlank': 0,
  'DDRAW.COM!IDirectDrawSurface.GetBltStatus': 0,
  'DDRAW.COM!IDirectDrawSurface.GetFlipStatus': 0,
  'DDRAW.COM!IDirectDrawSurface.IsLost': 0,
  'DDRAW.COM!IDirectDrawSurface.Restore': 0,
};

const FAST_FIRST_ARG_IMPORTS = new Set([
  'KERNEL32.DLL!GlobalHandle',
  'KERNEL32.DLL!GlobalLock',
  'USER32.DLL!SetCursor',
]);

/** 将等价的无副作用 API 留在客体执行，避免地图加载时数万次 VM↔JS 往返。 */
export function makeWin32ImportStub(dll: string, name: string, id: number, argBytes: number): Uint8Array {
  const key = `${dll.toUpperCase()}!${name}`;
  if (key === 'KERNEL32.DLL!Sleep') return makeFastSleepStub(id, argBytes);
  if (key === 'USER32.DLL!PeekMessageA') return makeFastPeekMessageStub(id, argBytes);
  if (key === 'USER32.DLL!GetCursorPos') return makeFastGetCursorPosStub(argBytes);
  // 窗口几何/属性只读查询：读 GUEST_WINDOW_TABLE 镜像，无效/不认识则回退 hypercall。
  if (key === 'USER32.DLL!GetClientRect') return makeFastGetClientRectStub(id, argBytes);
  if (key === 'USER32.DLL!GetWindowRect') return makeFastGetWindowRectStub(id, argBytes);
  if (key === 'USER32.DLL!ClientToScreen') return makeFastClientToScreenStub(id, argBytes);
  if (key === 'USER32.DLL!GetParent') return makeFastGetParentStub(id, argBytes);
  if (key === 'USER32.DLL!GetWindowLongA') return makeFastGetWindowLongStub(id, argBytes);
  return makeImportStub(id, argBytes);
}

/** 实验性高速 _lread 桩；默认不启用，需单独做完整关卡回归。 */
export function makeWin32ImportStubWithFastRead(dll: string, name: string, id: number, argBytes: number): Uint8Array {
  const key = `${dll.toUpperCase()}!${name}`;
  if (key === 'KERNEL32.DLL!Sleep') return makeFastSleepStub(id, argBytes);
  if (key === 'KERNEL32.DLL!_lread') return makeFastLegacyReadStub(id, argBytes);
  if (key === 'KERNEL32.DLL!ReadFile') return makeFastReadFileStub(id, argBytes);
  if (key === 'KERNEL32.DLL!SetFilePointer') return makeFastSetFilePointerStub(id, argBytes);
  if (key === 'KERNEL32.DLL!QueryPerformanceFrequency') return makeFastPerformanceFrequencyStub(argBytes);
  if (key === 'KERNEL32.DLL!QueryPerformanceCounter') return makeFastPerformanceCounterStub(argBytes);
  if (key === 'KERNEL32.DLL!GetLastError') return makeFastGetLastErrorStub(argBytes);
  if (key === 'KERNEL32.DLL!SetLastError') return makeFastSetLastErrorStub(argBytes);
  if (key === 'KERNEL32.DLL!TlsGetValue') return makeFastTlsGetValueStub(id, argBytes);
  if (
    key === 'KERNEL32.DLL!InitializeCriticalSection' ||
    key === 'KERNEL32.DLL!DeleteCriticalSection' ||
    key === 'KERNEL32.DLL!EnterCriticalSection' ||
    key === 'KERNEL32.DLL!LeaveCriticalSection'
  )
    return makeFastCriticalSectionStub(name, id, argBytes);
  if (key === 'USER32.DLL!ShowCursor') return makeFastShowCursorStub(argBytes);
  if (key === 'KERNEL32.DLL!InterlockedIncrement') return makeFastInterlockedStub(argBytes, 1);
  if (key === 'KERNEL32.DLL!InterlockedDecrement') return makeFastInterlockedStub(argBytes, -1);
  if (key === 'USER32.DLL!SetRect') return makeFastSetRectStub(argBytes);
  const constant = FAST_CONSTANT_IMPORTS[key];
  if (constant !== undefined) return makeConstantImportStub(constant, argBytes);
  if (FAST_FIRST_ARG_IMPORTS.has(key)) return makeFirstArgImportStub(argBytes);
  return makeWin32ImportStub(dll, name, id, argBytes);
}

/**
 * ShowCursor 维护 Win32 光标显示计数器：show 增加、隐藏减少，返回新值。
 * 不能是常量桩——RA2 载入时用 `while (ShowCursor(FALSE) >= 0);` 循环隐藏光标，
 * 恒返回 0 永远不满足 <0，主线程在「PLEASE STAND BY」界面死循环。
 * 计数器放客体共享页，菜单 hover 的高频调用仍无需跨 JS。
 */
function makeFastShowCursorStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const count = HYPERCALL_CURSOR_COUNT;
  const countBytes = () => emit32(count);
  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4]（show 标志）
  code.push(0x85, 0xc0); // test eax, eax
  code.push(0x74, 0x0e); // jz hide
  code.push(0xff, 0x05);
  countBytes(); // inc dword [count]
  code.push(0xa1);
  countBytes(); // mov eax, [count]
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  // hide:
  code.push(0xff, 0x0d);
  countBytes(); // dec dword [count]
  code.push(0xa1);
  countBytes(); // mov eax, [count]
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  return new Uint8Array(code);
}

/**
 * 空队列 PeekMessageA 的节流快速路径。host 在消息入队、定时器存在或预算耗尽时
 * 将共享预算清零；其余调用仅递减预算并返回 FALSE，周期性回 host 防止状态饿死。
 */
function makeFastPeekMessageStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  code.push(0xa1);
  emit32(HYPERCALL_PEEK_BUDGET); // mov eax, [budget]
  code.push(0x85, 0xc0); // test eax, eax
  code.push(0x0f, 0x84, 0, 0, 0, 0); // jz fallback
  const fallbackPatch = code.length - 4;
  code.push(0x48); // dec eax
  code.push(0xa3);
  emit32(HYPERCALL_PEEK_BUDGET); // mov [budget], eax
  code.push(0x31, 0xc0); // xor eax, eax（FALSE）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  const relative = fallback - (fallbackPatch + 4);
  code[fallbackPatch] = relative & 0xff;
  code[fallbackPatch + 1] = (relative >>> 8) & 0xff;
  code[fallbackPatch + 2] = (relative >>> 16) & 0xff;
  code[fallbackPatch + 3] = (relative >>> 24) & 0xff;
  return new Uint8Array(code);
}

/** GetCursorPos 直接读取 host 每次更新的共享坐标镜像。 */
function makeFastGetCursorPosStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（POINT*）
  code.push(0x85, 0xc9); // test ecx, ecx
  const nullJump = code.length;
  code.push(0x74, 0x00); // jz success（保持现有 shim 语义）
  code.push(0xa1);
  emit32(HYPERCALL_CURSOR_X); // mov eax, [cursorX]
  code.push(0x89, 0x01); // mov [ecx], eax
  code.push(0xa1);
  emit32(HYPERCALL_CURSOR_Y); // mov eax, [cursorY]
  code.push(0x89, 0x41, 0x04); // mov [ecx + 4], eax
  const success = code.length;
  code[nullJump + 1] = (success - (nullJump + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, TRUE
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  return new Uint8Array(code);
}

/**
 * InterlockedIncrement/Decrement 在战场渲染循环里被 COM 引用计数高频调用。
 * 用 lock xadd 单指令完成「读-加减-写回」，对单 CPU 客体原子（PIT 无法在指令
 * 中途抢占），eax 拿到旧值后再 ±1 得到返回值，与 host 语义一致且无需跨 JS。
 */
function makeFastInterlockedStub(argBytes: number, delta: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（ptr）
  code.push(0xb8);
  emit32(delta >>> 0); // mov eax, delta
  code.push(0xf0, 0x0f, 0xc1, 0x01); // lock xadd [ecx], eax（eax=旧值，[ecx]+=delta）
  code.push(delta > 0 ? 0x40 : 0x48); // inc/dec eax → 新值
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  return new Uint8Array(code);
}

/**
 * SetRect 在布局/命中测试里高频调用。纯写 4 个 int 到客体 RECT，无 host 状态。
 */
function makeFastSetRectStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（rect）
  code.push(0x85, 0xc9); // test ecx, ecx
  code.push(0x74, 0x1b); // jz done（rect==0 时跳过写入，偏移=27 字节写入序列）
  code.push(0x8b, 0x44, 0x24, 0x08); // mov eax, [esp + 8]（left）
  code.push(0x89, 0x01); // mov [ecx], eax
  code.push(0x8b, 0x44, 0x24, 0x0c); // mov eax, [esp + 0xc]（top）
  code.push(0x89, 0x41, 0x04); // mov [ecx + 4], eax
  code.push(0x8b, 0x44, 0x24, 0x10); // mov eax, [esp + 0x10]（right）
  code.push(0x89, 0x41, 0x08); // mov [ecx + 8], eax
  code.push(0x8b, 0x44, 0x24, 0x14); // mov eax, [esp + 0x14]（bottom）
  code.push(0x89, 0x41, 0x0c); // mov [ecx + 0xc], eax
  // done:
  code.push(0xb8, 0x01, 0x00, 0x00, 0x00); // mov eax, 1（TRUE）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  return new Uint8Array(code);
}

// ===== 窗口几何/属性只读查询的客体快速桩 =====
// GetClientRect/GetWindowRect/ClientToScreen/GetParent/GetWindowLongA 在 RA2 菜单
// 与战场循环里各被调用数万次，每次跨 VM↔JS 代价高。shim 已把窗口几何（绝对屏幕
// 坐标）与常用属性镜像到 GUEST_WINDOW_TABLE，这里直接读表。越界/未同步/不认识的
// index 一律回退完整 hypercall（makeImportStub），保证语义正确。

/** 把 [esp+4] 的 hwnd 换算成表项地址放进 ecx；无效则跳 fallback（返回补丁位置）。 */
function emitWindowEntryPreamble(code: number[]): number[] {
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const patches: number[] = [];
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（hwnd）
  code.push(0x81, 0xe9);
  emit32(0x2000); // sub ecx, 0x2000
  code.push(0x81, 0xf9);
  emit32(GUEST_WINDOW_TABLE_MAX); // cmp ecx, MAX
  code.push(0x0f, 0x83);
  patches.push(code.length);
  emit32(0); // jae fallback
  code.push(0xc1, 0xe1, 0x06); // shl ecx, 6（×GUEST_WINDOW_ENTRY_BYTES=64）
  code.push(0x81, 0xc1);
  emit32(GUEST_WINDOW_TABLE); // add ecx, TABLE
  code.push(0x83, 0x79, GUEST_WINDOW_VALID, 0x00); // cmp dword [ecx + VALID], 0
  code.push(0x0f, 0x84);
  patches.push(code.length);
  emit32(0); // je fallback
  return patches;
}

/** 把所有 rel32 fallback 跳转补丁到 fallback 地址。 */
function patchWindowFallbackJumps(code: number[], patches: number[], fallback: number): void {
  for (const at of patches) {
    const relative = fallback - (at + 4);
    code[at] = relative & 0xff;
    code[at + 1] = (relative >>> 8) & 0xff;
    code[at + 2] = (relative >>> 16) & 0xff;
    code[at + 3] = (relative >>> 24) & 0xff;
  }
}

/** GetClientRect(hwnd, rect*)：rect=(0,0,width,height)，恒返回 TRUE。 */
function makeFastGetClientRectStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（rect）
  code.push(0x85, 0xd2); // test edx, edx
  const jzRet = code.length;
  code.push(0x74, 0x00); // jz ret1（rect==0 只返回）
  code.push(0xc7, 0x02, 0, 0, 0, 0); // mov dword [edx], 0（left）
  code.push(0xc7, 0x42, 0x04, 0, 0, 0, 0); // mov dword [edx + 4], 0（top）
  code.push(0x8b, 0x41, GUEST_WINDOW_WIDTH); // mov eax, [ecx + WIDTH]
  code.push(0x89, 0x42, 0x08); // mov [edx + 8], eax（right）
  code.push(0x8b, 0x41, GUEST_WINDOW_HEIGHT); // mov eax, [ecx + HEIGHT]
  code.push(0x89, 0x42, 0x0c); // mov [edx + 12], eax（bottom）
  const ret1 = code.length;
  code[jzRet + 1] = (ret1 - (jzRet + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, 1
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** GetWindowRect(hwnd, rect*)：rect=(x,y,x+width,y+height)（绝对屏幕坐标），返回 TRUE。 */
function makeFastGetWindowRectStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（rect）
  code.push(0x85, 0xd2); // test edx, edx
  const jzRet = code.length;
  code.push(0x74, 0x00); // jz ret1
  code.push(0x8b, 0x41, GUEST_WINDOW_X); // mov eax, [ecx + X]
  code.push(0x89, 0x02); // mov [edx], eax（left）
  code.push(0x8b, 0x41, GUEST_WINDOW_Y); // mov eax, [ecx + Y]
  code.push(0x89, 0x42, 0x04); // mov [edx + 4], eax（top）
  code.push(0x8b, 0x41, GUEST_WINDOW_X); // mov eax, [ecx + X]
  code.push(0x03, 0x41, GUEST_WINDOW_WIDTH); // add eax, [ecx + WIDTH]
  code.push(0x89, 0x42, 0x08); // mov [edx + 8], eax（right）
  code.push(0x8b, 0x41, GUEST_WINDOW_Y); // mov eax, [ecx + Y]
  code.push(0x03, 0x41, GUEST_WINDOW_HEIGHT); // add eax, [ecx + HEIGHT]
  code.push(0x89, 0x42, 0x0c); // mov [edx + 12], eax（bottom）
  const ret1 = code.length;
  code[jzRet + 1] = (ret1 - (jzRet + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, 1
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** ClientToScreen(hwnd, point*)：point 加上窗口绝对屏幕原点，返回 TRUE。 */
function makeFastClientToScreenStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（point）
  code.push(0x85, 0xd2); // test edx, edx
  const jzRet = code.length;
  code.push(0x74, 0x00); // jz ret1
  code.push(0x8b, 0x41, GUEST_WINDOW_X); // mov eax, [ecx + X]
  code.push(0x01, 0x02); // add [edx], eax（point.x += x）
  code.push(0x8b, 0x41, GUEST_WINDOW_Y); // mov eax, [ecx + Y]
  code.push(0x01, 0x42, 0x04); // add [edx + 4], eax（point.y += y）
  const ret1 = code.length;
  code[jzRet + 1] = (ret1 - (jzRet + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, 1
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** GetParent(hwnd)：返回镜像的父 hwnd。 */
function makeFastGetParentStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x41, GUEST_WINDOW_PARENT); // mov eax, [ecx + PARENT]
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/**
 * GetWindowLongA(hwnd, index)：镜像常见 index——额外字节 0/4/8/12、GWL_ID(-12)、
 * GWL_STYLE(-16)、GWL_EXSTYLE(-20)、GWL_WNDPROC(-4)、GWL_USERDATA(-21)；其余回退。
 */
function makeFastGetWindowLongStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  const ret = () => code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  code.push(0x8b, 0x44, 0x24, 0x08); // mov eax, [esp + 8]（index）
  // 逐个识别负的 GWL_* index（每个不匹配跳过 6 字节的 load+ret）
  const negatives: Array<[number, number]> = [
    [0xfffffff4, GUEST_WINDOW_ID], // -12 GWL_ID
    [0xfffffff0, GUEST_WINDOW_STYLE], // -16 GWL_STYLE
    [0xffffffec, GUEST_WINDOW_EXSTYLE], // -20 GWL_EXSTYLE
    [0xfffffffc, GUEST_WINDOW_WNDPROC], // -4  GWL_WNDPROC
    [0xffffffeb, GUEST_WINDOW_USERDATA], // -21 GWL_USERDATA
  ];
  for (const [index, offset] of negatives) {
    code.push(0x83, 0xf8, index & 0xff); // cmp eax, imm8（符号扩展）
    code.push(0x75, 0x06); // jne 跳过下面 6 字节
    code.push(0x8b, 0x41, offset); // mov eax, [ecx + offset]
    ret();
  }
  // 正的窗口额外字节 0/4/8/12：offset = EXTRA0 + index
  code.push(0x83, 0xf8, 0x0c); // cmp eax, 12
  code.push(0x0f, 0x87);
  patches.push(code.length);
  code.push(0, 0, 0, 0); // ja fallback
  code.push(0xa8, 0x03); // test al, 3
  code.push(0x0f, 0x85);
  patches.push(code.length);
  code.push(0, 0, 0, 0); // jnz fallback
  code.push(0x8b, 0x44, 0x01, GUEST_WINDOW_EXTRA0); // mov eax, [ecx + eax + EXTRA0]
  ret();
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** 零时长 Sleep 使用固件 INT 0x30 立即轮转已就绪线程，不等待 PIT。
 * 与定时抢占共用上下文保存；不推进时钟、唤醒未到期线程或跳过锁。
 * 非零 Sleep 仍走完整 Win32 截止时间路径。 */
function makeFastSleepStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  code.push(0x83, 0x7c, 0x24, 0x04, 0x00); // cmp dword [esp + 4], 0
  code.push(0x0f, 0x85, 0, 0, 0, 0); // jne fallback
  const fallbackPatch = code.length - 4;
  // 持锁主动让出时也短暂开放硬件中断，使已到期 PIT 能更新休眠线程；
  // 否则 IF=0 的 Sleep(0) 忙等会永远冻结唤醒计数。返回后按锁深度恢复 IF。
  code.push(0xfb, 0xcd, 0x30, 0xfa); // sti; int 0x30; cli
  code.push(0xa1);
  emit32(HYPERCALL_THREAD_CURRENT); // eax=current id
  code.push(0x83, 0x3c, 0x85);
  emit32(GUEST_THREAD_CRITICAL_DEPTH);
  code.push(0x00);
  code.push(0x75, 0x01); // jne immediate
  code.push(0xfb); // 无锁时 sti
  code.push(0x31, 0xc0); // immediate: xor eax,eax
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  const relative = fallback - (fallbackPatch + 4);
  code[fallbackPatch] = relative & 0xff;
  code[fallbackPatch + 1] = (relative >>> 8) & 0xff;
  code[fallbackPatch + 2] = (relative >>> 16) & 0xff;
  code[fallbackPatch + 3] = (relative >>> 24) & 0xff;
  return new Uint8Array(code);
}

function makeFastGetLastErrorStub(argBytes: number): Uint8Array {
  return new Uint8Array([
    0xa1,
    HYPERCALL_LAST_ERROR & 0xff,
    (HYPERCALL_LAST_ERROR >>> 8) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 16) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 24) & 0xff,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

function makeFastSetLastErrorStub(argBytes: number): Uint8Array {
  return new Uint8Array([
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax, [esp + 4]
    0xa3,
    HYPERCALL_LAST_ERROR & 0xff,
    (HYPERCALL_LAST_ERROR >>> 8) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 16) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 24) & 0xff,
    0x31,
    0xc0,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

function makeFastTlsGetValueStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax, [esp + 4]
    0x3d,
    FAST_TLS_ENTRIES & 0xff,
    (FAST_TLS_ENTRIES >>> 8) & 0xff,
    (FAST_TLS_ENTRIES >>> 16) & 0xff,
    (FAST_TLS_ENTRIES >>> 24) & 0xff,
    0x73,
    0x13, // jae fallback
    0x8b,
    0x0d,
    0x68,
    0x00,
    0x06,
    0x00, // mov ecx,[current thread]
    0xc1,
    0xe1,
    0x08, // shl ecx,8 (每线程 64×DWORD)
    0x8b,
    0x84,
    0x81,
    FAST_TLS_TABLE & 0xff,
    (FAST_TLS_TABLE >>> 8) & 0xff,
    (FAST_TLS_TABLE >>> 16) & 0xff,
    (FAST_TLS_TABLE >>> 24) & 0xff,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ];
  code.push(...makeImportStub(id, argBytes));
  return new Uint8Array(code);
}

/**
 * RA2 启动时反复用 QPC 测 RDTSC，最多做 20 轮 1 秒忙等。若每次查询都跨到
 * JS，浏览器会花几十秒处理数百万次同步调用。共享计数器由 100Hz PIT 每次
 * 增加 10ms；此桩只读取，时间绝不能随查询次数推进。
 */
function makeFastPerformanceCounterStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]
  code.push(0x85, 0xc9); // test ecx, ecx
  code.push(0x74, 0x18); // je failure
  code.push(0xa1);
  emit32(HYPERCALL_QPC_LOW); // mov eax, [counter.low]
  code.push(0x8b, 0x15);
  emit32(HYPERCALL_QPC_HIGH); // mov edx, [counter.high]
  code.push(0x89, 0x01); // mov [ecx], eax
  code.push(0x89, 0x51, 0x04); // mov [ecx + 4], edx
  code.push(0xb8);
  emit32(1);
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  code.push(0x31, 0xc0); // failure: xor eax, eax
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  return new Uint8Array(code);
}

function makeFastPerformanceFrequencyStub(argBytes: number): Uint8Array {
  return new Uint8Array([
    0x8b,
    0x4c,
    0x24,
    0x04, // mov ecx, [esp + 4]
    0xc7,
    0x01,
    0xe8,
    0x03,
    0x00,
    0x00, // mov dword [ecx], 1000
    0xc7,
    0x41,
    0x04,
    0x00,
    0x00,
    0x00,
    0x00, // mov dword [ecx + 4], 0
    0xb8,
    0x01,
    0x00,
    0x00,
    0x00,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

/** ReadFile(handle, buffer, count, outCount, overlapped) 的同步只读快速路径。 */
function makeFastReadFileStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackBranches: number[] = [];
  const eofBranches: number[] = [];
  const readyBranches: number[] = [];
  const noCountBranches: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchBranches = (patches: number[], target: number) => {
    for (const displacement of patches) {
      const relative = target - (displacement + 4);
      code[displacement] = relative & 0xff;
      code[displacement + 1] = (relative >>> 8) & 0xff;
      code[displacement + 2] = (relative >>> 16) & 0xff;
      code[displacement + 3] = (relative >>> 24) & 0xff;
    }
  };

  // 异步 OVERLAPPED 读保留给 host；RA2/Blowfish 使用同步路径。
  code.push(0x83, 0x7c, 0x24, 0x14, 0x00); // cmp dword [esp + 20], 0
  branch(0x85, fallbackBranches); // jne fallback
  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4] (handle)
  code.push(0x2d);
  emit32(FAST_FILE_HANDLE_BASE);
  code.push(0x3d);
  emit32(FAST_FILE_TABLE_ENTRIES);
  branch(0x83, fallbackBranches); // jae fallback
  code.push(0xc1, 0xe0, 0x04); // shl eax, 4
  code.push(0x05);
  emit32(FAST_FILE_TABLE);
  code.push(0x83, 0x78, 0x0c, 0x01); // cmp dword [eax + 12], 1
  branch(0x85, fallbackBranches); // jne fallback
  code.push(0x8b, 0x50, 0x08); // mov edx, [eax + 8] (position)
  code.push(0x3b, 0x50, 0x04); // cmp edx, [eax + 4] (length)
  branch(0x83, eofBranches); // jae eof
  code.push(0x8b, 0x48, 0x04); // mov ecx, [eax + 4]
  code.push(0x29, 0xd1); // sub ecx, edx
  code.push(0x3b, 0x4c, 0x24, 0x0c); // cmp ecx, [esp + 12]
  branch(0x86, readyBranches); // jbe countReady
  code.push(0x8b, 0x4c, 0x24, 0x0c); // mov ecx, [esp + 12]
  const countReady = code.length;
  code.push(0x56, 0x57); // push esi; push edi
  code.push(0x8b, 0x30); // mov esi, [eax]
  code.push(0x01, 0xd6); // add esi, edx
  code.push(0x8b, 0x7c, 0x24, 0x10); // mov edi, [esp + 16] (原 buffer)
  code.push(0x01, 0xca); // add edx, ecx
  code.push(0x89, 0x50, 0x08); // mov [eax + 8], edx
  code.push(0x8b, 0x54, 0x24, 0x18); // mov edx, [esp + 24] (原 outCount)
  code.push(0x85, 0xd2); // test edx, edx
  branch(0x84, noCountBranches); // je copy
  code.push(0x89, 0x0a); // mov [edx], ecx
  const copy = code.length;
  code.push(0xfc, 0xf3, 0xa4); // cld; rep movsb
  code.push(0x5f, 0x5e); // pop edi; pop esi
  code.push(0xb8);
  emit32(1); // TRUE
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const eof = code.length;
  code.push(0x8b, 0x54, 0x24, 0x10); // mov edx, [esp + 16] (outCount)
  code.push(0x85, 0xd2); // test edx, edx
  const eofNoCountBranches: number[] = [];
  branch(0x84, eofNoCountBranches); // je eofReturn
  code.push(0xc7, 0x02);
  emit32(0); // mov dword [edx], 0
  const eofReturn = code.length;
  code.push(0xb8);
  emit32(1);
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchBranches(readyBranches, countReady);
  patchBranches(noCountBranches, copy);
  patchBranches(eofBranches, eof);
  patchBranches(eofNoCountBranches, eofReturn);
  patchBranches(fallbackBranches, fallback);
  return new Uint8Array(code);
}

/** SetFilePointer 的 32-bit 同步快速路径；大偏移/非法模式仍交回 host。 */
function makeFastSetFilePointerStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackBranches: number[] = [];
  const beginBranches: number[] = [];
  const currentBranches: number[] = [];
  const endBranches: number[] = [];
  const commitBranches: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const jump = (patches: number[]) => {
    code.push(0xe9, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchBranches = (patches: number[], target: number) => {
    for (const displacement of patches) {
      const relative = target - (displacement + 4);
      code[displacement] = relative & 0xff;
      code[displacement + 1] = (relative >>> 8) & 0xff;
      code[displacement + 2] = (relative >>> 16) & 0xff;
      code[displacement + 3] = (relative >>> 24) & 0xff;
    }
  };

  code.push(0x83, 0x7c, 0x24, 0x0c, 0x00); // cmp dword [esp + 12], 0 (high ptr)
  branch(0x85, fallbackBranches);
  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4]
  code.push(0x2d);
  emit32(FAST_FILE_HANDLE_BASE);
  code.push(0x3d);
  emit32(FAST_FILE_TABLE_ENTRIES);
  branch(0x83, fallbackBranches);
  code.push(0xc1, 0xe0, 0x04);
  code.push(0x05);
  emit32(FAST_FILE_TABLE);
  code.push(0x83, 0x78, 0x0c, 0x01);
  branch(0x85, fallbackBranches);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8] (signed distance)
  code.push(0x83, 0x7c, 0x24, 0x10, 0x00); // cmp method, FILE_BEGIN
  branch(0x84, beginBranches);
  code.push(0x83, 0x7c, 0x24, 0x10, 0x01); // cmp method, FILE_CURRENT
  branch(0x84, currentBranches);
  code.push(0x83, 0x7c, 0x24, 0x10, 0x02); // cmp method, FILE_END
  branch(0x84, endBranches);
  jump(fallbackBranches);

  const begin = code.length;
  code.push(0x85, 0xd2); // test edx, edx
  branch(0x88, fallbackBranches); // js fallback
  jump(commitBranches);

  const current = code.length;
  code.push(0x03, 0x50, 0x08); // add edx, [eax + 8]
  code.push(0x85, 0xd2);
  branch(0x88, fallbackBranches);
  jump(commitBranches);

  const end = code.length;
  code.push(0x03, 0x50, 0x04); // add edx, [eax + 4]
  code.push(0x85, 0xd2);
  branch(0x88, fallbackBranches);
  jump(commitBranches);

  const commit = code.length;
  code.push(0x89, 0x50, 0x08); // mov [eax + 8], edx
  code.push(0x89, 0xd0); // mov eax, edx
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));

  patchBranches(beginBranches, begin);
  patchBranches(currentBranches, current);
  patchBranches(endBranches, end);
  patchBranches(commitBranches, commit);
  patchBranches(fallbackBranches, fallback);
  return new Uint8Array(code);
}

/**
 * _lread 是地图加载的最大静态边界之一：原版会数万次读 1/2/4 字节字段。
 * 已镜像的只读文件在客体内 rep movsb；其他句柄跳回原 hypercall 桩。
 */
function makeFastLegacyReadStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackBranches: number[] = [];
  const eofBranches: number[] = [];
  const readyBranches: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchBranches = (patches: number[], target: number) => {
    for (const displacement of patches) {
      const relative = target - (displacement + 4);
      code[displacement] = relative & 0xff;
      code[displacement + 1] = (relative >>> 8) & 0xff;
      code[displacement + 2] = (relative >>> 16) & 0xff;
      code[displacement + 3] = (relative >>> 24) & 0xff;
    }
  };

  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4] (handle)
  code.push(0x2d);
  emit32(FAST_FILE_HANDLE_BASE); // sub eax, handle base
  code.push(0x3d);
  emit32(FAST_FILE_TABLE_ENTRIES); // cmp eax, entry count
  branch(0x83, fallbackBranches); // jae fallback
  code.push(0xc1, 0xe0, 0x04); // shl eax, 4
  code.push(0x05);
  emit32(FAST_FILE_TABLE); // add eax, table
  code.push(0x83, 0x78, 0x0c, 0x01); // cmp dword [eax + 12], 1
  branch(0x85, fallbackBranches); // jne fallback
  code.push(0x8b, 0x50, 0x08); // mov edx, [eax + 8] (position)
  code.push(0x3b, 0x50, 0x04); // cmp edx, [eax + 4] (length)
  branch(0x83, eofBranches); // jae eof
  code.push(0x8b, 0x48, 0x04); // mov ecx, [eax + 4]
  code.push(0x29, 0xd1); // sub ecx, edx (remaining)
  code.push(0x3b, 0x4c, 0x24, 0x0c); // cmp ecx, [esp + 12] (requested)
  branch(0x86, readyBranches); // jbe countReady
  code.push(0x8b, 0x4c, 0x24, 0x0c); // mov ecx, [esp + 12]
  const countReady = code.length;
  code.push(0x56, 0x57); // push esi; push edi
  code.push(0x8b, 0x30); // mov esi, [eax]
  code.push(0x01, 0xd6); // add esi, edx
  code.push(0x8b, 0x7c, 0x24, 0x10); // mov edi, [esp + 16] (buffer after push esi/edi)
  code.push(0x01, 0xca); // add edx, ecx
  code.push(0x89, 0x50, 0x08); // mov [eax + 8], edx
  code.push(0x89, 0xc8); // mov eax, ecx (return count before rep consumes ecx)
  code.push(0xfc, 0xf3, 0xa4); // cld; rep movsb
  code.push(0x5f, 0x5e); // pop edi; pop esi
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const eof = code.length;
  code.push(0x31, 0xc0); // xor eax, eax
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchBranches(readyBranches, countReady);
  patchBranches(eofBranches, eof);
  patchBranches(fallbackBranches, fallback);
  return new Uint8Array(code);
}

/** 无竞争的临界区仅在更新结构时 CLI；有竞争或等待者时交给 host 调度。 */
function makeFastCriticalSectionStub(name: string, id: number, argBytes: number): Uint8Array {
  if (name === 'DeleteCriticalSection') return makeImportStub(id, argBytes);
  const code: number[] = [];
  const emit32 = (value: number) => code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const store = (offset: number, value: number) => {
    code.push(0xc7, 0x40, offset);
    emit32(value);
  };
  const branches: number[] = [];
  const fallbackIf = (condition: number) => {
    code.push(0x0f, condition);
    branches.push(code.length);
    emit32(0);
  };
  code.push(0x8b, 0x44, 0x24, 0x04, 0x85, 0xc0); // mov eax,[esp+4]; test eax,eax
  fallbackIf(0x84);
  code.push(0xfa); // cli，仅保护结构更新
  if (name === 'InitializeCriticalSection') {
    for (const offset of [0, 4, 8, 12, 16, 20]) store(offset, offset === 4 ? 0xffff_ffff : 0);
  } else {
    code.push(0x8b, 0x0d);
    emit32(HYPERCALL_THREAD_CURRENT);
    code.push(0x41); // ecx = Win32 thread id
    if (name === 'EnterCriticalSection') {
      code.push(0x83, 0x78, 0x0c, 0x00, 0x74, 0x09); // owner=0 时跳过 owner 比较
      code.push(0x39, 0x48, 0x0c); // cmp [eax+12],ecx
      fallbackIf(0x85);
      code.push(0x89, 0x48, 0x0c, 0xff, 0x40, 0x08, 0xff, 0x40, 0x04);
    } else {
      code.push(0x39, 0x48, 0x0c);
      fallbackIf(0x85); // 只有 owner 可以 Leave
      code.push(0x83, 0x78, 0x10, 0);
      fallbackIf(0x85); // 有等待者时由 host 唤醒
      code.push(0x83, 0x78, 0x08, 0);
      fallbackIf(0x84);
      code.push(0xff, 0x48, 0x04, 0xff, 0x48, 0x08, 0x75, 0x07); // dec lock; dec recursion; jnz done
      store(12, 0);
    }
  }
  code.push(0x31, 0xc0); // void API 的确定性返回值
  code.push(0x8b, 0x0d);
  emit32(HYPERCALL_THREAD_CURRENT);
  code.push(0x83, 0x3c, 0x8d);
  emit32(GUEST_THREAD_CRITICAL_DEPTH);
  code.push(0);
  code.push(0x75, 0x01, 0xfb, 0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  for (const at of branches) {
    const relative = fallback - (at + 4);
    for (let i = 0; i < 4; i++) code[at + i] = (relative >>> (i * 8)) & 0xff;
  }
  return new Uint8Array(code);
}

/**
 * 第一阶段 Win32 兼容层：足以运行 MSVC CRT 初始化，并在首个未实现 API 处精确暂停。
 * 不对未实现 API 猜测返回值，否则错误会在几千条指令后才显现。
 */
export function readStackArgs(memory: GuestMemory, stack: number, argBytes: number): number[] {
  const count = argBytes >>> 2;
  if (count === 0) return [];
  const b = memory.read_memory(stack + 4, count * 4); // [esp] 是 import stub 的返回地址
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    out.push((b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0);
  }
  return out;
}

/** PE 装载后给每个导入算好 DLL 数值标签，让 dispatch 不做字符串解析。 */
export function annotateWin32Modules(importList: PeImport[]): void {
  for (const imported of importList) imported.win32Module = win32ModuleOf(imported.dll);
}
