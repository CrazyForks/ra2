/**
 * DirectDraw/GDI 图形对象与帧呈现（mixin 拆分自 state.ts）：
 * surface/调色板/GDI 对象状态、帧快照与硬件光标叠加。
 * 挂在同步层之后、kernel32/gdi32 分派之前。
 */
import type {
  GdiDcState,
  PaletteState,
  SoundBufferState,
  SurfaceState,
  VmFrame,
  VmGdiFont,
  VmSurfaceSnapshot,
} from '../win32';
import { HYPERCALL_CURSOR_COUNT } from '../pe';
import { RGB565_TO_RGBA32 as rgb565Colors } from '../pixels';
import { shimTraceEnabled, type Constructor } from './state';
import type { ShimSyncChain } from './stateSync';

// 将共享表绑定为本模块常量，避免开发/测试的 ESM live-binding getter 进入像素循环。
const RGB565_TO_RGBA32 = rgb565Colors;

const EMPTY_PALETTE = new Uint8Array(256 * 4);

export type ShimGraphicsChain = InstanceType<ReturnType<typeof withShimGraphics>>;

export function withShimGraphics<TBase extends Constructor<ShimSyncChain>>(Base: TBase) {
  return class extends Base {
    protected readonly surfaces = new Map<number, SurfaceState>();
    protected readonly palettes = new Map<number, PaletteState>();
    protected readonly soundBuffers = new Map<number, SoundBufferState>();
    protected readonly gdiDcs = new Map<number, GdiDcState>();
    protected readonly gdiFonts = new Map<number, VmGdiFont>();
    /** HBRUSH → COLORREF；null 表示 NULL/HOLLOW_BRUSH。 */
    protected readonly gdiBrushes = new Map<number, number | null>();
    protected readonly gdiStockObjects = new Set<number>();
    protected nextGdiDc = 0x3000;
    protected nextGdiObject = 0x30_0000;

    /** 调试：列出全部 surface 的对象句柄与几何/ caps，用于合成层排查。 */
    inspectSurfaceObjects(): Array<{ object: number; width: number; height: number; bpp: number; caps: number }> {
      return [...this.surfaces.values()].map((s) => ({
        object: s.object,
        width: s.width,
        height: s.height,
        bpp: s.bpp,
        caps: s.caps,
      }));
    }

    inspectSurface(object: number): VmSurfaceSnapshot | null {
      const surface = this.surfaces.get(object);
      if (!surface) return null;
      return {
        object: surface.object,
        width: surface.width,
        height: surface.height,
        pitch: surface.pitch,
        bpp: surface.bpp,
        pixels: this.memory.read_memory(surface.pixels, surface.pitch * surface.height).slice(),
      };
    }

    protected paletteForSurface(surface: SurfaceState): Uint8Array {
      const direct = this.palettes.get(surface.palette)?.entries;
      if (direct) return direct;
      const primary = this.surfaces.get(this.primarySurface);
      const primaryEntries = primary ? this.palettes.get(primary.palette)?.entries : undefined;
      return primaryEntries ?? this.palettes.values().next().value?.entries ?? EMPTY_PALETTE;
    }

    protected emitPrimaryFrame(): void {
      const primary = this.surfaces.get(this.primarySurface);
      if (primary) this.emitFrame(primary);
    }

    /** USER32 mixin 可在 DirectDraw 呈现结果上叠加独立的窗口控件层。 */
    protected compositeWindowControls(_rgba: Uint8Array, _width: number, _height: number): void {}
    /** USER32 有独立控件覆盖层时，必须继续走 RGBA 合成。 */
    protected requiresRgbaComposite(): boolean {
      return this.isShellVisible();
    }

    protected emitFrame(surface: SurfaceState): void {
      if (!this.options.onFrame || surface.object !== this.primarySurface) return;
      // 内容没变的 emit 跳过（游戏一帧里 Blt + vblank×2 三连发，重复快照是
      // 每帧 3×480KB 分配 + 3 条跨线程消息的纯垃圾，worker 模式 GC 周期卡顿）。
      if (!surface.dirty) return;
      // 已有快照等待呈现时保留 dirty；呈现后自动排下一张，既不反复分配快照，
      // 也不会永久漏掉等待期间发生的最后一次更新。
      if (this.frameScheduled) return;
      surface.dirty = false;
      if (this.options.scheduleFrame) {
        // 菜单壳页的两阶段重绘（擦旧高亮/画新高亮常分属不同客体帧）会在背压
        // 路径上各自触发一次呈现，中间态直接上屏就是点击选择时的高亮闪烁。
        // 壳页下先做“静默合并”：呈现回调发现画面仍被继续修改就再等一轮（最多
        // 一次），把擦+画并进最终状态；对战中壳页为空，逻辑不生效。
        const settleShell = this.isShellVisible();
        const frame = !this.options.deferFrameSnapshot && !settleShell ? this.snapshotFrame(surface) : null;
        surface.dirty = false;
        const present = () => {
          this.frameScheduled = false;
          if (this.disposed) return;
          // Worker mailbox 在途时只保存这个回调，不保存昂贵的像素副本；
          // 回调真正放行时取当前 surface，正好得到最新画面并避免 4× 下
          // 每个客体帧都复制 800×600 像素。主线程路径仍使用上面的即时快照。
          const presented = frame ?? this.snapshotFrame(surface);
          if (presented) this.options.onFrame!(presented);
          // 调度等待期间 surface 可能又被 Blt/Flip/ReleaseDC 改过；不能让
          // frameScheduled 的合并把这次更新永久吞掉。Worker 在上一帧收到 ACK
          // 后会继续发送这份较新的快照；主线程路径仍由下一次 rAF 继续。
          if (this.options.deferFrameSnapshot) surface.dirty = false;
          if (surface.dirty && this.surfaces.has(surface.object)) this.emitFrame(surface);
        };
        const schedule = (): void => {
          this.frameScheduled = true;
          this.options.scheduleFrame!(present);
        };
        if (settleShell) {
          let postponed = false;
          const settle = (): void => {
            // 画面在等待窗口内又被动过：这是客体还在继续重绘，先不呈现中间态。
            if (!this.disposed && this.surfaces.has(surface.object) && surface.dirty && !postponed) {
              postponed = true;
              this.frameScheduled = true;
              surface.dirty = false;
              this.options.scheduleFrame!(settle);
              return;
            }
            present();
          };
          this.frameScheduled = true;
          this.options.scheduleFrame(settle);
          return;
        }
        schedule();
        return;
      }
      surface.dirty = false;
      this.captureFrame(surface);
    }

    /** 把当前硬件光标作为独立小纹理附在帧上；移动时宿主只重画 overlay。 */
    private attachCursor(frame: VmFrame): void {
      const showCount = this.readU32(HYPERCALL_CURSOR_COUNT) | 0;
      if (shimTraceEnabled('VM_TRACE_CURSOR')) {
        this.cursorDebugCount += 1;
        if (this.cursorDebugCount <= 8 || this.cursorDebugCount % 500 === 0) {
          console.log(
            `[cursor] #${this.cursorDebugCount} cur=0x${this.currentCursorHandle.toString(16)} class=0x${this.classCursor.toString(16)} showCount=${showCount} imgs=${this.cursorImages.size} rgba=${frame.rgba?.length ?? 0} pos=${this.cursorX},${this.cursorY}`,
          );
        }
      }
      if (showCount < 0) return;
      const handle = this.currentCursorHandle || this.classCursor;
      const img = this.cursorImages.get(handle);
      if (!img) return;
      frame.cursor = {
        handle,
        width: img.width,
        height: img.height,
        hotspotX: img.hotspotX,
        hotspotY: img.hotspotY,
        x: this.cursorX,
        y: this.cursorY,
        // Worker 会 transfer；必须复制，不能 detach cursorImages 的长驻缓存。
        rgba: img.rgba.slice(),
      };
    }

    /** 呈现边界上同步打包像素与调色板，供延迟呈现使用。 */
    protected snapshotFrame(surface: SurfaceState): VmFrame | null {
      const frame = this.snapshotFrameRaw(surface);
      if (frame) {
        this.presentedWidth = frame.width;
        this.presentedHeight = frame.height;
        // RA2 1.006 会在自己的鼠标处理器里再次按 GetClientRect 钳制坐标。
        // DirectDraw 已切到 1440×900 时，顶层 Win32 窗口却仍保留创建时的
        // 800×600，导致 host/shim 光标能到右下角、游戏内部仍只能到 799×599。
        // 呈现帧是最终显示边界，把它同步回窗口表，客体快速 GetClientRect 与
        // 浏览器 Pointer Lock 才共享同一坐标空间。
        const primaryRect = this.windowRects.get(this.primaryWindow);
        if (primaryRect && (primaryRect.width !== frame.width || primaryRect.height !== frame.height)) {
          this.windowRects.set(this.primaryWindow, {
            ...primaryRect,
            width: frame.width,
            height: frame.height,
          });
          this.syncWindowTreeToGuest(this.primaryWindow);
        }
        this.attachCursor(frame);
      }
      return frame;
    }

    private snapshotFrameRaw(surface: SurfaceState): VmFrame | null {
      if (!this.options.onFrame || surface.object !== this.primarySurface) return null;
      if (surface.bpp === 16) {
        if (this.options.packedRgb565Frames && !this.requiresRgbaComposite()) {
          // 独立快照才能 transfer：绝不能把 v86 的 WASM 内存交给主线程 detach。
          // 常规整行只做一次原生复制；奇数宽度按行跳过 DirectDraw pitch 填充。
          const size = surface.width * surface.height * 2;
          const rgb565 = new Uint16Array(this.options.takeFrameBuffer?.(size) ?? new ArrayBuffer(size));
          const target = new Uint8Array(rgb565.buffer);
          const source = this.memory.read_memory(surface.pixels, surface.pitch * surface.height);
          const rowBytes = surface.width * 2;
          if (rowBytes === surface.pitch) target.set(source);
          else
            for (let y = 0; y < surface.height; y++) {
              target.set(source.subarray(y * surface.pitch, y * surface.pitch + rowBytes), y * rowBytes);
            }
          return {
            width: surface.width,
            height: surface.height,
            pixels: new Uint8Array(0),
            palette: new Uint8Array(0),
            rgb565,
          };
        }
        const size = surface.width * surface.height * 4;
        const rgba = new Uint8Array(this.options.takeFrameBuffer?.(size) ?? new ArrayBuffer(size));
        const pixels = this.memory.read_memory(surface.pixels, surface.pitch * surface.height);
        // 16-bit 源按 Uint16 视图读取（地址偶数对齐时），避免每像素两次字节读+移位。
        const pixels16 =
          (pixels.byteOffset & 1) === 0 && (surface.pitch & 1) === 0
            ? new Uint16Array(pixels.buffer, pixels.byteOffset, (surface.pitch * surface.height) >>> 1)
            : null;
        // rgba 是本次新分配的数组，byteOffset 恒为 0，可直接按 32 位写入。
        const target32 = new Uint32Array(rgba.buffer);
        const pitch16 = surface.pitch >>> 1;
        // 把对齐判断移出百万像素的循环，行尾 padding 仍按 pitch 跳过。
        if (pixels16) {
          let target = 0;
          for (let y = 0; y < surface.height; y++) {
            const end = y * pitch16 + surface.width;
            for (let source = y * pitch16; source < end; source++) {
              target32[target++] = RGB565_TO_RGBA32[pixels16[source]!]!;
            }
          }
        } else {
          let target = 0;
          for (let y = 0; y < surface.height; y++) {
            const sourceRow = y * surface.pitch;
            for (let x = 0; x < surface.width; x++) {
              const offset = sourceRow + x * 2;
              const rgb565 = pixels[offset]! | (pixels[offset + 1]! << 8);
              target32[target++] = RGB565_TO_RGBA32[rgb565]!;
            }
          }
        }
        // USER32 标准控件外观保存为独立 RGBA 层：不要回写客体
        // DirectDraw 表面，但必须在最终帧快照上合成。隐藏控件会在
        // USER32 侧被过滤，因此 Campaign 初始化期的临时 ListBox 不会
        // 留下占位红框。
        this.compositeWindowControls(rgba, surface.width, surface.height);
        return {
          width: surface.width,
          height: surface.height,
          pixels: new Uint8Array(0),
          palette: new Uint8Array(0),
          rgba,
        };
      }
      const packed = new Uint8Array(surface.width * surface.height);
      const source = this.memory.read_memory(surface.pixels, surface.pitch * surface.height);
      if (surface.pitch === surface.width) {
        packed.set(source);
      } else {
        for (let y = 0; y < surface.height; y++) {
          packed.set(source.subarray(y * surface.pitch, y * surface.pitch + surface.width), y * surface.width);
        }
      }
      const palette = this.palettes.get(surface.palette)?.entries ?? new Uint8Array(256 * 4);
      return { width: surface.width, height: surface.height, pixels: packed, palette: palette.slice() };
    }

    protected captureFrame(surface: SurfaceState): void {
      const frame = this.snapshotFrame(surface);
      if (frame) this.options.onFrame!(frame);
    }
  };
}
