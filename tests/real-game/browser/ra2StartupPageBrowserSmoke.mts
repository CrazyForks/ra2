/** 真实 RA2/YR 主程序：验证 Worker / 主线程均直达设置页与 LAN 大厅，默认入口不变。需要本地游戏资源。 */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const relay = process.env.RA2_BROWSER_RELAY;
assert.ok(!process.env.RA2_BROWSER_GAME || ['ra2', 'yr'].includes(process.env.RA2_BROWSER_GAME));
assert.ok(
  !process.env.RA2_BROWSER_STARTUP_MODE ||
    ['worker', 'main', 'default', 'lan-worker', 'lan-main'].includes(process.env.RA2_BROWSER_STARTUP_MODE),
);
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  for (const game of ['ra2', 'yr'].filter(
    (game) => !process.env.RA2_BROWSER_GAME || process.env.RA2_BROWSER_GAME === game,
  ))
    for (const mode of ['worker', 'main', 'default', 'lan-worker', 'lan-main'].filter(
      (mode) => !process.env.RA2_BROWSER_STARTUP_MODE || process.env.RA2_BROWSER_STARTUP_MODE === mode,
    )) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(() => localStorage.setItem('vm-resolution-ra2', '800x600'));
      // 不拦截/替换任何 EXE 响应：开发目录的不同版本必须被真实覆盖传递机制处理。
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const lan = mode.startsWith('lan-');
      await page.goto(
        `${origin}/?debug=1${lan ? '&network=1&start-page=lan' + (relay ? '&relay=' + encodeURIComponent(relay) : '') : ''}${mode === 'lan-main' ? '&vm-worker=0' : ''}${mode === 'main' ? '&start-page=skirmish&vm-worker=0' : ''}`,
      );
      // Worker 从运行侧边栏重启进入；主线程继续覆盖 URL 兼容路径。
      if (mode === 'worker') {
        await page.getByRole('button', { name: '开发测试', exact: true }).click();
        await page
          .locator('.detected-games button')
          .nth(game === 'ra2' ? 0 : 1)
          .click();
        await page.waitForFunction(
          () => document.querySelector('#screen')?.getAttribute('data-shell-page')?.includes('MainMenu'),
          null,
          { timeout: 90000 },
        );
        await page.locator('#vm-quick-start').click();
        const dialog = page.getByRole('dialog', { name: '快速开局', exact: true });
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.has('start-page'), false);
        await page.locator('#vm-quick-start').click();
        await Promise.all([
          page.waitForEvent('load'),
          dialog.getByRole('button', { name: '重启并进入遭遇战', exact: true }).click(),
        ]);
        // 开发目录不属于持久化本地包，重载后仍需按原流程选择资源，不能偷偷注入文件。
      }
      await page.evaluate(() => {
        const canvas = document.querySelector('#screen')!;
        (window as any).__pages = [];
        new MutationObserver(() => {
          const title = (canvas as HTMLElement).dataset.shellPage;
          if (title) (window as any).__pages.push(title);
        }).observe(canvas, { attributes: true, attributeFilter: ['data-shell-page'] });
      });
      await page.getByRole('button', { name: '开发测试', exact: true }).click();
      await page
        .locator('.detected-games button')
        .nth(game === 'ra2' ? 0 : 1)
        .click();
      const target = mode === 'default' ? 'MainMenu' : lan ? 'GUI:Lobby' : 'Skirmish';
      await page.waitForFunction(
        (t) => (document.querySelector('#screen') as HTMLElement)?.dataset.shellPage?.includes(t),
        target,
        { timeout: 90000 },
      );
      const titles = await page.evaluate(() => (window as any).__pages as string[]);
      assert.ok(titles.length > 0);
      assert.ok(titles[0]!.includes(target), JSON.stringify(titles));
      if (!lan) assert.equal(await page.locator('#vm-custom-maps').isEnabled(), true);
      if (lan) {
        await page.waitForFunction(
          () => document.querySelector('#vm-network-status')?.getAttribute('data-phase') === 'connected',
          null,
          { timeout: 30000 },
        );
      }
      if (mode !== 'default') assert.ok(titles.every((t) => !t.includes('MainMenu') && !t.includes('SinglePlayer')));
      // 等下一批游戏帧，避免只截到创建控件但尚未合成的中间画面。
      const frame = await page.locator('#screen').getAttribute('data-vm-frame');
      await page.waitForFunction(
        (f) => Number((document.querySelector('#screen') as HTMLElement).dataset.vmFrame) > Number(f) + 120,
        frame,
        { timeout: 30000 },
      );
      await page.screenshot({ path: `/tmp/${game}-start-page-${mode}.png` });
      assert.deepEqual(errors, []);
      console.log(game, mode, { firstPage: titles[0], screenshot: `/tmp/${game}-start-page-${mode}.png` });
      await context.close();
    }
} finally {
  await browser.close();
}
