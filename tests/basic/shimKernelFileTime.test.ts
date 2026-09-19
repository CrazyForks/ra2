import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';

const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

function writeFileTime(memory: ReturnType<typeof createGuestMemory>, ptr: number, value: bigint): void {
  writeU32(memory, ptr, Number(value & 0xffff_ffffn));
  writeU32(memory, ptr + 4, Number(value >> 32n));
}

function readFileTime(memory: ReturnType<typeof createGuestMemory>, ptr: number): bigint {
  return BigInt(readU32(memory, ptr)) | (BigInt(readU32(memory, ptr + 4)) << 32n);
}

function readSystemTime(memory: ReturnType<typeof createGuestMemory>, ptr: number): number[] {
  const bytes = memory.read_memory(ptr, 16);
  return Array.from({ length: 8 }, (_, i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8));
}

describe('KERNEL32 FILETIME 转换', () => {
  it('FileTimeToLocalFileTime 使用与 GetTimeZoneInformation 相同的宿主偏移', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const utc = FILETIME_UNIX_EPOCH + 1_700_000_000_000n * 10_000n;
    writeFileTime(memory, 0x3000, utc);

    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0x3000, 0x3010]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeZoneInformation', [0x3100]).eax).toBe(0);
    const bias = BigInt(readU32(memory, 0x3100) | 0);
    expect(readFileTime(memory, 0x3010)).toBe(utc - bias * 600_000_000n);
  });

  it('FileTimeToLocalFileTime 偏移越界时失败而不回绕', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeZoneInformation', [0x3100]).eax).toBe(0);
    const bias = readU32(memory, 0x3100) | 0;
    // Pick whichever end the host's bias pushes past: east of UTC overflows the top, west underflows below zero.
    // The old code masked the result into range and still reported success.
    writeFileTime(memory, 0x3000, bias <= 0 ? 0xffff_ffff_ffff_ffffn : 1n);
    writeFileTime(memory, 0x3010, 0xdead_beefn);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0x3000, 0x3010]).eax).toBe(bias === 0 ? 1 : 0);
    if (bias !== 0) expect(readFileTime(memory, 0x3010)).toBe(0xdead_beefn);
  });

  it('FileTimeToLocalFileTime 拒绝空指针', () => {
    const shim = createTestShim(createGuestMemory());
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0, 0x3010]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0x3000, 0]).eax).toBe(0);
  });

  it('FileTimeToSystemTime 与 SystemTimeToFileTime 往返一致，含星期几', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    // 2026-09-19 16:41:07.123, a Saturday.
    memory.write_memory(new Uint8Array(new Uint16Array([2026, 9, 0, 19, 16, 41, 7, 123]).buffer), 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!SystemTimeToFileTime', [0x3000, 0x3020]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToSystemTime', [0x3020, 0x3040]).eax).toBe(1);
    expect(readSystemTime(memory, 0x3040)).toEqual([2026, 9, 6, 19, 16, 41, 7, 123]);
  });

  it('FileTimeToSystemTime 拒绝符号位置位的 FILETIME', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeFileTime(memory, 0x3000, 0x8000_0000_0000_0000n);
    memory.write_memory(new Uint8Array(16).fill(0xa5), 0x3040);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToSystemTime', [0x3000, 0x3040]).eax).toBe(0);
    expect(memory.read_memory(0x3040, 16)).toEqual(new Uint8Array(16).fill(0xa5));
  });
});
