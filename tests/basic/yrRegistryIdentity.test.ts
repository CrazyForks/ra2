import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

function fixture(gameId?: 'ra2' | 'yr') {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { gameId });
  writeAsciiZ(memory, 0x1000, "SOFTWARE\\Westwood\\Yuri's Revenge");
  writeAsciiZ(memory, 0x1100, 'Serial');
  callShim(shim, 'ADVAPI32.DLL!RegOpenKeyExA', [0x80000002, 0x1000, 0, 0x20019, 0x1200]);
  const handle = readU32(memory, 0x1200);
  const query = (capacity = 128, destination = 0x1400) => {
    writeU32(memory, 0x1300, capacity);
    const result = callShim(shim, 'ADVAPI32.DLL!RegQueryValueExA', [handle, 0x1100, 0, 0x1304, destination, 0x1300]);
    return {
      result: result.eax,
      size: readU32(memory, 0x1300),
      type: readU32(memory, 0x1304),
      bytes: memory.read_memory(0x1400, readU32(memory, 0x1300)).slice(),
    };
  };
  return { memory, shim, handle, query };
}

describe('YR 虚拟安装会话身份', () => {
  it('两个 VM 不共享空序号，同一 VM 多次读取保持稳定', () => {
    const a = fixture('yr'),
      b = fixture('yr');
    const first = a.query();
    expect(first.result).toBe(0);
    expect(first.type).toBe(1);
    expect(first.size).toBe(23);
    expect(new TextDecoder().decode(first.bytes)).toMatch(/^\d{22}\0$/);
    expect(a.query().bytes).toEqual(first.bytes);
    expect(b.query().bytes).not.toEqual(first.bytes);
  });

  it('长度查询和小缓冲遵循 Win32 语义，不重复生成或越界写入', () => {
    const f = fixture('yr');
    expect(f.query(0, 0)).toMatchObject({ result: 0, size: 23, type: 1 });
    f.memory.bytes.fill(0xcc, 0x1400, 0x1420);
    expect(f.query(22)).toMatchObject({ result: 234, size: 23 });
    expect(f.memory.read_memory(0x1400, 32)).toEqual(new Uint8Array(32).fill(0xcc));
    expect(f.query(23).result).toBe(0);
    expect(f.memory.bytes[0x1417]).toBe(0xcc);
  });

  it('客体显式写入优先于会话默认值', () => {
    const f = fixture('yr');
    const initial = f.query().bytes;
    writeAsciiZ(f.memory, 0x1500, 'explicit-value');
    expect(callShim(f.shim, 'ADVAPI32.DLL!RegSetValueExA', [f.handle, 0x1100, 0, 1, 0x1500, 15]).eax).toBe(0);
    expect(new TextDecoder().decode(f.query().bytes)).toBe('explicit-value\0');
    callShim(f.shim, 'ADVAPI32.DLL!RegDeleteValueA', [f.handle, 0x1100]);
    expect(f.query().bytes).toEqual(initial);
  });

  it.each(['ra2', undefined] as const)('不影响其他 profile（%s）或未知注册表键', (gameId) => {
    expect(fixture(gameId).query().result).toBe(2);
    const f = fixture('yr');
    writeAsciiZ(f.memory, 0x1100, 'Unknown');
    expect(f.query().result).toBe(2);
  });
});
