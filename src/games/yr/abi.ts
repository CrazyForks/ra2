import { RA2_ABI } from '../ra2/abi';

/**
 * Yuri's Revenge 使用独立对象，避免把 gamemd.exe 后续补充的 ABI 或版本策略
 * 反向污染 RA2。公共 Win32 导入约定（含 IMM32 一组）继承同源的 RA2 表，
 * 这里只列 gamemd.exe 真正多出来的条目——重复登记同值条目会让两份表悄悄分叉。
 */
export const YR_ABI: Record<string, number> = {
  ...RA2_ABI,
  'KERNEL32.DLL!GetTempFileNameA': 16,
  'IMM32.DLL!ImmAssociateContext': 8,
};

export function yrWin32ArgBytes(dll: string, name: string): number {
  const key = `${dll.toUpperCase()}!${name}`;
  const bytes = YR_ABI[key];
  if (bytes === undefined) throw new Error(`未登记的 Yuri's Revenge Win32 ABI: ${key}`);
  return bytes;
}
