import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { gameResourcesAvailable } from '../real-game/helpers/gameDir';

afterEach(() => vi.unstubAllEnvs());

describe('真实游戏资源准入', () => {
  // Use a file path as the directory to avoid accidentally matching a game installed on the development machine.
  const missingDirectory = fileURLToPath(new URL('./gameResourceGate.test.ts', import.meta.url));

  it('普通开发允许缺少游戏资源', () => {
    vi.stubEnv('VM_GAME_DIR', missingDirectory);
    vi.stubEnv('VM_REQUIRE_GAME_RESOURCES', '');
    expect(gameResourcesAvailable('ra2')).toBe(false);
  });

  it.each(['ra2', 'yr'] as const)('严格验收 %s 时缺资源必须失败', (gameId) => {
    vi.stubEnv('VM_GAME_DIR', missingDirectory);
    vi.stubEnv('VM_REQUIRE_GAME_RESOURCES', '1');
    expect(() => gameResourcesAvailable(gameId)).toThrow('真实游戏验收缺少');
  });

  it('跳过时必须可见，不能让缺资源静默显示为通过', () => {
    vi.stubEnv('VM_GAME_DIR', missingDirectory);
    vi.stubEnv('VM_REQUIRE_GAME_RESOURCES', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(gameResourcesAvailable('ra2')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ra2 已跳过'));
    } finally {
      warn.mockRestore();
    }
  });
});
