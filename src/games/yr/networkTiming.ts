import { makeLanStartupTiming, lanTimingCall } from '../shared/lanStartupTiming';
import type { GuestMemory } from '../../vm86/win32';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/** YR 1.001 独立验证的 LAN 开局路径；保留原生 Timing 和动态确认窗口。 */
const sites = [
  { address: 0x5b6546, expected: [185, 5, 0, 0, 0, 59, 198, 137, 13, 84, 181, 168, 0] },
  {
    address: 0x5baec5,
    expected: [184, 5, 0, 0, 0, 137, 21, 96, 235, 168, 0, 139, 21, 76, 178, 168, 0, 59, 214, 163, 84, 181, 168, 0],
  },
  { address: 0x5dd2d8, expected: [184, 5, 0, 0, 0, 59, 206, 163, 84, 181, 168, 0] },
  { address: 0x5dd498, expected: [184, 5, 0, 0, 0, 59, 207, 163, 84, 181, 168, 0] },
] as const;

// 缩短原生测量/协商的调度周期，仍等双方真实报告并按房间速度和 RTT 计算窗口。
// test cl,127 → test cl,31；mov al,[Frame]; test al,al → test al,63。
const negotiationSites = [
  { address: 0x6476bf, expected: [246, 193, 127, 15, 133, 186, 4, 0, 0], offset: 2, replacement: [31] },
  {
    address: 0x647ba7,
    expected: [160, 132, 237, 168, 0, 132, 192, 15, 133, 130, 3, 0, 0],
    offset: 5,
    replacement: [168, 63],
  },
] as const;

export function installYrLanTiming(
  memory: GuestMemory,
  exeHash: string,
  allocateCode: (code: number[]) => number,
): boolean {
  if (exeHash !== YR_STARTUP_PAGE_HASH) return false;
  for (const { address, expected } of [...sites, ...negotiationSites]) {
    const bytes = memory.read_memory(address, expected.length);
    if (bytes.length !== expected.length || !bytes.every((value, i) => value === expected[i])) {
      throw new Error('YR LAN 时序：指令签名不匹配或重复安装');
    }
  }
  // 初始间隔参与原版最小窗口计算，不能只改接收侧窗口或伪造帧确认。
  // 所有签名通过后分配独占客体桩；每次开局按房间档位初始化，协商仍可降速。
  const patches = sites.map(({ address, expected }) => ({
    address,
    bytes: lanTimingCall(address, allocateCode(makeLanStartupTiming(0xa8b268, 0xa8b558, expected[0], 2))),
  }));
  for (const { address, bytes } of patches) memory.write_memory(bytes, address);
  for (const { address, offset, replacement } of negotiationSites) {
    memory.write_memory([...replacement], address + offset);
  }
  return true;
}
