import type { SupportedGame, SupportedGameId } from './catalog';
import { ra2YrVmConfiguration } from './shared/vmConfiguration';

// 按所选游戏登记运行时工厂；共享实现是显式选择，不作为未知游戏的回退。
const runtimeFactories = {
  ra2: ra2YrVmConfiguration,
  yr: ra2YrVmConfiguration,
} satisfies Record<SupportedGameId, typeof ra2YrVmConfiguration>;

/** 主线程与 Worker 在本线程按相同游戏定义组装，不跨线程传递工厂。 */
export function gameVmConfiguration(
  game: Pick<SupportedGame, 'id'>,
  ...options: Parameters<typeof ra2YrVmConfiguration>
): ReturnType<typeof ra2YrVmConfiguration> {
  return runtimeFactories[game.id](...options);
}
