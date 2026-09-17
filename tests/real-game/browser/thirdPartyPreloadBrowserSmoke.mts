/**
 * Verify on the real home page that both EXEs are requested before game selection and the package picker appears before downloads finish.
 */
import { chromium, expect } from '@playwright/test';
import { GAME_MANIFESTS } from '../../../src/games/manifest';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  // Test parallel downloads without cache, independent of the developer's local .tmp-third-party contents.
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
      await route.abort(); // Verify startup timing and nonblocking behavior without downloading game assets or disabling CDN TLS validation.
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
