/**
 * 游戏分辨率偏好的本地持久化（拆分自 page.ts）：
 * 存储键与解析复用 games/resolution，页面与工具栏动作共用。
 */
import { gameResolutionValue, parseGameResolution, type GameResolution } from '../../../games/resolution';
import type { SupportedGameId } from '../../../games/catalog';

const STORED_RESOLUTION_PREFIX = 'vm-resolution-';

export function loadStoredResolution(gameId: SupportedGameId): GameResolution | null {
  try {
    return parseGameResolution(window.localStorage.getItem(`${STORED_RESOLUTION_PREFIX}${gameId}`));
  } catch {
    return null;
  }
}

export function storeResolution(gameId: SupportedGameId, resolution: GameResolution | null): void {
  try {
    const key = `${STORED_RESOLUTION_PREFIX}${gameId}`;
    if (resolution) window.localStorage.setItem(key, gameResolutionValue(resolution));
    else window.localStorage.removeItem(key);
  } catch {
    // 隐私模式等场景无法持久化；本次重启后仍安全回退原 INI。
  }
}
