import type { GuestMemory } from '../../vm86/win32';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { writeGameSpeedFlag } from '../shared/gameSpeedFlag';
import { skipStartupMovieBlock } from '../shared/startupMovieSkip';
import { createYrFrameReader } from './performance';
import { installYrBattleStartup } from './battleStartup';
import { installYrLanStartup, installYrSkirmishStartup } from './startupPage';

const YR_STARTUP_MOVIE_BLOCK = 0x0052_c5e0;
const YR_STARTUP_MOVIE_CONTINUATION = 0x0052_c5f3;
const YR_STARTUP_MOVIE_SIGNATURE = [0x8b, 0xd5, 0xb9, 0x20, 0x5f] as const;
const YR_SETTINGS_POINTER = 0x0088_71e0;
const YR_GAME_SPEED_OFFSET = 0x14a0;

/** 只接受原版七档 0..6；Settings 单例指针与字段偏移见 YR_SETTINGS_POINTER。 */
export function writeYrGameSpeed(memory: GuestMemory, value: number): number | null {
  return writeGameSpeedFlag(memory, YR_SETTINGS_POINTER, YR_GAME_SPEED_OFFSET, value);
}

/**
 * YR 1.001 在 0x52c5e0 无条件构造并播放 EA_WWLOGO；与 RA2 的 WESTLOGO
 * 分支不同，它没有可用的 INI 开关。跳到 0x52c5f3 保留影片子系统的原生共同
 * 收尾，但不创建启动影片窗口。战役简报和局内 EVA 小窗走其他调用点，不受影响。
 */
export function skipYrStartupMovies(memory: GuestMemory): boolean {
  return skipStartupMovieBlock(
    memory,
    YR_STARTUP_MOVIE_BLOCK,
    YR_STARTUP_MOVIE_CONTINUATION,
    YR_STARTUP_MOVIE_SIGNATURE,
  );
}

export const YR_RUNTIME_HOOKS: GameRuntimeHooks = Object.freeze({
  createFrameReader: createYrFrameReader,
  prepareStartupPage(memory: GuestMemory, page: string, hash: string, reserve: (size: number) => number): void {
    if (page === 'battle') {
      installYrBattleStartup(memory, reserve, hash);
      return;
    }
    if (page === 'lan') {
      installYrLanStartup(memory, reserve, hash);
      return;
    }
    if (page !== 'skirmish') throw new Error(`YR 尚不支持直达页面：${page}`);
    installYrSkirmishStartup(memory, reserve, hash);
  },
  prepareImage: skipYrStartupMovies,
  writeGameSpeedFlag: writeYrGameSpeed,
});
