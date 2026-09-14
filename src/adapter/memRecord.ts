/** VM 内存录制的跨线程结果契约。 */
export interface GuestMemRecordResult {
  /** 结束时刻与起始基线的改动总字节数。 */
  totalBytes: number;
  /** 结束时刻的改动区段数。 */
  rangeCount: number;
  /** 录制期间的采样次数（含结束时刻最后一次）。 */
  samples: number;
  /** 计数地址达到上限后截断（不再记录新地址）。 */
  truncated: boolean;
  /** 按修改次数降序（同次数按地址升序）的地址统计；地址 4 字节对齐。 */
  counts: Array<{ address: number; count: number }>;
}
