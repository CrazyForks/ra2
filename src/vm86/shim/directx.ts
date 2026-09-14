import type { PaletteState, SoundBufferState, SurfaceState, Win32Call, Win32Result } from '../win32';
import { DEFAULT_PCM_FORMAT, parsePcmWaveFormatEx, type PcmWaveFormat } from '../audio';
import {
  HYPERCALL_ACTIVE_SHELL_SURFACE,
  HYPERCALL_CALLBACK_DEPTH,
  makeConstantImportStub,
  makeImportStub,
  type PeImport,
} from '../pe';
import { win32ModuleOf } from './text';
import { withWinmm } from './winmm';
import type { Constructor } from './state';

type WinmmChain = InstanceType<ReturnType<typeof withWinmm>>;

export const DDRAW_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['Compact', 4],
  ['CreateClipper', 16],
  ['CreatePalette', 20],
  ['CreateSurface', 16],
  ['DuplicateSurface', 12],
  ['EnumDisplayModes', 20],
  ['EnumSurfaces', 20],
  ['FlipToGDISurface', 4],
  ['GetCaps', 12],
  ['GetDisplayMode', 8],
  ['GetFourCCCodes', 12],
  ['GetGDISurface', 8],
  ['GetMonitorFrequency', 8],
  ['GetScanLine', 8],
  ['GetVerticalBlankStatus', 8],
  ['Initialize', 8],
  ['RestoreDisplayMode', 4],
  ['SetCooperativeLevel', 12],
  ['SetDisplayMode', 16],
  ['WaitForVerticalBlank', 12],
];

export const DSOUND_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['CreateSoundBuffer', 16],
  ['GetCaps', 8],
  ['DuplicateSoundBuffer', 12],
  ['SetCooperativeLevel', 12],
  ['Compact', 4],
  ['GetSpeakerConfig', 8],
  ['SetSpeakerConfig', 8],
  ['Initialize', 8],
];

const SURFACE_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['AddAttachedSurface', 8],
  ['AddOverlayDirtyRect', 8],
  ['Blt', 24],
  ['BltBatch', 12],
  ['BltFast', 24],
  ['DeleteAttachedSurface', 12],
  ['EnumAttachedSurfaces', 12],
  ['EnumOverlayZOrders', 16],
  ['Flip', 12],
  ['GetAttachedSurface', 12],
  ['GetBltStatus', 8],
  ['GetCaps', 8],
  ['GetClipper', 8],
  ['GetColorKey', 12],
  ['GetDC', 8],
  ['GetFlipStatus', 8],
  ['GetOverlayPosition', 12],
  ['GetPalette', 8],
  ['GetPixelFormat', 8],
  ['GetSurfaceDesc', 8],
  ['Initialize', 12],
  ['IsLost', 4],
  ['Lock', 20],
  ['ReleaseDC', 8],
  ['Restore', 4],
  ['SetClipper', 8],
  ['SetColorKey', 12],
  ['SetOverlayPosition', 12],
  ['SetPalette', 8],
  ['Unlock', 8],
  ['UpdateOverlay', 24],
  ['UpdateOverlayDisplay', 8],
  ['UpdateOverlayZOrder', 12],
];

const PALETTE_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['GetCaps', 8],
  ['GetEntries', 20],
  ['Initialize', 16],
  ['SetEntries', 20],
];

const CLIPPER_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['GetClipList', 16],
  ['GetHWnd', 8],
  ['Initialize', 12],
  ['IsClipListChanged', 8],
  ['SetClipList', 12],
  ['SetHWnd', 12],
];

const SOUND_BUFFER_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['GetCaps', 8],
  ['GetCurrentPosition', 12],
  ['GetFormat', 16],
  ['GetVolume', 8],
  ['GetPan', 8],
  ['GetFrequency', 8],
  ['GetStatus', 8],
  ['Initialize', 12],
  ['Lock', 32],
  ['Play', 16],
  ['SetCurrentPosition', 8],
  ['SetFormat', 8],
  ['SetVolume', 8],
  ['SetPan', 8],
  ['SetFrequency', 8],
  ['Stop', 4],
  ['Unlock', 20],
  ['Restore', 4],
];

/**
 * 无副作用、host 分支只返回常量的 COM 方法。这些方法的 vtable 槽直接生成客体内
 * 常量桩（见 createComObject），消除战场渲染循环里每帧数万次的 VM↔JS 往返。
 * 只收录「返回常量且无任何 host 状态读写」的方法；Lock/Unlock/Blt 等会触碰
 * surface.dirty / emitFrame 的方法必须保留完整 hypercall 桩。
 */
const CONSTANT_COM_METHODS: ReadonlyMap<string, number> = new Map([
  ['IDirectDrawSurface.IsLost', 0],
  ['IDirectDrawSurface.Restore', 0],
  ['IDirectDrawSurface.GetBltStatus', 0],
  ['IDirectDrawSurface.GetFlipStatus', 0],
  ['IDirectDraw.WaitForVerticalBlank', 0],
]);

const DIRECTDRAW_VBLANK_MS = 1000 / 60;
const DDSCAPS_PRIMARYSURFACE = 0x0000_0200;
/** IDirectSoundBuffer 客体对象尾部的播放游标缓存。vtable/refcount 仍占前 8 字节。 */
const SOUND_POSITION_CACHE = 8;
const SOUND_POSITION_BUDGET = 12;
// Bink 会在解码线程中极高频轮询播放游标。63 次缓存命中仍会造成约
// 2,300 次/秒的 Worker→主线程查询；1023 次对应约 140 次/秒，游标刷新
// 间隔仍低于一帧，但能避免 WebAudio 消息队列被轮询淹没而偶发断音。
const SOUND_POSITION_FAST_BUDGET = 1023;
/** RA2 surface 对象尾部缓存完整 DDSURFACEDESC，供 Lock 客体桩直接复制。 */
const SURFACE_DESC_CACHE = 8;
const SURFACE_DESC_BYTES = 108;
const SURFACE_UNLOCK_MODE = SURFACE_DESC_CACHE + SURFACE_DESC_BYTES;
const SURFACE_UNLOCK_BUDGET = SURFACE_UNLOCK_MODE + 4;
const SURFACE_OBJECT_BYTES = SURFACE_UNLOCK_BUDGET + 4;
const SURFACE_UNLOCK_FAST_BUDGET = 7;
const SURFACE_UNLOCK_GENERIC = 0;
const SURFACE_UNLOCK_SHELL = 1;
const SURFACE_UNLOCK_PRIMARY = 2;

/** COM 接口数值标签：createComObject 时预计算进 PeImport.comTag，
 *  让 dispatch 按数值路由而不是每次调用的 startsWith 字符串链。 */
const COM_TAG_DIRECTDRAW = 1;
const COM_TAG_SURFACE = 2;
const COM_TAG_CLIPPER = 3;
const COM_TAG_PALETTE = 4;
const COM_TAG_SOUND = 5;
const COM_TAG_SOUND_BUFFER = 6;

function comTagOf(interfaceName: string): number | undefined {
  switch (interfaceName) {
    case 'IDirectDraw':
      return COM_TAG_DIRECTDRAW;
    case 'IDirectDrawSurface':
      return COM_TAG_SURFACE;
    case 'IDirectDrawClipper':
      return COM_TAG_CLIPPER;
    case 'IDirectDrawPalette':
      return COM_TAG_PALETTE;
    case 'IDirectSound':
      return COM_TAG_SOUND;
    case 'IDirectSoundBuffer':
      return COM_TAG_SOUND_BUFFER;
    default:
      return undefined;
  }
}

/**
 * GetCurrentPosition 的缓存快速桩：大多数轮询直接回放最近一次 host 计算的游标，
 * 预算耗尽后回退 hypercall 刷新。这样仍以宿主单调时钟/WebAudio 状态为准，同时
 * 避免 RA2 音乐线程每秒数千次 VM↔JS 往返。
 */
function makeCachedSoundPositionStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（this）
  code.push(0x85, 0xc9); // test ecx, ecx
  code.push(0x0f, 0x84, 0, 0, 0, 0); // jz fallback
  const nullPatch = code.length - 4;
  code.push(0x83, 0x79, SOUND_POSITION_BUDGET, 0x00); // cmp dword [ecx + budget], 0
  code.push(0x0f, 0x84, 0, 0, 0, 0); // je fallback
  const budgetPatch = code.length - 4;
  code.push(0xff, 0x49, SOUND_POSITION_BUDGET); // dec dword [ecx + budget]
  code.push(0x8b, 0x41, SOUND_POSITION_CACHE); // mov eax, [ecx + position]
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（play cursor out）
  code.push(0x85, 0xd2); // test edx, edx
  const firstNull = code.length;
  code.push(0x74, 0x00); // jz second
  code.push(0x89, 0x02); // mov [edx], eax
  const second = code.length;
  code[firstNull + 1] = (second - (firstNull + 2)) & 0xff;
  code.push(0x8b, 0x54, 0x24, 0x0c); // mov edx, [esp + 12]（write cursor out）
  code.push(0x85, 0xd2); // test edx, edx
  const secondNull = code.length;
  code.push(0x74, 0x00); // jz success
  code.push(0x89, 0x02); // mov [edx], eax
  const success = code.length;
  code[secondNull + 1] = (success - (secondNull + 2)) & 0xff;
  code.push(0x31, 0xc0); // xor eax, eax（DS_OK）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  for (const patch of [nullPatch, budgetPatch]) {
    const relative = fallback - (patch + 4);
    code[patch] = relative & 0xff;
    code[patch + 1] = (relative >>> 8) & 0xff;
    code[patch + 2] = (relative >>> 16) & 0xff;
    code[patch + 3] = (relative >>> 24) & 0xff;
  }
  return new Uint8Array(code);
}

/**
 * RA2 的 Lock host 分支只写固定 DDSURFACEDESC。客体桩从 surface 对象尾部复制
 * 27 个 DWORD；Unlock 仍逐次进入 host，保留画面提交和输入/Worker 让步边界。
 */
function makeCachedSurfaceLockStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackPatches: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  const fallbackBranch = (condition: number) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    fallbackPatches.push(code.length - 4);
  };

  code.push(0x56, 0x57); // push esi; push edi（callee-saved）
  code.push(0x8b, 0x74, 0x24, 0x0c); // mov esi, [esp + 12]（原 this）
  code.push(0x85, 0xf6); // test esi, esi
  fallbackBranch(0x84); // je fallback
  code.push(0x81, 0x7e, SURFACE_DESC_CACHE);
  emit32(SURFACE_DESC_BYTES); // cached dwSize == 108
  fallbackBranch(0x85); // jne fallback
  code.push(0x8b, 0x7c, 0x24, 0x14); // mov edi, [esp + 20]（原 desc out）
  code.push(0x85, 0xff); // test edi, edi
  const noOutput = code.length;
  code.push(0x74, 0x00); // je success
  code.push(0x83, 0xc6, SURFACE_DESC_CACHE); // add esi, cache
  code.push(0xb9);
  emit32(SURFACE_DESC_BYTES / 4); // mov ecx, 27
  code.push(0xfc, 0xf3, 0xa5); // cld; rep movsd
  const success = code.length;
  code[noOutput + 1] = (success - (noOutput + 2)) & 0xff;
  code.push(0x5f, 0x5e); // pop edi; pop esi
  code.push(0x31, 0xc0); // xor eax, eax（DD_OK）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const fallback = code.length;
  code.push(0x5f, 0x5e); // 恢复寄存器后走普通 hypercall
  code.push(...makeImportStub(id, argBytes));
  for (const patch of fallbackPatches) {
    const relative = fallback - (patch + 4);
    code[patch] = relative & 0xff;
    code[patch + 1] = (relative >>> 8) & 0xff;
    code[patch + 2] = (relative >>> 16) & 0xff;
    code[patch + 3] = (relative >>> 24) & 0xff;
  }
  return new Uint8Array(code);
}

/**
 * 非 primary surface 的 Unlock 最多连续 7 次留在客体，第 8 次强制回 host。
 * shell surface 还必须等于 host 当前活跃层，否则立即回 host 完成换层。
 */
function makeBudgetedSurfaceUnlockStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackPatches: number[] = [];
  const fastPatches: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchAll = (patches: number[], target: number) => {
    for (const patch of patches) {
      const relative = target - (patch + 4);
      code[patch] = relative & 0xff;
      code[patch + 1] = (relative >>> 8) & 0xff;
      code[patch + 2] = (relative >>> 16) & 0xff;
      code[patch + 3] = (relative >>> 24) & 0xff;
    }
  };

  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（this）
  code.push(0x85, 0xc9); // test ecx, ecx
  branch(0x84, fallbackPatches); // je fallback
  code.push(0x81, 0x79, SURFACE_DESC_CACHE);
  emit32(SURFACE_DESC_BYTES);
  branch(0x85, fallbackPatches); // 非 RA2 扩展对象
  code.push(0x83, 0x79, SURFACE_UNLOCK_MODE, SURFACE_UNLOCK_PRIMARY); // cmp mode, primary
  branch(0x84, fallbackPatches);
  code.push(0x83, 0x79, SURFACE_UNLOCK_MODE, SURFACE_UNLOCK_SHELL); // cmp mode, shell
  branch(0x85, fastPatches); // generic → budget
  code.push(0x3b, 0x0d);
  emit32(HYPERCALL_ACTIVE_SHELL_SURFACE); // cmp ecx, [activeShell]
  branch(0x85, fallbackPatches); // shell 换层必须进 host

  const fast = code.length;
  code.push(0x83, 0x79, SURFACE_UNLOCK_BUDGET, 0x00); // cmp budget, 0
  branch(0x84, fallbackPatches);
  code.push(0xff, 0x49, SURFACE_UNLOCK_BUDGET); // dec budget
  code.push(0x31, 0xc0); // xor eax, eax（DD_OK）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchAll(fastPatches, fast);
  patchAll(fallbackPatches, fallback);
  return new Uint8Array(code);
}

