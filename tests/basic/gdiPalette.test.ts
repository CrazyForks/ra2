/**
 * GDI 调色板 smoke 迁移：8-bit 离屏 surface 上的文字在调色板换页时随
 * run 幂等重映射（SetEntries/Flip/Blt 三条路径），加载期间不提交中间帧，
 * 以及 rAF 延迟呈现的帧必须携带 emit 时刻的调色板。
 *
 * 注意：第一个 it 刻意保持原脚本的顺序累积状态——后段（加载帧事务、
 * Flip、Blt）依赖前段创建的 palette/primary/offscreen 与文字已重映射到
 * index 210/60 的事实，因此不拆分组。
 */
import { describe, expect, it } from 'vitest';
import type { Win32Shim } from '../../src/games/win32Shim';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';

const rulerColor = 0x009c_dcfb; // COLORREF RGB(251, 220, 156)

const textRasterizer = {
  rasterize: () => ({ width: 1, height: 1, alpha: new Uint8Array([255]), threshold: 96 }),
};

const surfaceDesc = (memory: FakeGuestMemory, address: number, caps: number) => {
  writeU32(memory, address, 108);
  writeU32(memory, address + 4, 6); // DDSD_HEIGHT | DDSD_WIDTH
  writeU32(memory, address + 8, 4);
  writeU32(memory, address + 12, 4);
  writeU32(memory, address + 104, caps);
};

/** 原脚本的 dispatch：断言导入已实现且返回 DD_OK。 */
const dispatchOk = (shim: Win32Shim, key: string, args: number[]) => {
  expect(callShim(shim, key, args).eax, `${key} 应返回 DD_OK`).toBe(0);
};

