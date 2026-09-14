import type { GuestMemory } from '../../vm86/win32';
import { installStartupTrampoline } from '../shared/startupTrampoline';

export const RA2_STARTUP_PAGE_HASH = '06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb';
const SITE = 0x0051_3762;
const SIGNATURE = [
  0xbd, 0x12, 0, 0, 0, 0xeb, 0x0d, 0x33, 0xc9, 0x83, 0xf8, 0x04, 0x0f, 0x94, 0xc1, 0x83, 0xc1, 0x10, 0x8b, 0xe9,
];
/** 原生状态保存在 EBP：`mov ebp, 18` 后由 `mov ebp, eax` 收尾。 */
const MOV_OPERAND = 0x2d;

/**
 * 原版 1.006：Main_Game 首次菜单状态默认 EBP=18；SinglePlayer 的遭遇战
 * 按钮在 0x513363 返回 11，分发表 0x5146F4 将其送到 0x513D93。
 * 只替换初始状态选择，保留设置页的原生初始化、消息泵及返回路径。
 */
export function installRa2SkirmishStartup(
  memory: GuestMemory,
  reserve: (size: number) => number,
  hash: string,
): number {
  return installStartupTrampoline(memory, reserve, hash, {
    label: 'RA2 遭遇战直达',
    expectedHash: RA2_STARTUP_PAGE_HASH,
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 11,
  });
}

/** 原生主菜单 LAN 按钮返回状态 3；先由原版设置会话与网络协议，再进入 Lobby。
 * 不能直接选状态 16，否则会跳过 Session=3 及协议初始化。 */
export function installRa2LanStartup(memory: GuestMemory, reserve: (size: number) => number, hash: string): number {
  return installStartupTrampoline(memory, reserve, hash, {
    label: 'RA2 LAN 直达',
    expectedHash: RA2_STARTUP_PAGE_HASH,
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 3,
  });
}
