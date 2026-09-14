/**
 * Red Alert 2 专用真实 EXE 冒烟入口。
 *
 * 冒烟本体已迁移到按游戏拆分的 Vitest（tests/real-game/ra2/boot.test.ts），这里
 * 转发所有 VM_* 环境变量，保持 `pnpm run test:vm:ra2` 的调用习惯不变。
 */
import { spawnSync } from 'node:child_process';

if (process.env.VM_GAME && process.env.VM_GAME !== 'ra2') {
  throw new Error(`ra2Smoke 不接受 VM_GAME=${process.env.VM_GAME}`);
}

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/real-game/ra2/boot.test.ts', '--disableConsoleIntercept'],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
process.exit(result.status ?? 1);
