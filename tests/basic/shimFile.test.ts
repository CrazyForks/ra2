/**
 * Win32Shim 文件层单元测试（假客体内存）：挂载/_lopen/_lread/_llseek/_lclose、
 * CreateFileA 各 disposition 与错误码、写回 onFileWrite、客体内快速镜像表。
 */
import { describe, expect, it } from 'vitest';
import { FAST_FILE_ENTRY_BYTES, FAST_FILE_HANDLE_BASE, FAST_FILE_TABLE } from '../../src/vm86/shim/state';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeAsciiZ,
  type FakeGuestMemory,
} from '../helpers/guestMemory';
import type { Win32Shim } from '../../src/games/win32Shim';

const INVALID = 0xffff_ffff;
/** 测试字符串统一放这里（远离 shim 内部使用的低区）。 */
const STR = 0x0010_0000;
const BUF = 0x0011_0000;

function lopen(shim: Win32Shim, memory: FakeGuestMemory, path: string, flags = 0): number {
  writeAsciiZ(memory, STR, path);
  return callShim(shim, 'KERNEL32.DLL!_lopen', [STR, flags]).eax;
}
function lread(shim: Win32Shim, handle: number, count: number): number {
  return callShim(shim, 'KERNEL32.DLL!_lread', [handle, BUF, count]).eax;
}

describe('_lopen/_lread/_llseek/_lclose', () => {
  it('读挂载文件：顺序读、seek 后续读、EOF 归 0', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\data.bin', new Uint8Array([1, 2, 3, 4, 5]));
    const handle = lopen(shim, memory, 'C:\\GAME\\data.bin');
    expect(handle).not.toBe(INVALID);
    expect(lread(shim, handle, 3)).toBe(3);
    expect(memory.read_memory(BUF, 3)).toEqual(new Uint8Array([1, 2, 3]));
    // FILE_BEGIN 回到 1 再读
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 1, 0]).eax).toBe(1);
    expect(lread(shim, handle, 2)).toBe(2);
    expect(memory.read_memory(BUF, 2)).toEqual(new Uint8Array([2, 3]));
    // FILE_END 到末尾 → EOF
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 2]).eax).toBe(5);
    expect(lread(shim, handle, 1)).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [handle]).eax).toBe(0);
  });

  it('稀疏挂载保留完整逻辑长度，未提供的数据区按零读取', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('movies.mix', new Uint8Array([1, 2, 3, 4]), true, 100);
    const handle = lopen(shim, memory, 'movies.mix');
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 98, 0]).eax).toBe(98);
    expect(lread(shim, handle, 4)).toBe(2);
    expect(memory.read_memory(BUF, 2)).toEqual(new Uint8Array([0, 0]));
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 2]).eax).toBe(100);
  });

  it('稀疏挂载可在 ReadFile 前按区间补页而不分配完整容器', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('movies.mix', new Uint8Array([1, 2, 3, 4]), true, 10 * 1024 * 1024);
    shim.markFileRangeBacked('movies.mix');
    const handle = lopen(shim, memory, 'movies.mix');
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 3 * 1024 * 1024 + 7, 0]).eax).toBe(3 * 1024 * 1024 + 7);
    expect(shim.inspectFileReadRequest(handle, 4)).toEqual({
      path: 'movies.mix',
      offset: 2 * 1024 * 1024,
      length: 2 * 1024 * 1024,
      totalSize: 10 * 1024 * 1024,
    });
    shim.mountFileRange('movies.mix', 2 * 1024 * 1024, new Uint8Array(2 * 1024 * 1024).fill(0x5a));
    expect(shim.inspectFileReadRequest(handle, 4)).toBeNull();
    expect(lread(shim, handle, 4)).toBe(4);
    expect(memory.read_memory(BUF, 4)).toEqual(new Uint8Array([0x5a, 0x5a, 0x5a, 0x5a]));
  });

  it('打开缺失文件返回 HFILE_ERROR 并置 GetLastError=2', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(lopen(shim, memory, 'C:\\GAME\\nope.bin')).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(2);
  });

  it('_lcreat 对虚拟目录失败（ERROR_ACCESS_DENIED）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeAsciiZ(memory, STR, 'C:\\GAME');
    expect(callShim(shim, 'KERNEL32.DLL!_lcreat', [STR, 0]).eax).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(5);
  });

  it('_lcreat + _lwrite 写回：关闭时 onFileWrite 收到完整内容', () => {
    const memory = createGuestMemory();
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const shim = createTestShim(memory, {
      onFileWrite: (path, bytes) => writes.push({ path, bytes }),
    });
    writeAsciiZ(memory, STR, 'C:\\GAME\\out.sav');
    const handle = callShim(shim, 'KERNEL32.DLL!_lcreat', [STR, 0]).eax;
    expect(handle).not.toBe(INVALID);
    memory.write_memory(new Uint8Array([9, 8, 7]), BUF);
    expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, BUF, 3]).eax).toBe(3);
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [handle]).eax).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('game/out.sav');
    expect(writes[0]!.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(shim.getMountedFileBytes('C:\\GAME\\out.sav')).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('只读句柄写入被拒绝（ERROR_ACCESS_DENIED）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\ro.bin', new Uint8Array([1]));
    const handle = lopen(shim, memory, 'C:\\GAME\\ro.bin', 0); // OF_READ
    memory.write_memory([2], BUF);
    // writeFile 失败返回 -1（dispatch 层尚未按 u32 截断）。
    expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, BUF, 1]).eax).toBe(-1);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(5);
  });
});

