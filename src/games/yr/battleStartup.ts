import type { GuestMemory } from '../../vm86/win32';
import { installBattleStartup } from '../shared/battleStartup';
import { YR_STARTUP_PAGE_HASH, installYrSkirmishStartup } from './startupPage';

/** YR 1.001：设置页返回点在 0x6ae34e，原生开局处理器在 0x6acee0。 */
const YR_BATTLE = {
  label: 'YR 战场直达',
  expectedHash: YR_STARTUP_PAGE_HASH,
  site: 0x006a_e34e,
  handler: 0x006a_cee0,
  navigate: installYrSkirmishStartup,
} as const;

/** 单人测试入口；不发送输入事件，也不绕过选项校验与场景加载。 */
export function installYrBattleStartup(memory: GuestMemory, reserve: (size: number) => number, hash: string): number {
  return installBattleStartup(memory, reserve, hash, YR_BATTLE);
}
