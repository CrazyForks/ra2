import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_GAMES, type SupportedGameId } from '../../../src/games/catalog';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Game resource directory: use the actual installation directory registered in the catalog, with a parent-directory fallback for some worktrees.
 * VM_GAME_DIR overrides (relative to REPO_ROOT or absolute) support trimmed-package evidence: run e2e on temporary directories to identify the file set required for skirmish/multiplayer.
 */
export function resolveGameDir(gameId: SupportedGameId): string {
  const override = process.env.VM_GAME_DIR;
  if (override) return resolve(REPO_ROOT, override);
  const game = SUPPORTED_GAMES.find((item) => item.id === gameId);
  if (!game) throw new Error(`未知游戏: ${gameId}`);
  const candidates = [resolve(REPO_ROOT, 'game', game.folder), resolve(REPO_ROOT, '..', '..', 'game', game.folder)];
  return candidates.find(isDirectory) ?? candidates[0]!;
}

export function gameResourceExe(gameId: SupportedGameId): string {
  const game = SUPPORTED_GAMES.find((item) => item.id === gameId);
  if (!game) throw new Error(`未知游戏: ${gameId}`);
  const directory = resolveGameDir(gameId);
  return join(directory, game.executable);
}

export function gameResourcesAvailable(gameId: SupportedGameId): boolean {
  const executable = gameResourceExe(gameId);
  const available = existsSync(executable);
  // Full local test runs may skip uninstalled games; explicit acceptance must not disguise missing assets as a pass.
  if (!available && process.env.VM_REQUIRE_GAME_RESOURCES === '1') {
    throw new Error(`真实游戏验收缺少 ${executable}；请配置 VM_GAME_DIR 或 game/ra2/`);
  }
  if (!available) {
    // Skipping must be visible: without this line, pnpm test could report all green without running a single real-game case.
    console.warn(
      `[真实游戏] ${gameId} 已跳过：缺少 ${executable}。本次运行不构成真实游戏验收；` +
        `配置 VM_GAME_DIR 或用 VM_REQUIRE_GAME_RESOURCES=1 让缺资源直接失败。`,
    );
  }
  return available;
}