describe('CreateFileA disposition', () => {
  const ACCESS_READ = 0x8000_0000;
  function createFile(shim: Win32Shim, memory: FakeGuestMemory, path: string, disposition: number): number {
    writeAsciiZ(memory, STR, path);
    return callShim(shim, 'KERNEL32.DLL!CreateFileA', [STR, ACCESS_READ, 0, 0, disposition, 0, 0]).eax;
  }

  it('OPEN_EXISTING 缺失 → INVALID + 2；存在 → 句柄 + 0', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(createFile(shim, memory, 'C:\\GAME\\none.bin', 3)).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(2);
    shim.mountFile('C:\\GAME\\yes.bin', new Uint8Array([1]));
    const handle = createFile(shim, memory, 'C:\\GAME\\yes.bin', 3);
    expect(handle).not.toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]).eax).toBe(1);
  });

  it('CREATE_NEW 已存在 → INVALID + 80；OPEN_ALWAYS 已存在 → 句柄 + 183', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\dup.bin', new Uint8Array([1]));
    expect(createFile(shim, memory, 'C:\\GAME\\dup.bin', 1)).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(80); // ERROR_FILE_EXISTS
    const handle = createFile(shim, memory, 'C:\\GAME\\dup.bin', 4);
    expect(handle).not.toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(183); // ERROR_ALREADY_EXISTS
  });

  it('CREATE_ALWAYS 截断已存在文件', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { onFileWrite: () => {} });
    shim.mountFile('C:\\GAME\\trunc.bin', new Uint8Array([1, 2, 3]));
    const handle = createFile(shim, memory, 'C:\\GAME\\trunc.bin', 2);
    expect(handle).not.toBe(INVALID);
    expect(shim.getMountedFileBytes('C:\\GAME\\trunc.bin')).toEqual(new Uint8Array());
  });

  it('盘根路径探测返回可关闭的哑句柄（CD 检查兼容）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const handle = createFile(shim, memory, 'C:\\', 3);
    expect(handle).not.toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]).eax).toBe(1);
  });
});

describe('客体内快速镜像（fast _lread 表）', () => {
  it('配置档案 allowlist 时仍镜像 Bink 叶文件', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      enableFastFileMirror: true,
      fastFileMirrorFiles: ['langmd.mix'],
    });
    shim.mountFile('C:\\GAME\\ra2ts_l.bik', new Uint8Array([1, 2, 3, 4]));
    const handle = lopen(shim, memory, 'C:\\GAME\\ra2ts_l.bik');
    const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    expect(readU32(memory, entry + 12)).toBe(1);

    shim.mountFile('C:\\GAME\\not-listed.bin', new Uint8Array([1, 2, 3, 4]));
    const excluded = lopen(shim, memory, 'C:\\GAME\\not-listed.bin');
    const excludedEntry = FAST_FILE_TABLE + (excluded - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    expect(readU32(memory, excludedEntry + 12)).toBe(0);
  });

  it('打开即镜像：句柄表项记录镜像地址/大小/位置/就绪标志', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { enableFastFileMirror: true });
    shim.mountFile('C:\\GAME\\fast.bin', new Uint8Array([1, 2, 3, 4, 5]));
    const handle = lopen(shim, memory, 'C:\\GAME\\fast.bin');
    const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    const mirror = readU32(memory, entry);
    expect(mirror).toBeGreaterThanOrEqual(0x0070_0000); // 镜像从 shim 堆分配
    expect(readU32(memory, entry + 4)).toBe(5); // 大小
    expect(readU32(memory, entry + 8)).toBe(0); // 位置
    expect(readU32(memory, entry + 12)).toBe(1); // 就绪
    expect(memory.read_memory(mirror, 5)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    // host 侧 _lread 与客体快速桩共用表内位置。
    expect(lread(shim, handle, 2)).toBe(2);
    expect(readU32(memory, entry + 8)).toBe(2);

    // 关闭归还镜像并清表项。
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [handle]).eax).toBe(0);
    expect(readU32(memory, entry + 12)).toBe(0);
  });

  it('客体写入时镜像降级回 hypercall 路径', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { enableFastFileMirror: true, onFileWrite: () => {} });
    shim.mountFile('C:\\GAME\\rw.bin', new Uint8Array([1, 2, 3, 4]));
    writeAsciiZ(memory, STR, 'C:\\GAME\\rw.bin');
    const handle = callShim(shim, 'KERNEL32.DLL!_lopen', [STR, 2]).eax; // OF_READWRITE
    const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    expect(readU32(memory, entry + 12)).toBe(1); // 已镜像
    memory.write_memory([9], BUF);
    expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, BUF, 1]).eax).toBe(1);
    expect(readU32(memory, entry + 12)).toBe(0); // 镜像已拆除
    expect(shim.getMountedFileBytes('C:\\GAME\\rw.bin')).toEqual(new Uint8Array([9, 2, 3, 4]));
  });

  it('持久只读镜像释放宿主副本，重开和慢读仍以客体镜像为准', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      enableFastFileMirror: true,
      fastFileMirrorBase: 0x00d0_0000,
      fastFileMirrorTop: 0x00e0_0000,
      fastFileMirrorLimit: 0x0010_0000,
    });
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    shim.mountFile('archive.mix', original, true);

    const first = lopen(shim, memory, 'archive.mix');
    expect(lread(shim, first, 3)).toBe(3);
    expect(memory.read_memory(BUF, 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [first]).eax).toBe(0);
    expect(shim.hasMountedFile('archive.mix')).toBe(true);

    const second = lopen(shim, memory, 'archive.mix');
    expect(lread(shim, second, 5)).toBe(5);
    expect(memory.read_memory(BUF, 5)).toEqual(original);
    expect(shim.getMountedFileBytes('archive.mix')).toEqual(original);
  });
});
