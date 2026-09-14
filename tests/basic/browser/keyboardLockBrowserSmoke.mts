/** 无游戏资源的真实浏览器输入回归：不模拟 Keyboard Lock 或 Pointer Lock API。 */
import { chromium, expect } from '@playwright/test';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
// 无头模式可能不给后台页真实 visibilitychange；用有界面 Chromium 验证切标签。
// Linux 无显示器时：xvfb-run -a pnpm exec tsx tests/basic/browser/keyboardLockBrowserSmoke.mts
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route('**/keyboard-lock-smoke', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="full">全屏</button><div id="screen-frame"><canvas id="screen" width="800" height="600"></canvas></div>',
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/keyboard-lock-smoke`);
  await page.evaluate(async () => {
    const moduleUrl = '/src/ui/pages/game/gameInput.ts';
    const { installGameInput, toggleImmersiveFullscreen } = await import(moduleUrl);
    const canvas = document.querySelector('#screen');
    const messages: number[][] = [];
    (window as any).inputMessages = messages;
    (window as any).input = installGameInput(
      canvas,
      {
        setCursorPosition() {},
        setKeyState() {},
        postMessage(...args: number[]) {
          messages.push(args);
        },
      },
      true,
    );
    document.querySelector('#full')!.addEventListener('click', () => void toggleImmersiveFullscreen(canvas));
  });
  await page.locator('#full').click();
  await expect.poll(() => page.locator('.pointer-lock-hint').textContent()).toContain('Esc 已交给游戏');
  await page.locator('#screen').click();
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen');
  await page.evaluate(() => {
    (window as any).inputMessages.length = 0;
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  expect(
    await page.evaluate(() =>
      (window as any).inputMessages
        .filter((m: number[]) => m[0] === 0x100 || m[0] === 0x101)
        .map((m: number[]) => m.slice(0, 2)),
    ),
  ).toEqual([
    [0x100, 27],
    [0x101, 27],
  ]);
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('screen-frame');
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe('screen');
  await page.evaluate(() => {
    (window as any).inputMessages.length = 0;
  });
  // 通过真实浏览器激活另一标签页，不用脚本伪造 blur/visibilitychange。
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  // Xvfb 无窗口管理器时 hidden/hasFocus 不一定随切页变化，但必须实际解除
  // 指针锁，才能验证原来的「解锁补发 Esc」回归；失焦事件排列另有单元测试。
  await page.waitForFunction(() => !document.pointerLockElement, null, { timeout: 5000 });
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => (window as any).inputMessages.some((m: number[]) => m[0] === 0x100 && m[1] === 27)),
  ).toBe(false);
  await page.bringToFront();
  await page.evaluate(() => {
    (window as any).input.cleanup();
  });
  console.log('真实 Chromium：Esc DOWN/UP 转发一次、短按保留全屏及鼠标锁、切页解除鼠标锁不注入 Esc，通过');
} finally {
  await browser.close();
}
