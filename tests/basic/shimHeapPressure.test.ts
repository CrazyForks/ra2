import { describe, expect, it } from 'vitest';
import { Win32Shim } from '../../src/games/win32Shim';
import { callShim, createGuestMemory, readU32, writeU32 } from '../helpers/guestMemory';

const PROCESS_HEAP = 0x1_0001;

function fixture() {
  const memory = createGuestMemory();
  const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
  return { memory, shim };
}

function exhaustHeap(shim: Win32Shim): void {
  while (callShim(shim, 'KERNEL32.DLL!HeapAlloc', [PROCESS_HEAP, 0, 0x10000]).eax);
  while (callShim(shim, 'KERNEL32.DLL!HeapAlloc', [PROCESS_HEAP, 0, 16]).eax);
}

describe('长局堆压力下的 shim 行为', () => {
  it('堆耗尽时 CreateSoundBuffer 返回 DSERR_OUTOFMEMORY，而不是成功但给空缓冲', () => {
    const { memory, shim } = fixture();
    exhaustHeap(shim);
    const desc = 0x1000,
      out = 0x1200;
    writeU32(memory, desc, 20); // dwSize
    writeU32(memory, desc + 8, 0x8000); // dwBufferBytes
    writeU32(memory, out, 0xdead_beef);
    const lowMemory = memory.read_memory(0, 32).slice();
    const result = callShim(shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0x3000, desc, out, 0], 0x2000);
    expect(result.eax).toBe(0x8007_000e);
    expect(readU32(memory, out)).toBe(0);
    expect(memory.read_memory(0, 32)).toEqual(lowMemory);
  });
});
