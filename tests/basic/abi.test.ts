/** RA2/YR Win32 ABI 表的关键 stdcall 参数字节数。 */
import { describe, expect, it } from 'vitest';
import { RA2_ABI } from '../../src/games/ra2/abi';
import { YR_ABI } from '../../src/games/yr/abi';

describe('RA2/YR Win32 ABI 表', () => {
  it('RA2 独立 ABI 表已登记（XWIS/CreateProcessA/WSOCK32/BinkW32）', () => {
    expect(RA2_ABI['XWIS.DLL!ord1']).toBe(0);
    expect(RA2_ABI['KERNEL32.DLL!CreateProcessA']).toBe(40);
    expect(RA2_ABI['WSOCK32.DLL!ord1111']).toBe(12);
    expect(RA2_ABI['BINKW32.DLL!_BinkCopyToBuffer@28']).toBe(28);
  });

  it('YR 在独立对象中补充输入法和临时文件接口', () => {
    expect(YR_ABI).not.toBe(RA2_ABI);
    expect(YR_ABI['KERNEL32.DLL!GetTempFileNameA']).toBe(16);
    expect(YR_ABI['IMM32.DLL!ImmGetContext']).toBe(4);
    expect(RA2_ABI['KERNEL32.DLL!GetTempFileNameA']).toBeUndefined();
  });

  it('YR 只补充 RA2 未登记的项，不静默改写继承来的清理字节数', () => {
    // 重复登记同值条目会让两份表悄悄分叉，改写继承值则是一次真实的 ABI 变更，
    // 两种都要在评审时可见，而不是藏在展开里。
    expect(Object.keys(YR_ABI).filter((key) => !(key in RA2_ABI))).toEqual([
      'KERNEL32.DLL!GetTempFileNameA',
      'IMM32.DLL!ImmAssociateContext',
    ]);
    expect(Object.keys(YR_ABI).filter((key) => key in RA2_ABI && RA2_ABI[key] !== YR_ABI[key])).toEqual([]);
  });
});
