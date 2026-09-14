/**
 * Win32Shim 堆/虚拟内存单元测试（假客体内存，不起 v86）：
 * HeapAlloc 空闲链表复用与合并、HEAP_ZERO_MEMORY、VirtualAlloc 保留区
 * 与堆 arena 互斥、MEM_RELEASE 回收复用。
 */
import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim } from '../helpers/guestMemory';

const HEAP_BASE = 0x0070_0000;

function heapAlloc(shim: Parameters<typeof callShim>[0], size: number, zero = false): number {
  return callShim(shim, 'KERNEL32.DLL!HeapAlloc', [0x1_0001, zero ? 8 : 0, size]).eax;
}
function heapFree(shim: Parameters<typeof callShim>[0], ptr: number): number {
  return callShim(shim, 'KERNEL32.DLL!HeapFree', [0x1_0001, 0, ptr]).eax;
}
function virtualAlloc(shim: Parameters<typeof callShim>[0], requested: number, size: number): number {
  return callShim(shim, 'KERNEL32.DLL!VirtualAlloc', [requested, size, 0x3000, 4]).eax;
}
function virtualFree(shim: Parameters<typeof callShim>[0], addr: number, size: number, type: number): number {
  return callShim(shim, 'KERNEL32.DLL!VirtualFree', [addr, size, type]).eax;
}
function lastError(shim: Parameters<typeof callShim>[0]): number {
  return callShim(shim, 'KERNEL32.DLL!GetLastError').eax;
}

describe('HeapAlloc / HeapFree', () => {
  it('bump 分配：地址自堆底向上、16 字节对齐', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const a = heapAlloc(shim, 64);
    const b = heapAlloc(shim, 1); // 对齐到 16
    expect(a).toBe(HEAP_BASE);
    expect(b).toBe(a + 64);
    expect(a % 16).toBe(0);
    const state = shim.inspectHeapState();
    expect(state.liveAllocations).toBe(2);
    expect(state.liveBytes).toBe(64 + 16);
  });

  it('HEAP_ZERO_MEMORY 清零；不带标志复用块保留旧数据', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const a = heapAlloc(shim, 32);
    memory.write_memory(new Uint8Array(32).fill(0xaa), a);
    expect(heapFree(shim, a)).toBe(1);
    const b = heapAlloc(shim, 32); // 复用同一空闲块
    expect(b).toBe(a);
    expect(memory.read_memory(b, 4)).toEqual(new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]));
    expect(heapFree(shim, b)).toBe(1);
    const c = heapAlloc(shim, 32, true);
    expect(c).toBe(a);
    expect(memory.read_memory(c, 32)).toEqual(new Uint8Array(32));
  });

  it('相邻释放块合并后可装下更大的分配', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const a = heapAlloc(shim, 64);
    const b = heapAlloc(shim, 64);
    const c = heapAlloc(shim, 64);
    expect(heapFree(shim, a)).toBe(1);
    expect(heapFree(shim, b)).toBe(1); // 与 a 合并成 128
    const big = heapAlloc(shim, 100); // 对齐 112 ≤ 128
    expect(big).toBe(a);
    expect(heapFree(shim, c)).toBe(1);
  });

  it('重复释放/野指针释放返回 0', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const a = heapAlloc(shim, 16);
    expect(heapFree(shim, a)).toBe(1);
    expect(heapFree(shim, a)).toBe(0);
    expect(heapFree(shim, 0x1234_5678)).toBe(0);
  });

  it('GlobalAlloc 零初始化；GlobalFree 失败原样返回句柄', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(new Uint8Array(16).fill(0xbb), HEAP_BASE);
    const ptr = callShim(shim, 'KERNEL32.DLL!GlobalAlloc', [0x40, 16]).eax; // GMEM_ZEROINIT
    expect(ptr).toBe(HEAP_BASE);
    expect(memory.read_memory(ptr, 16)).toEqual(new Uint8Array(16));
    expect(callShim(shim, 'KERNEL32.DLL!GlobalFree', [ptr]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GlobalFree', [0xdead_beef]).eax).toBe(0xdead_beef);
  });
});

describe('VirtualAlloc / VirtualFree', () => {
  it('NULL 保留自虚拟区顶端向下分配，提交零填充', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const base = virtualAlloc(shim, 0, 0x1000);
    expect(base).toBe(0x00c0_0000 - 0x1000); // virtualTop 向下
    expect(memory.read_memory(base, 16)).toEqual(new Uint8Array(16));
    const state = shim.inspectHeapState();
    expect(state.virtualRegions).toBe(1);
    expect(state.virtualBytes).toBe(0x1000);
  });

  it('保留区内提交原样返回地址；MEM_DECOMMIT 清零但保留区域', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const base = virtualAlloc(shim, 0, 0x1000);
    expect(virtualAlloc(shim, base + 0x100, 0x100)).toBe(base + 0x100);
    memory.write_memory([0xaa, 0xbb], base + 0x100);
    expect(virtualFree(shim, base + 0x100, 0x100, 0x4000)).toBe(1); // MEM_DECOMMIT
    expect(memory.read_memory(base + 0x100, 2)).toEqual(new Uint8Array(2));
    expect(shim.inspectHeapState().virtualRegions).toBe(1); // 区域仍在
  });

  it('与活动堆分配重叠的固定地址请求被拒绝（487）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const heap = heapAlloc(shim, 64);
    expect(virtualAlloc(shim, heap, 64)).toBe(0);
    expect(lastError(shim)).toBe(487); // ERROR_INVALID_ADDRESS
  });

  it('堆 bump 指针跳过 VirtualAlloc 固定保留区（arena 互斥）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const heap = heapAlloc(shim, 64); // 占 [0x700000, 0x700040)
    const reserved = virtualAlloc(shim, HEAP_BASE + 0x40, 0x2000); // 钉在 bump 指针前
    expect(reserved).toBe(HEAP_BASE + 0x40);
    const next = heapAlloc(shim, 64);
    expect(next).toBe(HEAP_BASE + 0x40 + 0x2000); // 跳过保留区
    expect(heap).toBe(HEAP_BASE);
  });

  it('MEM_RELEASE 归还区域，下一次 NULL 保留自顶向下复用', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const base = virtualAlloc(shim, 0, 0x1000);
    expect(virtualFree(shim, base, 0, 0x8000)).toBe(1);
    expect(shim.inspectHeapState().virtualRegions).toBe(0);
    expect(shim.inspectHeapState().virtualFreeBytes).toBe(0x1000);
    expect(virtualAlloc(shim, 0, 0x1000)).toBe(base); // 复用同一区域
  });

  it('MEM_RELEASE 非基址与未知区域失败', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const base = virtualAlloc(shim, 0, 0x1000);
    expect(virtualFree(shim, base + 0x100, 0, 0x8000)).toBe(0); // 非基址
    expect(virtualFree(shim, 0x0060_0000, 0, 0x8000)).toBe(0); // 不在任何保留区
    expect(shim.inspectHeapState().virtualRegions).toBe(1);
  });
});
