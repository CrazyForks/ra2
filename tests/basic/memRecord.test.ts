/** utils/memoryDiff.ts 单元测试：4 字节粒度内存 diff 与改动计数。 */
import { describe, expect, it } from 'vitest';
import { accumulateChangedWords, diffMemory } from '../../src/utils/memoryDiff';

describe('diffMemory', () => {
  it('完全一致 → 空 diff', () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    expect(diffMemory(a, b)).toEqual({ ranges: [], totalBytes: 0 });
  });

  it('单字改动 → 一个 4 字节区段', () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    b[9] = 1; // 落在字 [8,12)
    expect(diffMemory(a, b)).toEqual({ ranges: [{ from: 8, to: 12 }], totalBytes: 4 });
  });

  it('相邻改动字合并，间隔断开', () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    b[4] = 1;
    b[8] = 1; // 字 1、2 相邻 → [4,12)
    b[40] = 2; // 字 10 独立
    expect(diffMemory(a, b)).toEqual({
      ranges: [
        { from: 4, to: 12 },
        { from: 40, to: 44 },
      ],
      totalBytes: 12,
    });
  });

  it('末尾改动闭合到最后一个字', () => {
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);
    b[15] = 9;
    expect(diffMemory(a, b)).toEqual({ ranges: [{ from: 12, to: 16 }], totalBytes: 4 });
  });

  it('长度不同按较短者对齐到字', () => {
    const a = new Uint8Array(16);
    const b = new Uint8Array(10); // 10 >>> 2 = 2 个字，只覆盖字节 [0,8)
    b[7] = 1;
    expect(diffMemory(a, b).ranges).toEqual([{ from: 4, to: 8 }]);
    b[9] = 1; // 字 [8,12) 超出较短者的字范围，不计入
    expect(diffMemory(a, b).ranges).toEqual([{ from: 4, to: 8 }]);
  });
});

describe('accumulateChangedWords', () => {
  it('按字计数并支持重复累加', () => {
    const counts = new Map<number, number>();
    const prev = new Uint8Array(16);
    const current = new Uint8Array(16);
    current[0] = 1;
    expect(accumulateChangedWords(prev, current, counts, 8)).toBe(false);
    expect(counts.get(0)).toBe(1);
    current[0] = 2;
    expect(accumulateChangedWords(prev, current, counts, 8)).toBe(false);
    expect(counts.get(0)).toBe(2);
  });

  it('地址数到上限后截断新地址、已有地址仍累加', () => {
    const counts = new Map<number, number>();
    const prev = new Uint8Array(16);
    const current = new Uint8Array(16);
    current[0] = 1;
    current[4] = 1;
    accumulateChangedWords(prev, current, counts, 1);
    expect(counts.size).toBe(1);
    // 再改另一个新地址 → 截断；旧地址继续累加。
    current[0] = 2;
    current[8] = 1;
    const truncated = accumulateChangedWords(prev, current, counts, 1);
    expect(truncated).toBe(true);
    expect(counts.size).toBe(1);
    expect(counts.get(0)).toBe(2);
  });
});
