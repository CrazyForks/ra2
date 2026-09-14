/** 从真实首页验证：未选游戏就请求两个 EXE，下载未结束也能显示选包界面。 */
import { chromium, expect } from '@playwright/test';
import { GAME_MANIFESTS } from '../../../src/games/manifest';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // 此用例测无缓存时的并行下载，不受开发者本地 .tmp-third-party 内容影响。
  await context.route('**/__third-party/*', (route) => route.fulfill({ status: 404, body: '' }));
  const urls = Object.values(GAME_MANIFESTS).flatMap((manifest) => manifest.thirdParty.map((file) => file.url));
  const requests: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const url of urls)
    await context.route(url, async (route) => {
      requests.push(route.request().url());
      await gate;
      await route.abort(); // 验证启动时机和非阻塞性，不下载游戏资源或关闭 CDN TLS 校验。
    });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => [...requests].sort()).toEqual([...urls].sort());
  await expect(page.locator('.game-package-block')).toHaveCount(2);
  await expect(page.locator('.game-package-block').first()).toBeVisible();
  release();
  await expect(page.locator('.game-package-block').last()).toBeVisible();
  console.log('首页未选游戏时两个 EXE 已并行请求，下载悬挂不阻塞选包界面，通过');
} finally {
  await browser.close();
}