describe('GDI 调色板换页重映射（原 gdiPaletteSmoke）', () => {
  it('文字随 SetEntries 重映射；加载期间不提交中间帧；Flip/Blt 后 run 跟随像素', () => {
    const memory = createGuestMemory();
    let frames = 0;
    const shim = createTestShim(memory, {
      onFrame: () => {
        frames++;
      },
      textRasterizer,
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);

    const primaryDesc = 0x10_000;
    const primaryOut = 0x10_100;
    surfaceDesc(memory, primaryDesc, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, primaryDesc, primaryOut, 0]);
    const primary = readU32(memory, primaryOut);

    const paletteBytes = 0x11_000;
    const paletteOut = 0x11_500;
    const initial = new Uint8Array(256 * 4);
    initial.set([222, 222, 168, 0], 40 * 4);
    memory.write_memory(initial, paletteBytes);
    dispatch('DDRAW.COM!IDirectDraw.CreatePalette', [0, 4, paletteBytes, paletteOut, 0]);
    const palette = readU32(memory, paletteOut);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetPalette', [primary, palette]);

    const offscreenDesc = 0x12_000;
    const offscreenOut = 0x12_100;
    surfaceDesc(memory, offscreenDesc, 0);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, offscreenDesc, offscreenOut, 0]);
    const offscreen = readU32(memory, offscreenOut);
    const dcOut = 0x12_200;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetDC', [offscreen, dcOut]);
    const dc = readU32(memory, dcOut);

    expect(callShim(shim, 'GDI32.DLL!SetTextColor', [dc, rulerColor]).eax).toBe(0);
    memory.write_memory([0x41], 0x12_300);
    expect(callShim(shim, 'GDI32.DLL!TextOutA', [dc, 0, 0, 0x12_300, 1]).eax).toBe(1);
    expect(shim.inspectSurface(offscreen)?.pixels[0], '文字初次映射到旧调色板 index 40').toBe(40);

    const finalPalette = new Uint8Array(256 * 4);
    finalPalette.set([255, 0, 0, 0], 40 * 4); // 旧 index 在战场调色板中为红色
    finalPalette.set([251, 220, 156, 0], 210 * 4); // 关卡名/君主名的正确黄橙色
    memory.write_memory(finalPalette, paletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);

    expect(shim.inspectGdiDc(dc)?.paletteIndex).toBe(210);
    expect(shim.inspectSurface(offscreen)?.pixels[0], '调色板切换后字形应重映射到 index 210').toBe(210);

    const stableFrames = frames;
    writeU32(memory, 0x004a_f234, 1); // 原版大地图/关卡加载中
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);
    expect(frames, '加载期间不应提交调色板/分块绘制中间帧').toBe(stableFrames);
    writeU32(memory, 0x004a_f234, 0);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, 0]);
    expect(frames, '加载完成后应恢复提交完整帧').toBe(stableFrames + 1);

    // Flip 回归：后缓冲文字 → 翻页 → 调色板换页。run 必须跟像素一起交换，
    // 否则前台字形停在旧索引（新调色板里通常是白色），重绘才恢复。
    const flipDesc = 0x14_000;
    const flipOut = 0x14_100;
    writeU32(memory, flipDesc, 108);
    writeU32(memory, flipDesc + 4, 0x26); // DDSD_HEIGHT | DDSD_WIDTH | DDSD_BACKBUFFERCOUNT
    writeU32(memory, flipDesc + 8, 4);
    writeU32(memory, flipDesc + 12, 4);
    writeU32(memory, flipDesc + 20, 1); // 1 个后缓冲
    writeU32(memory, flipDesc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, flipDesc, flipOut, 0]);
    const flipPrimary = readU32(memory, flipOut);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetPalette', [flipPrimary, palette]);

    const backOut = 0x14_200;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetAttachedSurface', [flipPrimary, 0, backOut, 0]);
    const back = readU32(memory, backOut);
    const backDcOut = 0x14_300;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetDC', [back, backDcOut]);
    const backDc = readU32(memory, backDcOut);
    expect(callShim(shim, 'GDI32.DLL!SetTextColor', [backDc, rulerColor]).eax).toBe(0);
    memory.write_memory([0x42], 0x14_400);
    expect(callShim(shim, 'GDI32.DLL!TextOutA', [backDc, 0, 0, 0x14_400, 1]).eax).toBe(1);
    expect(shim.inspectSurface(back)?.pixels[0], '后缓冲文字落在当前调色板的黄橙 index 210').toBe(210);

    dispatch('DDRAW.COM!IDirectDrawSurface.Flip', [flipPrimary, 0, 0]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Flip 后前台持有后缓冲像素').toBe(210);

    const flippedPalette = new Uint8Array(256 * 4);
    flippedPalette.set([255, 255, 255, 0], 210 * 4); // 旧 index 在新调色板是白色（bug 症状）
    flippedPalette.set([251, 220, 156, 0], 60 * 4);
    memory.write_memory(flippedPalette, paletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Flip 后换页，前台字形应随像素归属的 run 重映射').toBe(60);

    // Blt 回归：offscreen 文字 blit 到主表面后，字形像素的 run 必须跟过去，
    // 否则换页时目标面上的文字停旧索引（变白）。offscreen 上现在有 index 60 的字形。
    const blitDestRect = 0x15_000;
    writeU32(memory, blitDestRect, 0);
    writeU32(memory, blitDestRect + 4, 0);
    writeU32(memory, blitDestRect + 8, 1);
    writeU32(memory, blitDestRect + 12, 1);
    const blitSourceRect = 0x15_020;
    writeU32(memory, blitSourceRect, 0);
    writeU32(memory, blitSourceRect + 4, 0);
    writeU32(memory, blitSourceRect + 8, 1);
    writeU32(memory, blitSourceRect + 12, 1);
    dispatch('DDRAW.COM!IDirectDrawSurface.Blt', [flipPrimary, blitDestRect, offscreen, blitSourceRect, 0, 0]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Blt 后主表面持有 offscreen 字形像素').toBe(60);

    const blitPalette = new Uint8Array(256 * 4);
    blitPalette.set([255, 255, 255, 0], 60 * 4); // 旧 index 在新调色板是白色
    blitPalette.set([251, 220, 156, 0], 90 * 4);
    memory.write_memory(blitPalette, paletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Blt 后换页，主表面字形应随携带的 run 重映射').toBe(90);
  });

  it('rAF 延迟呈现：emit 后、回调前换调色板，帧仍携带 emit 时刻的调色板', () => {
    // 旧像素套新调色板 = 文字变白的历史症状。
    const memory = createGuestMemory();
    let pendingEmit: (() => void) | null = null;
    let delivered: { pixels: Uint8Array; palette: Uint8Array } | null = null;
    const scheduledShim = createTestShim(memory, {
      onFrame: (frame) => {
        delivered = { pixels: frame.pixels, palette: frame.palette };
      },
      scheduleFrame: (emit) => {
        pendingEmit = emit;
      },
      textRasterizer,
    });
    const dispatch = (key: string, args: number[]) => callShim(scheduledShim, key, args).eax;

    const schedDesc = 0x16_000;
    const schedOut = 0x16_100;
    surfaceDesc(memory, schedDesc, 0x200);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, schedDesc, schedOut, 0]);
    const schedPrimary = readU32(memory, schedOut);
    const schedPaletteBytes = 0x16_200;
    const schedPaletteOut = 0x16_700;
    const oldPalette = new Uint8Array(256 * 4);
    oldPalette.set([251, 220, 156, 0], 40 * 4); // 文字金橙
    memory.write_memory(oldPalette, schedPaletteBytes);
    dispatch('DDRAW.COM!IDirectDraw.CreatePalette', [0, 4, schedPaletteBytes, schedPaletteOut, 0]);
    const schedPalette = readU32(memory, schedPaletteOut);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetPalette', [schedPrimary, schedPalette]);
    const schedDcOut = 0x16_800;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetDC', [schedPrimary, schedDcOut]);
    const schedDc = readU32(memory, schedDcOut);
    expect(callShim(scheduledShim, 'GDI32.DLL!SetTextColor', [schedDc, rulerColor]).eax).toBe(0);
    memory.write_memory([0x43], 0x16_900);
    expect(callShim(scheduledShim, 'GDI32.DLL!TextOutA', [schedDc, 0, 0, 0x16_900, 1]).eax).toBe(1);

    // 主表面 DC 释放触发呈现（游戏在主表面画完即 ReleaseDC 的常见路径）。
    expect(callShim(scheduledShim, 'USER32.DLL!ReleaseDC', [0, schedDc]).eax).toBe(1);
    expect(pendingEmit, 'scheduleFrame 应挂起一次呈现').toBeTruthy();
    // emit 之后、回调之前：客体把 index 40 换成白色。
    const newPalette = new Uint8Array(256 * 4);
    newPalette.set([255, 255, 255, 0], 40 * 4);
    memory.write_memory(newPalette, schedPaletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [schedPalette, 0, 0, 256, schedPaletteBytes]);
    const fire = pendingEmit!;
    pendingEmit = null;
    fire();
    expect(delivered, '回调应交付一帧').toBeTruthy();
    expect(delivered!.pixels[0], `帧像素应指向 index 40，实得 ${delivered!.pixels[0]}`).toBe(40);
    expect(
      [...delivered!.palette.subarray(40 * 4, 40 * 4 + 4)],
      '延迟呈现的帧必须携带 emit 时刻的调色板（金橙），而不是回调时的白色',
    ).toEqual([251, 220, 156, 0]);
  });
});

