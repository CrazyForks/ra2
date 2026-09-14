import type { GuestMemory } from '../../vm86/win32';
import { installStartupTrampoline } from '../shared/startupTrampoline';

export const YR_STARTUP_PAGE_HASH = '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6';
const SITE = 0x0052_db12;
const SIGNATURE = [
  0xbe, 0x12, 0, 0, 0, 0xeb, 0x0d, 0x33, 0xc9, 0x83, 0xf8, 0x04, 0x0f, 0x94, 0xc1, 0x83, 0xc1, 0x10, 0x8b, 0xf1,
];
/** 原生状态保存在 ESI（RA2 用 EBP）：`mov esi, 18` 后由 `mov esi, ecx` 收尾。 */
const MOV_OPERAND = 0x35;

/** YR 1.001 独立入口：0x52D713 的遭遇战按钮返回11，分发表 0x52EB58
 * 以状态+1索引到 0x52E10F，设置 Session=5 并执行原生初始化。 */
export function installYrSkirmishStartup(memory: GuestMemory, reserve: (size: number) => number, hash: string): number {
  return installStartupTrampoline(memory, reserve, hash, {
    label: 'YR 遭遇战直达',
    expectedHash: YR_STARTUP_PAGE_HASH,
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 11,
  });
}

/** YR 独立主菜单状态 3 分支在 0x52DD75，使用 ESI 保存后续状态。 */
export function installYrLanStartup(memory: GuestMemory, reserve: (size: number) => number, hash: string): number {
  return installStartupTrampoline(memory, reserve, hash, {
    label: 'YR LAN 直达',
    expectedHash: YR_STARTUP_PAGE_HASH,
    site: SITE,
    signature: SIGNATURE,
    movOperand: MOV_OPERAND,
    target: 3,
  });
}
