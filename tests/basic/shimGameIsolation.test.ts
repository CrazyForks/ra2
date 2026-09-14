/** 游戏兼容能力必须显式开启，默认 shim 不继承任何已支持游戏的补丁。 */
import { describe, expect, it } from 'vitest';
import { RA2_SHIM_PROFILE } from '../../src/games/ra2/profile';
import { YR_SHIM_PROFILE } from '../../src/games/yr/profile';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ } from '../helpers/guestMemory';

describe('游戏 shim 隔离', () => {
  it('RA2 与 YR profile 显式开启各自能力', () => {
    expect(RA2_SHIM_PROFILE.virtualWinsockLan).toBe(true);
    expect(RA2_SHIM_PROFILE.launcher?.handle).toBe(0x0001_0020);
    expect(YR_SHIM_PROFILE.launcher?.protectedData).toBe('UIDATA,3DDATA,MAPS');
  });

  it('默认 profile 不接管 RA2 的 XWIS 与 Winsock 导入', () => {
    const shim = createTestShim(createGuestMemory());
    expect(() => callShim(shim, 'XWIS.DLL!ord1')).toThrow(/未实现的导入/);
    expect(() => callShim(shim, 'WSOCK32.DLL!ord115', [0x0101, 0x2000])).toThrow(/未实现的导入/);
  });

  it('RA2 profile 才开启 XWIS 与虚拟 Winsock', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameProfile: RA2_SHIM_PROFILE });
    expect(callShim(shim, 'XWIS.DLL!ord1').eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord115', [0x0101, 0x2000]).eax).toBe(0);
    expect(memory.read_memory(0x2000, 4)).toEqual(new Uint8Array([1, 1, 1, 1]));
  });

  it('XWIS launcher 哨兵不会泄漏到默认同步对象层', () => {
    const name = 0x3000;
    const baseMemory = createGuestMemory();
    writeAsciiZ(baseMemory, name, '48bc11bd-c4d7-466b-8a31-c6abbad47b3e');
    const base = createTestShim(baseMemory);
    expect(callShim(base, 'KERNEL32.DLL!OpenMutexA', [0, 0, name]).eax).toBe(0);

    const ra2Memory = createGuestMemory();
    writeAsciiZ(ra2Memory, name, '48bc11bd-c4d7-466b-8a31-c6abbad47b3e');
    const ra2 = createTestShim(ra2Memory, { gameProfile: RA2_SHIM_PROFILE });
    expect(callShim(ra2, 'KERNEL32.DLL!OpenMutexA', [0, 0, name]).eax).toBe(0x0001_0020);
  });

  it('YR profile 代替 launcher 回送 WM_BEEF 共享内存校验串', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameProfile: YR_SHIM_PROFILE });
    const message = 0x3000;

    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [message, 0, 0xbeef, 0xbeef, 1]).eax).toBe(1);
    expect(readU32(memory, message + 4)).toBe(0xbeef);
    const view = callShim(shim, 'KERNEL32.DLL!MapViewOfFileEx', [
      readU32(memory, message + 12),
      0xf001f,
      0,
      0,
      0,
      0,
    ]).eax;
    expect(new TextDecoder().decode(memory.read_memory(view, 18))).toBe('UIDATA,3DDATA,MAPS');
  });
});
