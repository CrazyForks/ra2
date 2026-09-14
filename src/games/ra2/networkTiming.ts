import { makeLanStartupTiming, lanTimingCall } from '../shared/lanStartupTiming';
import type { GuestMemory } from '../../vm86/win32';
import { RA2_STARTUP_PAGE_HASH } from './startupPage';

/** RA2 1.006 的四条 LAN 开局路径。初始间隔也参与原生最小窗口计算；
 * 后续 Timing 事件仍由原版协商，不固定 MaxAhead 或绕过确认。 */
const sites = [
  { address: 0x597ba6, expected: [185, 5, 0, 0, 0, 59, 198, 137, 13, 100, 213, 163, 0] },
  {
    address: 0x59c4ef,
    expected: [184, 5, 0, 0, 0, 137, 21, 24, 11, 164, 0, 139, 21, 172, 210, 163, 0, 59, 214, 163, 100, 213, 163, 0],
  },
  { address: 0x5bde16, expected: [184, 5, 0, 0, 0, 59, 206, 163, 100, 213, 163, 0] },
  { address: 0x5bdfd0, expected: [184, 5, 0, 0, 0, 59, 207, 163, 100, 213, 163, 0] },
] as const;

// 缩短原生测量/协商的调度周期，仍等双方真实报告并按房间速度和 RTT 计算窗口。
// test cl,127 → test cl,31；mov al,[Frame]; test al,al → test al,63。
const negotiationSites = [
  { address: 0x623bcf, expected: [246, 193, 127, 15, 133, 186, 4, 0, 0], offset: 2, replacement: [31] },
  {
    address: 0x6240b7,
    expected: [160, 44, 13, 164, 0, 132, 192, 15, 133, 130, 3, 0, 0],
    offset: 5,
    replacement: [168, 63],
  },
] as const;

export function installRa2LanTiming(
  memory: GuestMemory,
  exeHash: string,
  allocateCode: (code: number[]) => number,
): boolean {
  // YR 和未知 EXE 保留原行为；不能把 RA2 地址写进其他映像。
  if (exeHash !== RA2_STARTUP_PAGE_HASH) return false;
  for (const { address, expected } of [...sites, ...negotiationSites]) {
    const bytes = memory.read_memory(address, expected.length);
    if (bytes.length !== expected.length || !bytes.every((value, i) => value === expected[i])) {
      throw new Error('RA2 LAN 时序：指令签名不匹配或重复安装');
    }
  }
  // 50ms RTT 对照保留 3 帧作为等待与同步余量的折中；不改时钟或确认消息。
  // 所有签名通过后分配独占客体桩；每次开局按房间档位初始化，协商仍可降速。
  const patches = sites.map(({ address, expected }) => ({
    address,
    bytes: lanTimingCall(address, allocateCode(makeLanStartupTiming(0xa3d2c8, 0xa3d568, expected[0], 3))),
  }));
  for (const { address, bytes } of patches) memory.write_memory(bytes, address);
  for (const { address, offset, replacement } of negotiationSites) {
    memory.write_memory([...replacement], address + offset);
  }
  return true;
}
