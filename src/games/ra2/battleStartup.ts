import type { GuestMemory } from '../../vm86/win32';
import { installBattleStartup } from '../shared/battleStartup';
import { RA2_STARTUP_PAGE_HASH, installRa2SkirmishStartup } from './startupPage';

/** RA2 1.006：设置页返回点在 0x683c79，原生开局处理器在 0x6829f0。 */
const RA2_BATTLE = {
  label: 'RA2 战场直达',
  expectedHash: RA2_STARTUP_PAGE_HASH,
  site: 0x0068_3c79,
  handler: 0x0068_29f0,
  navigate: installRa2SkirmishStartup,
} as const;

/** 单人测试入口；不发送输入事件，也不绕过选项校验与场景加载。 */
export function installRa2BattleStartup(memory: GuestMemory, reserve: (size: number) => number, hash: string): number {
  return installBattleStartup(memory, reserve, hash, RA2_BATTLE);
}
