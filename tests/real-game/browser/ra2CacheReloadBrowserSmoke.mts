/** After the first local ZIP import, reload must boot normally from persisted resources; testing only development mode is insufficient. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const archive = process.env.RA2_BROWSER_ZIP;
if (!archive) throw new Error('请通过 RA2_BROWSER_ZIP 指定合法的 RA2 ZIP 测试资源');
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const game = process.env.RA2_BROWSER_GAME === 'yr' ? 'yr' : 'ra2';
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ locale: 'zh-CN', ignoreHTTPSErrors: true });
  // Diagnostic comparison: remove only the layered plan and retain full extraction; never replace resource or EXE bytes.
  if (process.env.RA2_BROWSER_FULL_ARCHIVE === '1')
    await context.addInitScript(() => {
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        private archive: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.archive = String(url).includes('archiveExtractWorker');
        }
        postMessage(message: any, transfer: any = []) {
          super.postMessage(
            this.archive && message?.type === 'extract' ? { ...message, layers: undefined } : message,
            transfer,
          );
        }
      };
    });
  const page = await context.newPage();
  page.on('crash', () => {
    console.error('浏览器页面崩溃');
    void context.close();
  });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/?debug=1${process.env.RA2_BROWSER_MAIN_THREAD === '1' ? '&vm-worker=0' : ''}`);
  console.log('storage-before', await page.evaluate(() => navigator.storage.estimate()));
  if (process.env.RA2_BROWSER_STORAGE_QUOTA_BYTES) {
    const quotaSize = Number(process.env.RA2_BROWSER_STORAGE_QUOTA_BYTES);
    assert.ok(Number.isSafeInteger(quotaSize) && quotaSize > 0, '测试存储配额必须为正整数');
    const session = await context.newCDPSession(page);
    await session.send('Storage.overrideQuotaForOrigin', { origin: new URL(origin).origin, quotaSize });
    console.log('storage-override', quotaSize);
    // The quota override is tied to the CDP session; keep it until context.close, as early detach removes the override.
    assert.equal((await page.evaluate(() => navigator.storage.estimate())).quota, quotaSize, '配额覆盖必须实际生效');
  }

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件…', exact: true }).click();
  await (await chooser).setFiles(archive);
  await page.waitForFunction(
    () =>
      document.querySelector('.detected-games') ||
      /loading|running|error/.test(document.querySelector<HTMLElement>('#screen')?.dataset.vmStatus ?? ''),
    null,
    { timeout: 120000 },
  );
  if (await page.locator('.detected-games').isVisible()) {
    await page
      .locator('.detected-games button')
      .nth(game === 'yr' ? 1 : 0)
      .click();
  }
  for (let launch = 0; launch < 2; launch++) {
    if (launch) await page.reload();
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector<HTMLCanvasElement>('#screen');
        const status = canvas?.dataset.vmStatus ?? '';
        return canvas?.dataset.shellPage?.includes('MainMenu') || /exited|error|blocked/.test(status);
      },
      undefined,
      { timeout: 120000 },
    );
    const state = await page.locator('#screen').evaluate((el) => ({ ...(el as HTMLElement).dataset }));
    console.log('launch', launch, { status: state.vmStatus, page: state.shellPage });
    assert.equal(
      await page.evaluate(() => localStorage.getItem('ra2-vm-preferred-game')),
      game,
      '测试必须实际启动所选游戏',
    );
    console.log('storage', await page.evaluate(() => navigator.storage.estimate()));
    await page.screenshot({ path: `/tmp/${game}-cache-launch-${launch}.png` });
    assert.ok(state.shellPage?.includes('MainMenu'), `第 ${launch + 1} 次启动失败：${JSON.stringify(state)}`);
    if (!launch) {
      const indicator = page.locator('#vm-resource-status');
      if (await indicator.count()) {
        await page.waitForFunction(() => document.getElementById('vm-resource-status')?.dataset.phase !== 'loading');
        assert.equal(await indicator.getAttribute('data-phase'), 'complete');
      }
    }
    // The main menu may appear before layered extraction finishes and creates the save transaction. Wait for actual cache
    // commit rather than assuming a read-only transaction runs after saving. Read only keys to avoid a full-read memory spike.
    const readCachedKeys = () =>
      page.evaluate(
        (game) =>
          new Promise<string[]>((resolve, reject) => {
            const open = indexedDB.open('ra2-vm-game-files', 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction('files');
              const request = tx.objectStore('files').getAllKeys(IDBKeyRange.bound(`${game}/`, `${game}/￿`));
              request.onsuccess = () => resolve(request.result.map(String));
              request.onerror = () => reject(request.error);
              tx.oncomplete = () => db.close();
            };
          }),
        game,
      );
    let cached: string[] = [];
    await expect
      .poll(async () => (cached = await readCachedKeys()).length, {
        timeout: 120000,
        intervals: [100, 250, 500],
        message: '本次启动必须提交可恢复缓存',
      })
      .toBeGreaterThan(0);
    console.log('cache', cached);
  }
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
}