/** DirectX 的 Win32 API case（原 Win32Shim.dispatch 主 switch 拆分）。 */
export function withDirectx<TBase extends Constructor<WinmmChain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    /** 上一次 vblank 节拍（host 时钟，ms）——60Hz 节拍对齐用，见 WaitForVerticalBlank。 */
    private lastVblankHostMs = 0;
    /** 原版战场循环会连续调用两次 BLOCKBEGIN；一对调用只应消耗一个刷新周期。 */
    private vblankPairSecondCall = false;
    private readonly clipperWindows = new Map<number, number>();

    dispatchDirectx(key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'DDRAW.DLL!DirectDrawCreate': {
          if (!a[1]) return { eax: 0x8000_4003 }; // E_POINTER
          const object = this.createComObject('IDirectDraw', DDRAW_METHODS);
          this.writeU32(a[1], object);
          return { eax: 0 }; // DD_OK
        }
        case 'DSOUND.DLL!ord1': {
          if (!a[1]) return { eax: 0x8000_4003 };
          const object = this.createComObject('IDirectSound', DSOUND_METHODS, 'DSOUND.COM');
          this.writeU32(a[1], object);
          return { eax: 0 };
        }
        default:
          void name;
          return null;
      }
    }
    protected dispatchDirectDraw(call: Win32Call): Win32Result | null {
      const key = call.imported.key;
      const a = call.args;
      // 动态 COM 桩带预计算标签/方法名（PeImport.comTag/method）；手搓导入回退字符串解析。
      const tag = call.imported.comTag;
      const method = call.imported.method ?? key.slice(key.lastIndexOf('.') + 1);
      const thisPtr = a[0] ?? 0;

      if (method === 'QueryInterface') {
        if (a[2]) this.writeU32(a[2], thisPtr);
        this.addComRef(thisPtr);
        return { eax: 0 };
      }
      if (method === 'AddRef') return { eax: this.addComRef(thisPtr) };
      if (method === 'Release') {
        const refs = this.releaseComObject(thisPtr);
        if (!refs) this.clipperWindows.delete(thisPtr);
        return { eax: refs };
      }

      if (tag === COM_TAG_DIRECTDRAW || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDraw.'))) {
        switch (method) {
          case 'GetCaps': {
            for (const caps of [a[1] ?? 0, a[2] ?? 0]) {
              if (!caps) continue;
              const size = this.readU32(caps);
              this.zero(caps, Math.min(Math.max(size, 4), 0x180));
              this.writeU32(caps, size);
              // 软件 8-bit Blt/色键/调色板能力；不宣称 3D/overlay，避免游戏选错路径。
              this.writeU32(caps + 4, 0x0440_81c0);
              this.writeU32(caps + 0x30, 64 * 1024 * 1024);
              this.writeU32(caps + 0x34, 48 * 1024 * 1024);
            }
            return { eax: 0 };
          }
          case 'SetCooperativeLevel':
            return { eax: 0 };
          case 'SetDisplayMode': {
            const width = a[1] | 0;
            const height = a[2] | 0;
            const bpp = a[3] | 0;
            // RA2 原生走 16-bit RGB565。尺寸不硬编码为 640×480：经典游戏的
            // INI/命令行会请求 800×600 乃至更大模式，浏览器画布可直接承接。
            if ((bpp !== 8 && bpp !== 16) || width < 320 || width > 2560 || height < 200 || height > 1600) {
              return { eax: 0x8876_008a }; // DDERR_INVALIDMODE
            }
            this.displayWidth = width;
            this.displayHeight = height;
            this.displayBpp = bpp;
            this.setCursorPosition(this.cursorX, this.cursorY);
            return { eax: 0 };
          }
          case 'RestoreDisplayMode':
          case 'FlipToGDISurface':
            return { eax: 0 };
          case 'EnumDisplayModes': {
            const callback = a[4] ?? 0;
            if (!callback) return { eax: 0x8000_4003 };
            const desc = this.alloc(108, true);
            this.writeSurfaceDesc(desc, {
              object: 0,
              width: this.displayWidth,
              height: this.displayHeight,
              pitch: (this.displayWidth * (this.displayBpp >>> 3) + 3) & ~3,
              bpp: this.displayBpp,
              pixels: 0,
              caps: 0x200,
              palette: 0,
              attached: 0,
              sourceColorKey: null,
              destinationColorKey: null,
              textRuns: [],
              lastDrawSerial: 0,
              dirty: false,
            });
            const originalReturn = this.readU32(call.stack);
            const code: number[] = [];
            const emit32 = (value: number) =>
              code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
            const push = (value: number) => {
              code.push(0x68);
              emit32(value);
            };
            code.push(0xff, 0x05);
            emit32(HYPERCALL_CALLBACK_DEPTH);
            push(a[3] ?? 0);
            push(desc);
            code.push(0xb8);
            emit32(callback);
            code.push(0xff, 0xd0); // callback(&DDSURFACEDESC, context)
            code.push(0xff, 0x0d);
            emit32(HYPERCALL_CALLBACK_DEPTH);
            code.push(0x31, 0xc0); // DD_OK
            code.push(0xb9);
            emit32(originalReturn);
            code.push(0xff, 0xe1);
            this.writeU32(call.stack, this.allocateDynamicCode(code));
            return { eax: 0 };
          }
          case 'WaitForVerticalBlank': {
            if (this.primarySurface) this.emitPrimaryFrame();
            // DDWAITVB_BLOCKBEGIN/BLOCKEND are synchronous waits in the native
            // API. Let the host poller yield for one 60 Hz refresh so the guest
            // cannot run its render loop at an artificial rate.
            const waitRequested = ((a[1] ?? 0) & 0x7) !== 0;
            if (!waitRequested) return { eax: 0 };
            if (this.vblankPairSecondCall) {
              this.vblankPairSecondCall = false;
              return { eax: 0 };
            }
            this.options.onLogicFrame?.();
            // 按 60Hz 节拍对齐而非每次睡满一帧：游戏每帧连调两次 vblank（BEGIN/END），
            // 各睡 16.7ms 会把节奏压到 30fps，setTimeout 抖动叠加成卡顿。改「距上一拍
            // 的剩余时间」——连续调用总共只等一个周期，游戏回到 60fps 节拍。
            this.vblankPairSecondCall = true;
            const now = performance.now();
            const period = this.clock.toHostDelay(DIRECTDRAW_VBLANK_MS);
            const delay = Math.max(0, period - (now - this.lastVblankHostMs));
            this.lastVblankHostMs = now + delay;
            return { eax: 0, delayMs: delay };
          }
          case 'GetDisplayMode':
            if (a[1])
              this.writeSurfaceDesc(a[1], {
                object: 0,
                width: this.displayWidth,
                height: this.displayHeight,
                pitch: (this.displayWidth * (this.displayBpp >>> 3) + 3) & ~3,
                bpp: this.displayBpp,
                pixels: 0,
                caps: 0x200,
                palette: 0,
                attached: 0,
                sourceColorKey: null,
                destinationColorKey: null,
                textRuns: [],
                lastDrawSerial: 0,
                dirty: false,
              });
            return { eax: 0 };
          case 'CreateClipper': {
            if (!a[2]) return { eax: 0x8000_4003 };
            const clipper = this.createComObject('IDirectDrawClipper', CLIPPER_METHODS);
            this.clipperWindows.set(clipper, 0);
            this.writeU32(a[2], clipper);
            return { eax: 0 };
          }
          case 'CreatePalette': {
            if (!a[3]) return { eax: 0x8000_4003 };
            const palette = this.createPalette(a[1] ?? 0, a[2] ?? 0);
            this.writeU32(a[3], palette);
            return { eax: 0 };
          }
          case 'CreateSurface': {
            const desc = a[1] ?? 0;
            const out = a[2] ?? 0;
            if (!desc || !out) return { eax: 0x8000_4003 };
            const surface = this.createSurfaceFromDesc(desc);
            this.writeU32(out, surface.object);
            return { eax: 0 };
          }
          default:
            return null;
        }
      }

      if (tag === COM_TAG_CLIPPER || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDrawClipper.'))) {
        switch (method) {
          case 'SetHWnd':
            this.clipperWindows.set(thisPtr, a[2] ?? 0);
            return { eax: 0 };
          case 'SetClipList':
          case 'Initialize':
            return { eax: 0 };
          case 'GetHWnd':
            if (a[1]) this.writeU32(a[1], this.clipperWindows.get(thisPtr) ?? 0);
            return { eax: 0 };
          case 'IsClipListChanged':
            if (a[1]) this.writeU32(a[1], 0);
            return { eax: 0 };
          default:
            return null;
        }
      }

      if (tag === COM_TAG_PALETTE || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDrawPalette.'))) {
        const palette = this.palettes.get(thisPtr);
        if (!palette) return { eax: 0x8876_00c2 }; // DDERR_INVALIDOBJECT
        switch (method) {
          case 'SetEntries': {
            const base = a[2] ?? 0;
            const count = a[3] ?? 0;
            const source = a[4] ?? 0;
            if (source && base < 256 && count > 0) {
              const clipped = Math.min(count, 256 - base);
              palette.entries.set(this.memory.read_memory(source, clipped * 4), base * 4);
              this.applyReservedSystemPalette(palette);
              this.remapGdiTextForPalette(palette.object);
            }
            // 调色板与像素常在转场中分两步更新；等下一次主表面呈现再一起捕获。
            return { eax: 0 };
          }
          case 'GetEntries': {
            const base = a[2] ?? 0;
            const count = Math.min(a[3] ?? 0, 256 - base);
            if (a[4] && count > 0)
              this.memory.write_memory(palette.entries.subarray(base * 4, (base + count) * 4), a[4]);
            return { eax: 0 };
          }
          case 'GetCaps':
            if (a[1]) this.writeU32(a[1], palette.caps);
            return { eax: 0 };
          default:
            return null;
        }
      }

      if (tag === COM_TAG_SURFACE || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDrawSurface.'))) {
        const surface = this.surfaces.get(thisPtr);
        if (!surface) return { eax: 0x8876_00c2 };
        switch (method) {
          case 'GetAttachedSurface': {
            if (!surface.attached) return { eax: 0x8876_00b4 }; // DDERR_NOTFOUND
            if (a[2]) this.writeU32(a[2], surface.attached);
            return { eax: 0 };
          }
          case 'SetClipper':
            return { eax: 0 };
          case 'SetColorKey': {
            const flags = a[1] ?? 0;
            const key: [number, number] | null = a[2] ? [this.readU32(a[2]), this.readU32(a[2] + 4)] : null;
            if (flags & 0x8) surface.sourceColorKey = key; // DDCKEY_SRCBLT
            if (flags & 0x2) surface.destinationColorKey = key; // DDCKEY_DESTBLT
            return { eax: 0 };
          }
          case 'GetColorKey': {
            const flags = a[1] ?? 0;
            const key = flags & 0x8 ? surface.sourceColorKey : surface.destinationColorKey;
            if (!key) return { eax: 0x8876_006c }; // DDERR_NOCOLORKEY
            if (a[2]) {
              this.writeU32(a[2], key[0]);
              this.writeU32(a[2] + 4, key[1]);
            }
            return { eax: 0 };
          }
          case 'SetPalette':
            surface.palette = a[1] ?? 0;
            if (surface.attached) {
              const attached = this.surfaces.get(surface.attached);
              if (attached) attached.palette = surface.palette;
            }
            this.remapGdiTextRunColors(surface);
            if (surface.attached) {
              const attached = this.surfaces.get(surface.attached);
              if (attached) this.remapGdiTextRunColors(attached);
            }
            // SetPalette 不是像素呈现边界，避免新调色板套在旧像素上形成一帧花屏；
            // 但 remap 已改像素，置脏让下一个真实呈现边界（vblank）重新快照。
            surface.dirty = true;
            return { eax: 0 };
          case 'GetPalette':
            if (a[1]) this.writeU32(a[1], surface.palette);
            return { eax: surface.palette ? 0 : 0x8876_006c };
          case 'GetCaps':
            if (a[1]) this.writeU32(a[1], surface.caps);
            return { eax: 0 };
          case 'GetPixelFormat':
            if (a[1]) this.writePixelFormat(a[1], surface.bpp);
            return { eax: 0 };
          case 'GetSurfaceDesc':
            if (a[1]) this.writeSurfaceDesc(a[1], surface);
            return { eax: 0 };
          case 'GetDC':
            if (a[1]) this.writeU32(a[1], this.createGdiDc(surface.object));
            return { eax: 0 };
          case 'Lock':
            if (a[2]) this.writeSurfaceDesc(a[2], surface);
            surface.dirty = true; // 锁定后客体会直接写像素，保守置脏
            return { eax: 0 };
          case 'Unlock':
            // RA2 的 Lock 已在客体内完成；Unlock 仍是逐次 host 提交边界，统一置脏。
            if (this.gameProfile.directDraw?.guestSurfaceFastPath) {
              surface.dirty = true;
              this.writeU32(
                surface.object + SURFACE_UNLOCK_BUDGET,
                (surface.caps & DDSCAPS_PRIMARYSURFACE) !== 0 ? 0 : SURFACE_UNLOCK_FAST_BUDGET,
              );
            }
            this.noteShellSurfaceDraw(surface);
            this.emitFrame(surface);
            return { eax: 0 };
          case 'Flip': {
            const attached = this.surfaces.get(surface.attached);
            if (attached) {
              // 像素指针和 GDI 文字 run 必须同步交换：run 描述的是像素内容，
              // 只换 pixels 会让前台 run 与像素错位，调色板换页时 remap
              // 按错位的字形重写，文字像素保留旧索引（历史上显示成白色）。
              const pixels = surface.pixels;
              surface.pixels = attached.pixels;
              attached.pixels = pixels;
              const runs = surface.textRuns;
              surface.textRuns = attached.textRuns;
              attached.textRuns = runs;
              if (this.gameProfile.directDraw?.guestSurfaceFastPath) {
                this.refreshSurfaceDescCache(surface);
                this.refreshSurfaceDescCache(attached);
              }
            }
            surface.dirty = true; // 换页后前台像素来自后台
            this.emitFrame(surface);
            return { eax: 0 };
          }
          case 'Blt':
            this.blit(surface, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0);
            surface.dirty = true;
            this.noteShellSurfaceDraw(surface);
            this.emitFrame(surface);
            return { eax: 0 };
          case 'BltFast':
            this.blitFast(surface, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0);
            surface.dirty = true;
            this.noteShellSurfaceDraw(surface);
            this.emitFrame(surface);
            return { eax: 0 };
          case 'IsLost':
          case 'Restore':
          case 'GetBltStatus':
          case 'GetFlipStatus':
            return { eax: 0 };
          case 'ReleaseDC':
            return { eax: this.releaseGdiDc(a[1] ?? 0, surface.object) ? 0 : 0x8876_00c2 };
          default:
            return null;
        }
      }
      return null;
    }
    protected dispatchDirectSound(call: Win32Call): Win32Result | null {
      const key = call.imported.key;
      const a = call.args;
      const tag = call.imported.comTag;
      const method = call.imported.method ?? key.slice(key.lastIndexOf('.') + 1);
      const thisPtr = a[0] ?? 0;

      if (method === 'QueryInterface') {
        if (a[2]) this.writeU32(a[2], thisPtr);
        this.addComRef(thisPtr);
        return { eax: 0 };
      }
      if (method === 'AddRef') return { eax: this.addComRef(thisPtr) };
      if (method === 'Release') return { eax: this.releaseComObject(thisPtr) };

      if (tag === COM_TAG_SOUND || (tag === undefined && key.startsWith('DSOUND.COM!IDirectSound.'))) {
        switch (method) {
          case 'SetCooperativeLevel':
          case 'Compact':
          case 'SetSpeakerConfig':
          case 'Initialize':
            return { eax: 0 };
          case 'GetCaps':
            if (a[1]) {
              this.zero(a[1], 96);
              this.writeU32(a[1], 96);
              this.writeU32(a[1] + 12, 1); // dwPrimaryBuffers
            }
            return { eax: 0 };
          case 'GetSpeakerConfig':
            if (a[1]) this.writeU32(a[1], 4); // DSSPEAKER_STEREO
            return { eax: 0 };
          case 'CreateSoundBuffer': {
            if (!a[1] || !a[2]) return { eax: 0x8000_4003 };
            const formatPtr = this.readU32(a[1] + 16);
            let format = { ...DEFAULT_PCM_FORMAT };
            try {
              if (formatPtr) format = parsePcmWaveFormatEx(this.memory.read_memory(formatPtr, 18));
            } catch {
              return { eax: 0x8878_0064 }; // DSERR_BADFORMAT
            }
            const buffer = this.createSoundBuffer(this.readU32(a[1] + 8), format);
            this.writeU32(a[2], buffer.object);
            return { eax: 0 };
          }
          case 'DuplicateSoundBuffer': {
            const source = this.soundBuffers.get(a[1] ?? 0);
            if (!source || !a[2]) return { eax: 0x8878_001e };
            const duplicate = this.createSoundBuffer(source.size, source.format);
            this.memory.write_memory(this.memory.read_memory(source.data, source.size), duplicate.data);
            duplicate.position = source.position;
            duplicate.volume = source.volume;
            duplicate.pan = source.pan;
            duplicate.frequency = source.frequency;
            this.options.audio?.duplicateBuffer(source.object, duplicate.object);
            this.options.audio?.setCurrentPosition(duplicate.object, duplicate.position);
            this.options.audio?.setVolume(duplicate.object, duplicate.volume);
            this.options.audio?.setPan(duplicate.object, duplicate.pan);
            this.options.audio?.setFrequency(duplicate.object, duplicate.frequency);
            this.writeU32(a[2], duplicate.object);
            return { eax: 0 };
          }
          default:
            return null;
        }
      }

      if (tag === COM_TAG_SOUND_BUFFER || (tag === undefined && key.startsWith('DSOUND.COM!IDirectSoundBuffer.'))) {
        const buffer = this.soundBuffers.get(thisPtr);
        if (!buffer) return { eax: 0x8878_0032 };
        switch (method) {
          case 'GetCaps':
            if (a[1]) {
              this.zero(a[1], 20);
              this.writeU32(a[1], 20);
              this.writeU32(a[1] + 8, buffer.size);
            }
            return { eax: 0 };
          case 'GetCurrentPosition':
            {
              const position =
                this.options.audio?.getState(buffer.object)?.positionBytes ?? this.soundBufferPosition(buffer);
              if (a[1]) this.writeU32(a[1], position);
              if (a[2]) this.writeU32(a[2], position);
              this.cacheSoundBufferPosition(buffer, position);
            }
            return { eax: 0 };
          case 'GetFormat':
            if (a[3]) this.writeU32(a[3], 18);
            if (a[1] && a[2]) this.writeWaveFormat(a[1], a[2], buffer.format);
            return { eax: 0 };
          case 'GetVolume':
            if (a[1]) this.writeU32(a[1], buffer.volume);
            return { eax: 0 };
          case 'GetPan':
            if (a[1]) this.writeU32(a[1], buffer.pan);
            return { eax: 0 };
          case 'GetFrequency':
            if (a[1]) this.writeU32(a[1], buffer.frequency);
            return { eax: 0 };
          case 'GetStatus':
            {
              const hostState = this.options.audio?.getState(buffer.object);
              if (hostState) buffer.playing = hostState.playing;
              else if (buffer.playing) this.soundBufferPosition(buffer);
              this.invalidateSoundBufferPosition(buffer);
            }
            if (a[1]) this.writeU32(a[1], buffer.playing ? 1 : 0); // DSBSTATUS_PLAYING
            return { eax: 0 };
          case 'Lock': {
            const flags = a[7] ?? 0;
            // DSBLOCK_FROMWRITECURSOR (1) 与 DSBLOCK_ENTIREBUFFER (2)。RA2 的
            // 流式音乐会用这些标志维护环形缓冲；忽略 ENTIREBUFFER 会在 bytes=0
            // 时返回一个空锁，导致只有预先填入的部分能够播放。
            if ((flags & 1) !== 0) {
              buffer.position =
                this.options.audio?.getState(buffer.object)?.positionBytes ?? this.soundBufferPosition(buffer);
              buffer.startedAt = this.audioNow();
              this.invalidateSoundBufferPosition(buffer);
            }
            const offset = Math.min((flags & 1) !== 0 ? buffer.position : (a[1] ?? 0), buffer.size);
            const requested = (flags & 2) !== 0 ? buffer.size : Math.min(a[2] ?? 0, buffer.size);
            const first = Math.min(requested, buffer.size - offset);
            const second = requested - first;
            if (a[3]) this.writeU32(a[3], buffer.data + offset);
            if (a[4]) this.writeU32(a[4], first);
            if (a[5]) this.writeU32(a[5], second ? buffer.data : 0);
            if (a[6]) this.writeU32(a[6], second);
            return { eax: 0 };
          }
          case 'Play':
            {
              const nextLooping = ((a[3] ?? 0) & 1) !== 0;
              // DirectSound 对已播放且 flags 未变的 Play 是 no-op。Bink 每帧会重复
              // 调用；不应为同一状态持续向主线程发送消息。
              if (buffer.playing && buffer.looping === nextLooping) return { eax: 0 };
              if (!buffer.playing) buffer.startedAt = this.audioNow();
              buffer.playing = true;
              buffer.looping = nextLooping;
            }
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.play(buffer.object, { loop: buffer.looping });
            return { eax: 0 };
          case 'Stop':
            buffer.position = this.soundBufferPosition(buffer);
            buffer.startedAt = this.audioNow();
            buffer.playing = false;
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.stop(buffer.object);
            return { eax: 0 };
          case 'SetCurrentPosition':
            buffer.position = Math.min(a[1] ?? 0, buffer.size);
            buffer.startedAt = this.audioNow();
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.setCurrentPosition(buffer.object, buffer.position);
            return { eax: 0 };
          case 'SetFormat':
            if (!a[1]) return { eax: 0x8000_4003 };
            let nextFormat: PcmWaveFormat;
            try {
              nextFormat = parsePcmWaveFormatEx(this.memory.read_memory(a[1], 18));
            } catch {
              return { eax: 0x8878_0064 };
            }
            // 先按旧格式提交播放头，再切换格式；否则格式变化时会用新的
            // block-align 解释旧时间段，造成一次错误的游标跳跃。
            buffer.position = this.soundBufferPosition(buffer);
            buffer.startedAt = this.audioNow();
            buffer.format = nextFormat;
            buffer.frequency = buffer.format.nSamplesPerSec;
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.setFormat(buffer.object, buffer.format);
            return { eax: 0 };
          case 'SetVolume':
            {
              const next = Math.max(-10_000, Math.min(0, (a[1] ?? 0) | 0));
              if (next === buffer.volume) return { eax: 0 };
              buffer.volume = next;
            }
            this.options.audio?.setVolume(buffer.object, buffer.volume);
            return { eax: 0 };
          case 'SetPan':
            {
              const next = Math.max(-10_000, Math.min(10_000, (a[1] ?? 0) | 0));
              if (next === buffer.pan) return { eax: 0 };
              buffer.pan = next;
            }
            this.options.audio?.setPan(buffer.object, buffer.pan);
            return { eax: 0 };
          case 'SetFrequency':
            {
              const next = (a[1] ?? 0) || buffer.format.nSamplesPerSec;
              if (next === buffer.frequency) return { eax: 0 };
            }
            buffer.position = this.soundBufferPosition(buffer);
            buffer.startedAt = this.audioNow();
            buffer.frequency = (a[1] ?? 0) || buffer.format.nSamplesPerSec;
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.setFrequency(buffer.object, a[1] ?? 0);
            return { eax: 0 };
          case 'Unlock':
            this.syncSoundRange(buffer, a[1] ?? 0, a[2] ?? 0);
            this.syncSoundRange(buffer, a[3] ?? 0, a[4] ?? 0);
            return { eax: 0 };
          case 'Restore':
          case 'Initialize':
            return { eax: 0 };
          default:
            return null;
        }
      }
      return null;
    }
    protected createComObject(
      interfaceName: string,
      methods: Array<[string, number]>,
      namespace = 'DDRAW.COM',
      objectBytes = 8,
    ): number {
      const vtableKey = `${namespace}!${interfaceName}`;
      let vtable = this.vtables.get(vtableKey);
      if (!vtable) {
        vtable = this.alloc(methods.length * 4, true);
        for (let i = 0; i < methods.length; i++) {
          const [method, argBytes] = methods[i]!;
          const id = this.nextDynamicId++;
          // 无副作用的查询类 COM 方法（IsLost 等）在战场渲染循环里每帧被调数万次，
          // 每次往返 host 的开销远超方法本身。这些方法的 host 分支本就只返回常量，
          // 直接生成客体内常量桩，消除 VM↔JS 往返。
          const constant = CONSTANT_COM_METHODS.get(`${interfaceName}.${method}`);
          const stubBytes =
            interfaceName === 'IDirectSoundBuffer' && method === 'GetCurrentPosition'
              ? makeCachedSoundPositionStub(id, argBytes)
              : this.gameProfile.directDraw?.guestSurfaceFastPath &&
                  interfaceName === 'IDirectDrawSurface' &&
                  method === 'Lock'
                ? makeCachedSurfaceLockStub(id, argBytes)
                : this.gameProfile.directDraw?.guestSurfaceFastPath &&
                    interfaceName === 'IDirectDrawSurface' &&
                    method === 'Unlock'
                  ? makeBudgetedSurfaceUnlockStub(id, argBytes)
                  : constant !== undefined
                    ? makeConstantImportStub(constant, argBytes)
                    : makeImportStub(id, argBytes);
          const stub = this.allocateDynamicCode(stubBytes);
          const name = `${interfaceName}.${method}`;
          const imported: PeImport = {
            id,
            dll: namespace,
            name,
            key: `${namespace}!${name}`,
            slot: vtable + i * 4,
            stub,
            argBytes,
            win32Module: win32ModuleOf(namespace),
            // 路由预计算：dispatch 热路径不再 lastIndexOf/slice/startsWith。
            method,
            comTag: comTagOf(interfaceName),
          };
          this.dynamicImports.set(id, imported);
          this.writeU32(imported.slot, stub);
        }
        this.vtables.set(vtableKey, vtable);
      }
      const object = this.alloc(Math.max(8, objectBytes), true);
      this.writeU32(object, vtable);
      this.writeU32(object + 4, 1);
      return object;
    }
    protected createSoundBuffer(size: number, format: PcmWaveFormat = { ...DEFAULT_PCM_FORMAT }): SoundBufferState {
      const safeSize = Math.max(1, Math.min(size || 65_536, 4 * 1024 * 1024));
      const object = this.createComObject('IDirectSoundBuffer', SOUND_BUFFER_METHODS, 'DSOUND.COM', 16);
      const data = this.alloc(safeSize, true);
      const buffer: SoundBufferState = {
        object,
        data,
        size: safeSize,
        startedAt: this.audioNow(),
        position: 0,
        playing: false,
        looping: false,
        format: { ...format },
        volume: 0,
        pan: 0,
        frequency: format.nSamplesPerSec,
      };
      this.soundBuffers.set(object, buffer);
      this.invalidateSoundBufferPosition(buffer);
      this.options.audio?.createBuffer(object, safeSize, buffer.format);
      return buffer;
    }

    private cacheSoundBufferPosition(buffer: SoundBufferState, position: number): void {
      this.writeU32(buffer.object + SOUND_POSITION_CACHE, position >>> 0);
      this.writeU32(buffer.object + SOUND_POSITION_BUDGET, SOUND_POSITION_FAST_BUDGET);
    }

    private invalidateSoundBufferPosition(buffer: SoundBufferState): void {
      this.writeU32(buffer.object + SOUND_POSITION_CACHE, buffer.position >>> 0);
      this.writeU32(buffer.object + SOUND_POSITION_BUDGET, 0);
    }
    /**
     * 正式浏览器路径中 VM 位于 Worker，而 WebAudio 位于主线程，getState 无法
     * 同步跨线程返回。用宿主单调时钟按 PCM 帧率维护 DirectSound 播放游标，
     * 让 RA2 的流式解码线程可以继续判断哪些环形区段已经播完并及时回填。
     */
    protected soundBufferPosition(buffer: SoundBufferState): number {
      if (!buffer.playing || buffer.size <= 0) return buffer.position;
      const now = this.audioNow();
      const elapsedSeconds = Math.max(0, now - buffer.startedAt) / 1000;
      const blockAlign = Math.max(1, buffer.format.nBlockAlign);
      const advanced = Math.floor(elapsedSeconds * Math.max(1, buffer.frequency)) * blockAlign;
      const absolute = buffer.position + advanced;
      if (buffer.looping) return absolute % buffer.size;
      if (absolute < buffer.size) return absolute;
      buffer.playing = false;
      buffer.position = 0;
      buffer.startedAt = now;
      return 0;
    }
    protected audioNow(): number {
      return typeof performance === 'undefined' ? Date.now() : performance.now();
    }
    protected syncSoundRange(buffer: SoundBufferState, pointer: number, requested: number): void {
      if (!pointer || !requested || pointer < buffer.data || pointer >= buffer.data + buffer.size) return;
      const offset = pointer - buffer.data;
      const count = Math.min(requested, buffer.size - offset);
      if (count > 0) this.options.audio?.writeBuffer(buffer.object, offset, this.memory.read_memory(pointer, count));
    }
    protected writeWaveFormat(pointer: number, capacity: number, format: PcmWaveFormat): void {
      const bytes = new Uint8Array(18);
      const view = new DataView(bytes.buffer);
      view.setUint16(0, format.wFormatTag, true);
      view.setUint16(2, format.nChannels, true);
      view.setUint32(4, format.nSamplesPerSec, true);
      view.setUint32(8, format.nAvgBytesPerSec, true);
      view.setUint16(12, format.nBlockAlign, true);
      view.setUint16(14, format.wBitsPerSample, true);
      view.setUint16(16, format.cbSize, true);
      this.memory.write_memory(bytes.subarray(0, Math.min(bytes.length, capacity)), pointer);
    }
    protected createPalette(caps: number, entriesPtr: number): number {
      const object = this.createComObject('IDirectDrawPalette', PALETTE_METHODS);
      const entries = entriesPtr ? this.memory.read_memory(entriesPtr, 256 * 4).slice() : new Uint8Array(256 * 4);
      const palette = { object, caps, entries };
      this.applyReservedSystemPalette(palette);
      this.palettes.set(object, palette);
      return object;
    }
    protected applyReservedSystemPalette(palette: PaletteState): void {
      // 客体传 DDPCAPS_8BIT (0x4) 时会使用几乎全部
      // 256 个索引；不能套用窗口 GDI 的 20 个保留色。但 index 0 仍是
      // 黑色/透明键，必须保持为黑，否则战场未绘制区会显示色键绿。
      if (palette.caps & 0x40) return;
      palette.entries.set([0, 0, 0, 0], 0);
    }
    protected createSurfaceFromDesc(desc: number): SurfaceState {
      const flags = this.readU32(desc + 4);
      const caps = this.readU32(desc + 104);
      const primary = (caps & 0x200) !== 0;
      const requestedWidth = (flags & 4) !== 0 ? this.readU32(desc + 12) : this.displayWidth;
      const requestedHeight = (flags & 2) !== 0 ? this.readU32(desc + 8) : this.displayHeight;
      // DirectDraw 包装器在初始化过渡期可能带着 WIDTH/HEIGHT flags 传 0；
      // Win9x 驱动实际按当前显示模式建立工作面，不能把它降成 1×1。
      const width = requestedWidth || this.displayWidth || 800;
      const height = requestedHeight || this.displayHeight || 600;
      const surface = this.createSurface(width, height, caps);
      if (primary) this.primarySurface = surface.object;
      const backBuffers = (flags & 0x20) !== 0 ? this.readU32(desc + 20) : 0;
      if (backBuffers > 0) {
        const back = this.createSurface(surface.width, surface.height, 0x4 | 0x40);
        surface.attached = back.object;
        back.attached = surface.object;
      }
      return surface;
    }
    protected createSurface(width: number, height: number, caps: number): SurfaceState {
      const object = this.createComObject(
        'IDirectDrawSurface',
        SURFACE_METHODS,
        'DDRAW.COM',
        this.gameProfile.directDraw?.guestSurfaceFastPath ? SURFACE_OBJECT_BYTES : 8,
      );
      const bpp = this.displayBpp === 16 ? 16 : 8;
      const pitch = (width * (bpp >>> 3) + 3) & ~3;
      const pixels = this.alloc(pitch * height, true);
      const surface: SurfaceState = {
        object,
        width,
        height,
        pitch,
        bpp,
        pixels,
        caps,
        palette: 0,
        attached: 0,
        sourceColorKey: null,
        destinationColorKey: null,
        textRuns: [],
        lastDrawSerial: 0,
        dirty: false,
      };
      this.surfaces.set(object, surface);
      if (this.gameProfile.directDraw?.guestSurfaceFastPath) {
        this.refreshSurfaceDescCache(surface);
        const shell =
          this.gameProfile.shell?.compositeRgb565Layers &&
          width === this.displayWidth &&
          height === this.displayHeight &&
          bpp === 16;
        this.writeU32(
          object + SURFACE_UNLOCK_MODE,
          (caps & DDSCAPS_PRIMARYSURFACE) !== 0
            ? SURFACE_UNLOCK_PRIMARY
            : shell
              ? SURFACE_UNLOCK_SHELL
              : SURFACE_UNLOCK_GENERIC,
        );
        this.writeU32(object + SURFACE_UNLOCK_BUDGET, 0); // 首次 Unlock 必须进 host
      }
      return surface;
    }
    /** DDSURFACEDESC 暂存（108 字节）+ 复用 DataView：Lock/GetDisplayMode 每秒上万次，
     *  原来 13 次 write_blob 合成 1 次，避免中间态与分配。 */
    private readonly surfaceDescScratch = new Uint8Array(108);
    private readonly surfaceDescView = new DataView(this.surfaceDescScratch.buffer);

    protected writeSurfaceDesc(ptr: number, surface: SurfaceState): void {
      const bytes = this.surfaceDescScratch;
      const view = this.surfaceDescView;
      bytes.fill(0);
      view.setUint32(0, 108, true);
      view.setUint32(4, 0x180f, true); // CAPS | HEIGHT | WIDTH | PITCH | PIXELFORMAT | LPSURFACE
      view.setUint32(8, surface.height, true);
      view.setUint32(12, surface.width, true);
      view.setUint32(16, surface.pitch, true);
      view.setUint32(36, surface.pixels, true);
      // DDPIXELFORMAT（72 起 32 字节）与 writePixelFormat 同分支：RA2 的 16-bit
      // surface 不能报成 8-bit 调色板格式。
      view.setUint32(72, 32, true); // DDPIXELFORMAT.dwSize
      if (surface.bpp === 16) {
        view.setUint32(76, 0x40, true); // DDPF_RGB
        view.setUint32(84, 16, true);
        view.setUint32(88, 0xf800, true);
        view.setUint32(92, 0x07e0, true);
        view.setUint32(96, 0x001f, true);
      } else {
        view.setUint32(76, 0x60, true); // DDPF_RGB | DDPF_PALETTEINDEXED8
        view.setUint32(84, 8, true);
      }
      view.setUint32(104, surface.caps, true);
      this.memory.write_memory(bytes, ptr);
    }

    /** Flip 交换 pixels 指针后同步 RA2 Lock 所读的对象内描述符。 */
    private refreshSurfaceDescCache(surface: SurfaceState): void {
      this.writeSurfaceDesc(surface.object + SURFACE_DESC_CACHE, surface);
    }
    protected writePixelFormat(ptr: number, bpp = this.displayBpp): void {
      this.zero(ptr, 32);
      this.writeU32(ptr, 32);
      if (bpp === 16) {
        this.writeU32(ptr + 4, 0x40); // DDPF_RGB
        this.writeU32(ptr + 12, 16);
        this.writeU32(ptr + 16, 0xf800);
        this.writeU32(ptr + 20, 0x07e0);
        this.writeU32(ptr + 24, 0x001f);
      } else {
        this.writeU32(ptr + 4, 0x60); // DDPF_RGB | DDPF_PALETTEINDEXED8
        this.writeU32(ptr + 12, 8);
      }
    }
    /** 记录最近被绘制的全屏层，呈现时按当前显示模式选择（见 snapshotFrame）。 */
    protected noteShellSurfaceDraw(surface: SurfaceState): void {
      if (
        this.gameProfile.shell?.compositeRgb565Layers &&
        surface.width === this.displayWidth &&
        surface.height === this.displayHeight &&
        surface.bpp === 16
      ) {
        surface.lastDrawSerial = ++this.shellSurfaceDrawSerial;
        this.activeShellSurface = surface.object;
        this.writeU32(HYPERCALL_ACTIVE_SHELL_SURFACE, surface.object);
      }
    }
    protected blit(
      dest: SurfaceState,
      destRectPtr: number,
      sourceObject: number,
      sourceRectPtr: number,
      flags: number,
      effectsPtr: number,
    ): void {
      let destRect = destRectPtr ? this.readRect(destRectPtr) : [0, 0, dest.width, dest.height];
      if (destRect[2] <= destRect[0] || destRect[3] <= destRect[1]) {
        destRect = [0, 0, dest.width, dest.height];
      }
      // DDBLT_COLORFILL does not carry a source surface; the fill colour is the
      // 8-bit palette index in DDBLTFX.dwFillColor (offset 80).
      if (!sourceObject && flags & 0x400 && effectsPtr) {
        const mask = dest.bpp === 16 ? 0xffff : 0xff;
        this.fillRect(dest, destRect, this.readU32(effectsPtr + 80) & mask);
        return;
      }
      const source = this.surfaces.get(sourceObject);
      if (!source) return;
      const sourceRect = sourceRectPtr ? this.readRect(sourceRectPtr) : [0, 0, source.width, source.height];
      // 全屏呈现路径仍可能传入窗口模式 RECT 全局；独占模式下该值保持空矩形。
      // 旧 DirectDraw 驱动把它等价处理为整张主表面，这里显式归一化，否则所有运行时自绘都会丢失。
      if (destRect[2] <= destRect[0] || destRect[3] <= destRect[1]) {
        destRect = [0, 0, dest.width, dest.height];
      }
      const sourceKey = flags & 0x8000 ? source.sourceColorKey : null; // DDBLT_KEYSRC
      const destinationKey = flags & 0x2000 ? dest.destinationColorKey : null; // DDBLT_KEYDEST
      this.copyRect(
        source,
        sourceRect,
        dest,
        destRect[0],
        destRect[1],
        destRect[2] - destRect[0],
        destRect[3] - destRect[1],
        sourceKey,
        destinationKey,
      );
    }
    protected blitFast(
      dest: SurfaceState,
      x: number,
      y: number,
      sourceObject: number,
      sourceRectPtr: number,
      flags: number,
    ): void {
      const source = this.surfaces.get(sourceObject);
      if (!source) return;
      const sourceRect = sourceRectPtr ? this.readRect(sourceRectPtr) : [0, 0, source.width, source.height];
      this.copyRect(
        source,
        sourceRect,
        dest,
        x | 0,
        y | 0,
        sourceRect[2] - sourceRect[0],
        sourceRect[3] - sourceRect[1],
        flags & 0x1 ? source.sourceColorKey : null, // DDBLTFAST_SRCCOLORKEY
        flags & 0x2 ? dest.destinationColorKey : null, // DDBLTFAST_DESTCOLORKEY
      );
    }
    protected copyRect(
      source: SurfaceState,
      sourceRect: number[],
      dest: SurfaceState,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
      sourceKey: [number, number] | null = null,
      destinationKey: [number, number] | null = null,
    ): void {
      const sx0 = sourceRect[0]! | 0;
      const sy0 = sourceRect[1]! | 0;
      const sw = Math.max(0, (sourceRect[2]! | 0) - sx0);
      const sh = Math.max(0, (sourceRect[3]! | 0) - sy0);
      const destWidth = Math.max(0, dw | 0);
      const destHeight = Math.max(0, dh | 0);
      if (sw <= 0 || sh <= 0 || destWidth <= 0 || destHeight <= 0) return;
      // 游戏建立的前/后缓冲位深一致；不同位深没有可靠的调色板来源，按
      // DirectDraw 的无效像素格式语义跳过，避免越界破坏客体内存。
      if (source.bpp !== dest.bpp) return;
      const bytesPerPixel = source.bpp >>> 3;

      // 等尺寸 Blt/BltFast 是战场每帧的热路径。先同时裁剪目标面与源面，
      // 特别处理负目标坐标：旧实现直接算出 surface.pixels 之前的地址，边缘
      // 动画会污染相邻内存并在顶部形成彩色噪声条。
      if (sw === destWidth && sh === destHeight) {
        let targetLeft = Math.max(0, dx);
        let targetTop = Math.max(0, dy);
        let sourceLeft = sx0 + targetLeft - dx;
        let sourceTop = sy0 + targetTop - dy;
        if (sourceLeft < 0) {
          targetLeft -= sourceLeft;
          sourceLeft = 0;
        }
        if (sourceTop < 0) {
          targetTop -= sourceTop;
          sourceTop = 0;
        }
        const targetRight = Math.min(dest.width, dx + destWidth, targetLeft + source.width - sourceLeft);
        const targetBottom = Math.min(dest.height, dy + destHeight, targetTop + source.height - sourceTop);
        const width = targetRight - targetLeft;
        const height = targetBottom - targetTop;
        if (width <= 0 || height <= 0) return;
        this.invalidateGdiTextRuns(dest, targetLeft, targetTop, targetRight, targetBottom);
        if (source.bpp === 8 && dest.bpp === 8) {
          this.transferGdiTextRuns(
            source,
            [sourceLeft, sourceTop, sourceLeft + width, sourceTop + height],
            dest,
            targetLeft,
            targetTop,
            width,
            height,
            sourceKey,
          );
        }
        this.copyUnscaledRect(
          source,
          sourceLeft,
          sourceTop,
          dest,
          targetLeft,
          targetTop,
          width,
          height,
          bytesPerPixel,
          sourceKey,
          destinationKey,
        );
        return;
      }

      // IDirectDrawSurface::Blt 允许源/目标 RECT 尺寸不同。RA2 的地图预览和
      // UI 动画会把 198×99 表面缩到 144×72；按最近邻像素中心映射，保持
      // RGB565 原值及色键语义。BltFast 不会进入此分支（其尺寸来自源 RECT）。
      const targetLeft = Math.max(0, dx);
      const targetTop = Math.max(0, dy);
      const targetRight = Math.min(dest.width, dx + destWidth);
      const targetBottom = Math.min(dest.height, dy + destHeight);
      const width = targetRight - targetLeft;
      const height = targetBottom - targetTop;
      if (width <= 0 || height <= 0) return;
      this.invalidateGdiTextRuns(dest, targetLeft, targetTop, targetRight, targetBottom);
      const sourceBytes = this.memory.read_memory(source.pixels, source.pitch * source.height).slice();
      const destinationStart = dest.pixels + targetTop * dest.pitch + targetLeft * bytesPerPixel;
      const destinationSpan = (height - 1) * dest.pitch + width * bytesPerPixel;
      const destinationBytes = this.memory.read_memory(destinationStart, destinationSpan).slice();
      for (let row = 0; row < height; row++) {
        const targetY = targetTop + row;
        const sourceY = sy0 + Math.floor(((targetY - dy) * sh) / destHeight);
        if (sourceY < 0 || sourceY >= source.height) continue;
        for (let column = 0; column < width; column++) {
          const targetX = targetLeft + column;
          const sourceX = sx0 + Math.floor(((targetX - dx) * sw) / destWidth);
          if (sourceX < 0 || sourceX >= source.width) continue;
          const sourceOffset = sourceY * source.pitch + sourceX * bytesPerPixel;
          const destinationOffset = row * dest.pitch + column * bytesPerPixel;
          const sourcePixel =
            bytesPerPixel === 2
              ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
              : sourceBytes[sourceOffset]!;
          const destinationPixel =
            bytesPerPixel === 2
              ? destinationBytes[destinationOffset]! | (destinationBytes[destinationOffset + 1]! << 8)
              : destinationBytes[destinationOffset]!;
          const sourceTransparent = sourceKey && sourcePixel >= sourceKey[0] && sourcePixel <= sourceKey[1];
          const destinationBlocked =
            destinationKey && (destinationPixel < destinationKey[0] || destinationPixel > destinationKey[1]);
          if (!sourceTransparent && !destinationBlocked) {
            destinationBytes[destinationOffset] = sourcePixel & 0xff;
            if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourcePixel >>> 8;
          }
        }
      }
      this.memory.write_memory(destinationBytes, destinationStart);
    }

    protected copyUnscaledRect(
      source: SurfaceState,
      sourceLeft: number,
      sourceTop: number,
      dest: SurfaceState,
      targetLeft: number,
      targetTop: number,
      width: number,
      height: number,
      bytesPerPixel: number,
      sourceKey: [number, number] | null,
      destinationKey: [number, number] | null,
    ): void {
      const byteWidth = width * bytesPerPixel;
      const sourceStart = source.pixels + sourceTop * source.pitch + sourceLeft * bytesPerPixel;
      const destinationStart = dest.pixels + targetTop * dest.pitch + targetLeft * bytesPerPixel;
      const sourceSpan = (height - 1) * source.pitch + byteWidth;
      const destinationSpan = (height - 1) * dest.pitch + byteWidth;
      const sourceBytes = this.memory.read_memory(sourceStart, sourceSpan);
      if (!sourceKey && !destinationKey && source.pitch === byteWidth && dest.pitch === byteWidth) {
        this.memory.write_memory(sourceBytes, destinationStart);
        return;
      }
      // read_memory 返回客体内存的视图（subarray，非拷贝）：逐像素直接改视图即改
      // 客体内存，省掉每块一次 .slice() 拷贝 + 一次 write_memory 回写。BlitFast
      // 热路径（統一天下 ~18 万次/秒）下这是主要分配与内存往返开销。
      const destinationBytes = this.memory.read_memory(destinationStart, destinationSpan);
      if (!sourceKey && !destinationKey) {
        for (let row = 0; row < height; row++) {
          destinationBytes.set(
            sourceBytes.subarray(row * source.pitch, row * source.pitch + byteWidth),
            row * dest.pitch,
          );
        }
        return;
      }
      // 按色键组合拆开逐像素循环：单源色键（BltFast 0x11 最常见的形态）不必逐像素
      // 读目标面，省掉每个像素一次目标读取与分支。16-bit 表面按 2 字节像素读写。
      if (sourceKey && !destinationKey) {
        const keyLow = sourceKey[0];
        const keyHigh = sourceKey[1];
        // 对齐的 RGB565 直接按 16 位读写，避免每像素拼接/拆分两次字节。
        // 奇数地址或 pitch 保留字节路径，不能用取整视图误读下一行。
        if (
          bytesPerPixel === 2 &&
          ((sourceBytes.byteOffset | destinationBytes.byteOffset | source.pitch | dest.pitch) & 1) === 0
        ) {
          const source16 = new Uint16Array(sourceBytes.buffer, sourceBytes.byteOffset, sourceSpan / 2);
          const destination16 = new Uint16Array(
            destinationBytes.buffer,
            destinationBytes.byteOffset,
            destinationSpan / 2,
          );
          const sourcePitch = source.pitch / 2;
          const destinationPitch = dest.pitch / 2;
          for (let row = 0; row < height; row++) {
            let sourceIndex = row * sourcePitch;
            let destinationIndex = row * destinationPitch;
            const end = sourceIndex + width;
            for (; sourceIndex < end; sourceIndex++, destinationIndex++) {
              const pixel = source16[sourceIndex]!;
              if (pixel < keyLow || pixel > keyHigh) destination16[destinationIndex] = pixel;
            }
          }
          return;
        }
        for (let row = 0; row < height; row++) {
          const sourceRow = row * source.pitch;
          const destinationRow = row * dest.pitch;
          for (let column = 0; column < width; column++) {
            const sourceOffset = sourceRow + column * bytesPerPixel;
            const sourceIndex =
              bytesPerPixel === 2
                ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
                : sourceBytes[sourceOffset]!;
            if (sourceIndex < keyLow || sourceIndex > keyHigh) {
              const destinationOffset = destinationRow + column * bytesPerPixel;
              destinationBytes[destinationOffset] = sourceIndex & 0xff;
              if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourceIndex >>> 8;
            }
          }
        }
        return;
      }
      if (destinationKey && !sourceKey) {
        const keyLow = destinationKey[0];
        const keyHigh = destinationKey[1];
        for (let row = 0; row < height; row++) {
          const sourceRow = row * source.pitch;
          const destinationRow = row * dest.pitch;
          for (let column = 0; column < width; column++) {
            const sourceOffset = sourceRow + column * bytesPerPixel;
            const destinationOffset = destinationRow + column * bytesPerPixel;
            const destinationIndex =
              bytesPerPixel === 2
                ? destinationBytes[destinationOffset]! | (destinationBytes[destinationOffset + 1]! << 8)
                : destinationBytes[destinationOffset]!;
            if (destinationIndex >= keyLow && destinationIndex <= keyHigh) {
              const sourceIndex =
                bytesPerPixel === 2
                  ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
                  : sourceBytes[sourceOffset]!;
              destinationBytes[destinationOffset] = sourceIndex & 0xff;
              if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourceIndex >>> 8;
            }
          }
        }
        return;
      }
      const sourceLow = sourceKey![0];
      const sourceHigh = sourceKey![1];
      const destinationLow = destinationKey![0];
      const destinationHigh = destinationKey![1];
      for (let row = 0; row < height; row++) {
        const sourceRow = row * source.pitch;
        const destinationRow = row * dest.pitch;
        for (let column = 0; column < width; column++) {
          const sourceOffset = sourceRow + column * bytesPerPixel;
          const destinationOffset = destinationRow + column * bytesPerPixel;
          const sourceIndex =
            bytesPerPixel === 2
              ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
              : sourceBytes[sourceOffset]!;
          if (sourceIndex >= sourceLow && sourceIndex <= sourceHigh) continue;
          const destinationIndex =
            bytesPerPixel === 2
              ? destinationBytes[destinationOffset]! | (destinationBytes[destinationOffset + 1]! << 8)
              : destinationBytes[destinationOffset]!;
          if (destinationIndex < destinationLow || destinationIndex > destinationHigh) continue;
          destinationBytes[destinationOffset] = sourceIndex & 0xff;
          if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourceIndex >>> 8;
        }
      }
    }
    protected fillRect(surface: SurfaceState, rect: number[], color: number): void {
      const left = Math.max(0, rect[0] ?? 0);
      const top = Math.max(0, rect[1] ?? 0);
      const right = Math.min(surface.width, rect[2] ?? surface.width);
      const bottom = Math.min(surface.height, rect[3] ?? surface.height);
      if (right <= left || bottom <= top) return;
      this.invalidateGdiTextRuns(surface, left, top, right, bottom);
      const width = right - left;
      const height = bottom - top;
      const bytesPerPixel = surface.bpp >>> 3;
      const byteWidth = width * bytesPerPixel;
      const start = surface.pixels + top * surface.pitch + left * bytesPerPixel;
      const row = new Uint8Array(byteWidth);
      if (bytesPerPixel === 2) {
        for (let offset = 0; offset < row.length; offset += 2) {
          row[offset] = color & 0xff;
          row[offset + 1] = (color >>> 8) & 0xff;
        }
      } else {
        row.fill(color & 0xff);
      }
      if (byteWidth === surface.pitch) {
        const block = new Uint8Array(byteWidth * height);
        for (let y = 0; y < height; y++) block.set(row, y * byteWidth);
        this.memory.write_memory(block, start);
        return;
      }
      const span = (height - 1) * surface.pitch + byteWidth;
      // 与 copyUnscaledRect 同理：视图直接改写，省 slice + 回写。
      const block = this.memory.read_memory(start, span);
      for (let y = 0; y < height; y++) block.set(row, y * surface.pitch);
    }
    protected addComRef(object: number): number {
      if (!object || !this.allocations.has(object)) return 0;
      const next = (this.readU32(object + 4) + 1) >>> 0;
      this.writeU32(object + 4, next);
      return next;
    }
    protected releaseComObject(object: number): number {
      if (!object || !this.allocations.has(object)) return 0;
      const current = this.readU32(object + 4);
      const next = current > 0 ? current - 1 : 0;
      this.writeU32(object + 4, next);
      if (next) return next;

      const surface = this.surfaces.get(object);
      if (surface) {
        this.surfaces.delete(object);
        this.freeAllocation(surface.pixels);
        if (this.primarySurface === object) this.primarySurface = 0;
        if (this.activeShellSurface === object) {
          this.activeShellSurface = 0;
          this.writeU32(HYPERCALL_ACTIVE_SHELL_SURFACE, 0);
        }
      }
      this.palettes.delete(object);
      const sound = this.soundBuffers.get(object);
      if (sound) {
        this.soundBuffers.delete(object);
        this.freeAllocation(sound.data);
        this.options.audio?.releaseBuffer(object);
      }
      this.freeAllocation(object);
      return 0;
    }
  };
}
