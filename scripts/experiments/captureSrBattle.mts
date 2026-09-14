/** SR 画质评测素材：真实 RA2 盟军战役，无模型/插值，记录原始画布像素。 */
import { selectDevelopmentGame } from '../../tests/helpers/selectDevelopmentGame';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const output = process.env.RA2_SR_OUTPUT ?? '.tmp-sr-battle';
mkdirSync(output); // 证据目录已存在时拒绝覆盖。
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=4096'],
});
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 } });
  await page.addInitScript(() => localStorage.setItem('vm-resolution-ra2', '800x600'));
  await page.goto(
    `${process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15175'}/?debug=1&clicks=714,221;714,221;454,188`,
  );
  await selectDevelopmentGame(page, 'ra2');
  await page.waitForFunction(
    () => document.querySelector('#screen')?.getAttribute('data-shell-page')?.includes('MainMenu'),
    null,
    { timeout: 90000 },
  );
  await page.waitForTimeout(10000);
  await page.locator('#vm-controls-toggle').click();
  const canvas = page.locator('#screen');
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(10000);
    console.log(
      'battle wait',
      await canvas.getAttribute('data-shell-page'),
      await canvas.getAttribute('data-vm-battlefield'),
    );
    if (
      !(await canvas.getAttribute('data-shell-page')) &&
      Number((await canvas.getAttribute('data-vm-battlefield'))?.split(',')[1] ?? 0) > 0.3
    )
      break;
    await page.keyboard.press('Space');
  }
  if (await canvas.getAttribute('data-shell-page')) throw new Error('仍在菜单，拒绝作为战场样本');
  for (let i = 0; i < 3; i++) {
    if (i) {
      await page.keyboard.press('h');
      await page.waitForTimeout(15000);
    }
    // 一次性在 drawArrays 提交后同步读取，避免 preserveDrawingBuffer=false 返回空图。
    const data = await page.evaluate(async () => {
      const c = document.querySelector<HTMLCanvasElement>('#screen')!;
      c.width = 800;
      c.height = 600;
      const gl = c.getContext('webgl2')!;
      return await new Promise<string>((resolve, reject) => {
        const draw = gl.drawArrays;
        const timer = setTimeout(() => {
          gl.drawArrays = draw;
          reject(new Error('画面未更新'));
        }, 10000);
        gl.drawArrays = function (...args) {
          draw.apply(gl, args);
          if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) return;
          gl.drawArrays = draw;
          clearTimeout(timer);
          resolve(c.toDataURL('image/png'));
        };
      });
    });
    writeFileSync(`${output}/battle-${i}.png`, Buffer.from(data.split(',')[1]!, 'base64'));
    console.log(
      'capture',
      i,
      await canvas.getAttribute('data-vm-resolution'),
      await canvas.getAttribute('data-vm-battlefield'),
    );
  }
  await page.screenshot({ path: `${output}/browser.png` });
} finally {
  await browser.close();
}
