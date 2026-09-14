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

/** 游戏资源目录：使用 catalog 登记的实际安装目录名，其次兼容部分 worktree 的上级回退。
 *  VM_GAME_DIR 覆盖（相对 REPO_ROOT 或绝对路径）供精简包构成实证：对临时目录跑 e2e，
 *  收敛出遭遇战/联机所需文件集。 */
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
  // 本地全量测试允许跳过未安装的游戏；显式验收不能把缺资源伪装成通过。
  if (!available && process.env.VM_REQUIRE_GAME_RESOURCES === '1') {
    throw new Error(`真实游戏验收缺少 ${executable}；请配置 VM_GAME_DIR 或 game/ra2/`);
  }
  if (!available) {
    // 跳过必须显式可见：没有这一行，`pnpm test` 会在真实游戏用例一条都没执行的情况下显示全绿。
    console.warn(
      `[真实游戏] ${gameId} 已跳过：缺少 ${executable}。本次运行不构成真实游戏验收；` +
        `配置 VM_GAME_DIR 或用 VM_REQUIRE_GAME_RESOURCES=1 让缺资源直接失败。`,
    );
  }
  return available;
}
