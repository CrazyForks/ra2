import { defineConfig } from 'vitest/config';

// 独立包准入：协议、客户端、真实 WS 服务与分发，不读取游戏素材。
export default defineConfig({
  test: {
    // 避免误提交 it.only / describe.only 后，CI 只执行部分测试却显示通过。
    allowOnly: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
