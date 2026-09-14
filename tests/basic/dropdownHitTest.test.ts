/**
 * 展开下拉的命中优先级：
 * 行 2 下拉展开时其弹出区覆盖到行 4 所在 Y 范围，点弹层上的条目必须命中
 * 行 2 的下拉（真实 Win32 弹层浮于平级控件之上），而不是底下同级的行 4
 * 控件。回归场景：Skirmish 设置页"在行 2 选了难度，行 4 被误翻开"。
 */
import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

const X = 100;
const ROW_Y2 = 30;
const ROW_Y4 = 70;
const W = 200;
const H = 20;

interface Tree {
  memory: ReturnType<typeof createGuestMemory>;
  shim: ReturnType<typeof createTestShim>;
  row2: number;
  row4: number;
}

function buildTree(): Tree {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { gameId: 'ra2' });
  // 顶层 #32770 页（800×600 可见）→ primaryWindow。
  writeAsciiZ(memory, 0x60_000, '#32770');
  const page = callShim(
    shim,
    'USER32.DLL!CreateWindowExA',
    [0, 0x60_000, 0, 0x1000_0000, 0, 0, 800, 600, 0, 0, 0, 0],
  ).eax;
  // 两行平级 ComboBox（第 2 行与第 4 行位置）。
  writeAsciiZ(memory, 0x60_100, 'ComboBox');
  const make = (y: number, id: number): number =>
    callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x60_100, 0, 0x5000_0000, X, y, W, H, page, id, 0, 0]).eax;
  const row2 = make(ROW_Y2, 1771);
  const row4 = make(ROW_Y4, 1772);
  return { memory, shim, row2, row4 };
}

/** 宿主在 (screenX, screenY) 按一下，返回该消息实际投递到的目标 hwnd。 */
function clickTarget(tree: Tree, screenX: number, screenY: number): number {
  const { shim } = tree;
  shim.setCursorPosition(screenX, screenY);
  shim.postMessage(0x0201, 0x0001, (screenY << 16) | (screenX & 0xffff));
  const trace = shim.inspectHostInputTrace();
  return trace.at(-1)!.hwnd;
}

describe('展开下拉命中优先级', () => {
  it('行 2 下拉展开且弹出区覆盖行 4 时，点行 4 区域命中行 2', () => {
    const tree = buildTree();
    const { shim, row2 } = tree;
    // 游戏打开行 2 下拉：CB_SHOWDROPDOWN + 全高布局把 drop extent 记为 120。
    callShim(shim, 'USER32.DLL!SendMessageA', [row2, 0x014f, 1, 0]);
    callShim(shim, 'USER32.DLL!MoveWindow', [row2, X, ROW_Y2, W, 120, 1]);
    // 点击点落在行 4 的行内、同时落在行 2 的展开区内。
    const target = clickTarget(tree, X + 60, ROW_Y4 + 8);
    expect(target).toBe(row2);
  });

  it('行 2 收起时，同一位置命中行 4（不误伤平级控件）', () => {
    const tree = buildTree();
    const { shim, row2, row4 } = tree;
    callShim(shim, 'USER32.DLL!SendMessageA', [row2, 0x014f, 1, 0]);
    callShim(shim, 'USER32.DLL!MoveWindow', [row2, X, ROW_Y2, W, 120, 1]);
    callShim(shim, 'USER32.DLL!SendMessageA', [row2, 0x014f, 0, 0]); // 收起
    const target = clickTarget(tree, X + 60, ROW_Y4 + 8);
    expect(target).toBe(row4);
  });
});
