/** 按 4 字节粒度比较内存快照；不依赖 VM 或录制会话。 */
export interface MemoryDiff {
  /** 按地址升序的改动区段；to 为排他终点，4 字节对齐。 */
  ranges: Array<{ from: number; to: number }>;
  totalBytes: number;
}

/** 按 4 字节粒度对比两段等长内存，连续改动字合并为区段（升序）。 */
export function diffMemory(base: Uint8Array, current: Uint8Array): MemoryDiff {
  const words = Math.min(base.length, current.length) >>> 2;
  const ranges: Array<{ from: number; to: number }> = [];
  let runStart = -1;
  for (let i = 0; i < words; i++) {
    const offset = i << 2;
    const changed =
      base[offset] !== current[offset] ||
      base[offset + 1] !== current[offset + 1] ||
      base[offset + 2] !== current[offset + 2] ||
      base[offset + 3] !== current[offset + 3];
    if (changed) {
      if (runStart < 0) runStart = offset;
    } else if (runStart >= 0) {
      ranges.push({ from: runStart, to: offset });
      runStart = -1;
    }
  }
  if (runStart >= 0) ranges.push({ from: runStart, to: words << 2 });
  let totalBytes = 0;
  for (const range of ranges) totalBytes += range.to - range.from;
  return { ranges, totalBytes };
}

/** 把 current 相对 prev 的改动字计数累加进 counts（键 = 地址，值 = 被采样到修改的次数）。
 *  新地址数达到 maxAddresses 后不再新增、只累加已有地址；返回是否发生截断。 */
export function accumulateChangedWords(
  prev: Uint8Array,
  current: Uint8Array,
  counts: Map<number, number>,
  maxAddresses: number,
): boolean {
  const words = Math.min(prev.length, current.length) >>> 2;
  let truncated = false;
  for (let i = 0; i < words; i++) {
    const offset = i << 2;
    if (
      prev[offset] !== current[offset] ||
      prev[offset + 1] !== current[offset + 1] ||
      prev[offset + 2] !== current[offset + 2] ||
      prev[offset + 3] !== current[offset + 3]
    ) {
      const existing = counts.get(offset);
      if (existing !== undefined) counts.set(offset, existing + 1);
      else if (counts.size < maxAddresses) counts.set(offset, 1);
      else truncated = true;
    }
  }
  return truncated;
}
