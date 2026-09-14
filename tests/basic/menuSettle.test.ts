/**
 * 菜单壳页“静默合并”呈现策略：
 * 菜单页两阶段重绘（擦旧高亮/画新高亮）常分属不同客体帧，worker 背压路径会
 * 各自呈现，中间态直接上屏 → 点击选择时高亮闪烁。壳页下呈现回调若发现画面
 * 仍被继续修改，就再等一轮（最多一次），把擦+画合并成最终状态；
 * 对战中（壳页为空）保持原语义。
 *
 * 单测 shim 没有 guestSurfaceFastPath：Unlock 本身不置 dirty，因此每次呈现
 * 驱动用 Lock（置 dirty）→ Unlock（触发 emit）成对调用。
 */
import { describe, expect, it } from 'vitest';
import type { VmFrame } from '../../src/vm86/win32';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

const W = 800;
const H = 600;

function setup(shellVisible: boolean) {
  const memory = createGuestMemory();
  const frames: VmFrame[] = [];
  const queued: Array<() => void> = [];
  const shim = createTestShim(memory, {
    gameId: 'ra2',
    onFrame: (frame) => frames.push(frame),
    scheduleFrame: (emit) => queued.push(emit),
    deferFrameSnapshot: true,
  });
  if (shellVisible) {
    // 全屏 #32770 对话框 + 可见标题控件（id 1684）→ isShellVisible() = true。
    writeAsciiZ(memory, 0x50_000, '#32770');
    const dialog = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      0x50_000,
      0,
      0x1000_0000,
      0,
      0,
      W,
      H,
      0,
      0,
      0,
      0,
    ]).eax;
    writeAsciiZ(memory, 0x50_100, 'Static');
    callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x50_100, 0, 0x5000_0000, 0, 0, 200, 20, dialog, 1684, 0, 0]);
    (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'choosemap';
  }
  callShim(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, W, H, 16]);
  const desc = 0x10_000;
  const out = 0x10_100;
  writeU32(memory, desc, 108);
  writeU32(memory, desc + 4, 6 | 1);
  writeU32(memory, desc + 8, H);
  writeU32(memory, desc + 12, W);
  writeU32(memory, desc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
  const result = callShim(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
  if (result.eax !== 0) throw new Error(`CreateSurface failed: ${result.eax}`);
  const primary = readU32(memory, out);
  const draw = (): void => {
    // Lock 置 dirty，Unlock 触发 emit（内容不变，只驱动呈现状态机）。
    callShim(shim, 'DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, desc, 0]);
    callShim(shim, 'DDRAW.COM!IDirectDrawSurface.Unlock', [primary, 0]);
  };
  const runScheduled = (): number => {
    let count = 0;
    while (queued.length) {
      const emit = queued.shift()!;
      count++;
      emit();
    }
    return count;
  };
  return { memory, frames, queued, shim, primary, draw, runScheduled };
}

describe('菜单壳页呈现静默合并', () => {
  it('等待窗口内的第二次重绘合并成一次呈现（不呈现擦旧中间态）', () => {
    const page = setup(true);
    page.draw(); // 第一次重绘：擦掉旧高亮
    expect(page.queued.length).toBe(1);
    expect(page.frames).toHaveLength(0); // 回调未放行，尚无呈现

    page.draw(); // 回调放行前客体又完成第二次重绘：画新高亮
    const runs = page.runScheduled();
    // 第一次回调发现画面仍在变化 → 推迟一轮；第二轮才呈现最终画面。
    expect(runs).toBe(2);
    expect(page.frames).toHaveLength(1);
    expect(page.queued).toHaveLength(0);
  });

  it('持续重绘（动画）时最多推迟一轮，不会饿死呈现', () => {
    const page = setup(true);
    page.draw();
    expect(page.runScheduled()).toBe(1);
    expect(page.frames).toHaveLength(1);
    page.draw();
    page.runScheduled();
    expect(page.frames).toHaveLength(2);
  });

  it('对战中（无壳页）保持原有逐帧呈现语义', () => {
    const page = setup(false);
    page.draw();
    expect(page.queued.length).toBe(1);
    expect(page.frames).toHaveLength(0);
    page.runScheduled();
    // defer 快照在回调放行时刻取 surface：等待期间的更新已并入这张帧。
    expect(page.frames).toHaveLength(1);
    expect(page.frames[0]!.width).toBe(W);
    expect(page.queued).toHaveLength(0);
    // 后续新重绘继续按原节奏呈现。
    page.draw();
    page.runScheduled();
    expect(page.frames).toHaveLength(2);
  });
});
