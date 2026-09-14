import { defineConfig } from 'vitest/config';

// Basic 不依赖游戏；真实游戏另置 tests/real-game，CI 严格模式不允许缺资源。
export default defineConfig({
  test: {
    // 避免误提交 it.only / describe.only 后，CI 只执行部分测试却显示通过。
    allowOnly: false,
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