describe('GDI 画刷句柄与 DirectDraw Blt 几何（RA2 增补，原 gdiPaletteSmoke）', () => {
  it('CreateSolidBrush 返回有效 HBRUSH，DeleteObject 不可重复释放', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const brush = callShim(shim, 'GDI32.DLL!CreateSolidBrush', [0x0012_3456]).eax;
    expect(brush, 'CreateSolidBrush 应返回有效 HBRUSH').not.toBe(0);
    expect(callShim(shim, 'GDI32.DLL!DeleteObject', [brush]).eax, 'DeleteObject 应释放 HBRUSH').toBe(1);
    expect(callShim(shim, 'GDI32.DLL!DeleteObject', [brush]).eax, '重复释放 HBRUSH 应失败').toBe(0);
  });

  // DirectDraw UI 动画回归：Blt 必须缩放而不是裁掉源表面的右/下部分；
  // BltFast 的负目标坐标必须裁剪，不能写到 surface.pixels 之前。
  it('Blt 缩放采样完整源图；BltFast 负目标坐标裁剪且不越界写', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);

    const offscreenDesc = 0x12_000;
    const offscreenOut = 0x12_100;
    surfaceDesc(memory, offscreenDesc, 0);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, offscreenDesc, offscreenOut, 0]);
    const offscreen = readU32(memory, offscreenOut);

    const flipDesc = 0x14_000;
    const flipOut = 0x14_100;
    writeU32(memory, flipDesc, 108);
    writeU32(memory, flipDesc + 4, 0x26); // DDSD_HEIGHT | DDSD_WIDTH | DDSD_BACKBUFFERCOUNT
    writeU32(memory, flipDesc + 8, 4);
    writeU32(memory, flipDesc + 12, 4);
    writeU32(memory, flipDesc + 20, 1); // 1 个后缓冲
    writeU32(memory, flipDesc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, flipDesc, flipOut, 0]);
    const flipPrimary = readU32(memory, flipOut);

    const geometryDesc = 0x17_000;
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [offscreen, 0, geometryDesc, 0, 0]);
    const geometrySourcePixels = readU32(memory, geometryDesc + 36);
    memory.write_memory(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), geometrySourcePixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [offscreen, geometrySourcePixels]);
    const scaledDestRect = 0x17_100;
    writeU32(memory, scaledDestRect, 0);
    writeU32(memory, scaledDestRect + 4, 0);
    writeU32(memory, scaledDestRect + 8, 2);
    writeU32(memory, scaledDestRect + 12, 2);
    const fullSourceRect = 0x17_120;
    writeU32(memory, fullSourceRect, 0);
    writeU32(memory, fullSourceRect + 4, 0);
    writeU32(memory, fullSourceRect + 8, 4);
    writeU32(memory, fullSourceRect + 12, 4);
    dispatch('DDRAW.COM!IDirectDrawSurface.Blt', [flipPrimary, scaledDestRect, offscreen, fullSourceRect, 0, 0]);
    const scaled = shim.inspectSurface(flipPrimary)!.pixels;
    expect([scaled[0], scaled[1], scaled[4], scaled[5]], '4×4 → 2×2 Blt 应采样完整源图，而不是复制左上 2×2').toEqual([
      1, 3, 9, 11,
    ]);

    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [flipPrimary, 0, geometryDesc, 0, 0]);
    const geometryDestPixels = readU32(memory, geometryDesc + 36);
    memory.write_memory(new Uint8Array(16), geometryDestPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [flipPrimary, geometryDestPixels]);
    const byteBeforeDest = memory.read_memory(geometryDestPixels - 1, 1)[0];
    dispatch('DDRAW.COM!IDirectDrawSurface.BltFast', [flipPrimary, 0xffff_ffff, 0, offscreen, fullSourceRect, 0]);
    const clipped = shim.inspectSurface(flipPrimary)!.pixels;
    expect([...clipped.subarray(0, 4)], 'x=-1 的 BltFast 应裁掉源图第一列').toEqual([2, 3, 4, 0]);
    expect(memory.read_memory(geometryDestPixels - 1, 1)[0], '负坐标 BltFast 不得写到目标 surface 之前').toBe(
      byteBeforeDest,
    );
  });
});
