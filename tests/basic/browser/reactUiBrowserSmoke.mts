import { localizeText, resolveLocale } from '../../../src/ui/shared/i18n/translate';
import { zipSync } from 'fflate';
import { detectedGameButton } from '../../helpers/selectDevelopmentGame';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** React admission tests without game assets: one state-driven tree, file cancellation, dialog focus, and a stable canvas. */
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? '/tmp';
try {
  for (const locale of ['zh-CN', 'en-US']) {
    const text = (value: string) => localizeText(value, resolveLocale([locale]));
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const context = await browser.newContext({ locale, ignoreHTTPSErrors: true, viewport });
      try {
        const page = await context.newPage();
        let runtimeModuleUrl = '';
        page.on('response', (response) => {
          if (new URL(response.url()).pathname === '/src/ui/pages/game/page.ts') runtimeModuleUrl = response.url();
        });
        // tsx inserts this helper for named inline functions; the isolated browser evaluate context needs it too.
        await page.addInitScript('globalThis.__name = (value) => value');
        const errors: string[] = [];
        const failedResponses: string[] = [];
        const modelRequests: string[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          // Vite's ?url returns a tiny JS module containing only the asset path, not the 25 MB WASM payload.
          if (!url.searchParams.has('url') && /ort[.-].*(?:wasm|bundle)|\.onnx(?:\?|$)/.test(url.href))
            modelRequests.push(url.href);
        });
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (response) => {
          if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
        });
        page.on('console', (message) => {
          if (/React.*error|unmounted|flushSync was called|same container.*createRoot/i.test(message.text()))
            errors.push(message.text());
        });
        await preventThirdPartyDownloads(page);
        await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
        await expect(page.locator('html')).toHaveAttribute('lang', resolveLocale([locale]));
        const canvas = await page.locator('#screen').elementHandle();
        if (viewport.width <= 560) {
          await page.setViewportSize({ width: 320, height: 568 });
          await expect(page.locator('.status-terminal-readout')).toBeInViewport();
          const commands = page.locator('.ra2-menu-nav > .ra2-menu-btn');
          const first = (await commands.nth(0).boundingBox())!;
          const second = (await commands.nth(1).boundingBox())!;
          expect(Math.abs(first.y - second.y)).toBeLessThan(1);
          expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
          expect(first.height).toBeGreaterThanOrEqual(44);
          expect(await page.locator('.ra2-screen').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          await page.setViewportSize(viewport);
        }
        await expect(page.getByRole('button', { name: text('下载游戏'), exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: text('附加地图包…') })).toBeHidden();
        const mobileHome = viewport.width <= 560;
        const orientationHint = page.locator('.portrait-orientation-hint');
        if (mobileHome) {
          await expect(orientationHint).toBeVisible();
          await expect(orientationHint).toHaveText(text('横屏获取更好的游戏体验'));
          const appearance = await orientationHint.evaluate((node) => {
            const hint = getComputedStyle(node);
            const guide = getComputedStyle(document.querySelector('.game-guide li')!);
            return { color: hint.color, font: hint.font, guideFont: guide.font };
          });
          expect(appearance.color).toBe('rgb(255, 255, 0)');
          expect(appearance.font).toBe(appearance.guideFont);
          const navBox = (await page.locator('.ra2-menu-nav').boundingBox())!;
          expect((await orientationHint.boundingBox())!.y).toBeGreaterThanOrEqual(navBox.y + navBox.height);
        } else await expect(orientationHint).toBeHidden();
        const measureBackdrop = () =>
          page.locator(mobileHome ? '.ra2-screen' : '.ra2-panel').evaluate((node, mobile) => {
            const style = getComputedStyle(node, mobile ? '::before' : null);
            return {
              image: style.backgroundImage,
              size: style.backgroundSize,
              position: style.position,
              coordinates: style.backgroundPosition,
              width: mobile ? style.width : node.getBoundingClientRect().width,
              height: mobile ? style.height : node.getBoundingClientRect().height,
            };
          }, mobileHome);
        const backdrop = await measureBackdrop();
        expect(backdrop.image).toContain(mobileHome ? 'none' : 'menu.jpg');
        if (mobileHome) {
          expect(backdrop.position).toBe('fixed');
          const panelBox = (await page.locator('.ra2-panel-wrap').boundingBox())!;
          const footerBox = (await page.locator('.ra2-footer').boundingBox())!;
          expect(Math.abs((panelBox.y + footerBox.y + footerBox.height) / 2 - viewport.height / 2)).toBeLessThan(2);
          expect(
            await page
              .locator('.ra2-menu-btn')
              .first()
              .evaluate((node) => getComputedStyle(node).backgroundImage),
          ).toContain('/theme/ra2/button.png');
          expect(backdrop.width).toBe(`${viewport.width}px`);
          expect(backdrop.height).toBe(`${viewport.height}px`);
          expect(
            await page.locator('.ra2-menu-header').evaluate((node) => getComputedStyle(node).backgroundImage),
          ).toBe('none');
          const toggle = page.locator('.network-toggle input');
          await toggle.scrollIntoViewIfNeeded();
          for (let pass = 0; pass < 3; pass++) {
            await toggle.check();
            await expect(page.locator('.network-settings')).toBeInViewport({ ratio: 1 });
            expect(await measureBackdrop()).toEqual(backdrop);
            await toggle.uncheck();
            expect(await measureBackdrop()).toEqual(backdrop);
          }
        } else expect(backdrop.size).toContain('cover');
        await expect(page.getByRole('button', { name: text('开发测试'), exact: true })).toHaveCount(1);
        await expect(page.locator('.development-sources details, .development-sources summary')).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: text('快速开局：直达遭遇战设置') })).toHaveCount(0);
        await expect(page.locator('#vm-controls')).toBeHidden();
        await expect(page.locator('#screen-frame')).toBeHidden();
        const home = page.locator('.game-source-picker');
        await expect(home.getByRole('button', { name: text('选择文件…'), exact: true })).toHaveCount(1);
        await expect(home.locator('.detected-games')).toHaveCount(0);
        await expect(home.getByLabel(text('联机 relay 地址（可选）'))).toHaveCount(0);
        await home.getByRole('checkbox', { name: text('联机'), exact: true }).check();
        const relay = home.getByLabel(text('联机 relay 地址（可选）'));
        await expect(relay).toBeInViewport({ ratio: 1 });
        await relay.fill('/missing-host');
        await expect(relay).toHaveAttribute('aria-invalid', 'true');
        await expect(home.getByRole('button', { name: text('选择文件…'), exact: true }).first()).toBeDisabled();
        await relay.fill('ws://127.0.0.1:15178/ra2');
        await expect(relay).toHaveAttribute('aria-invalid', 'false');
        expect(new URL(page.url()).searchParams.get('relay')).toBe('ws://127.0.0.1:15178/ra2');
        await relay.fill('127.0.0.1:15178');
        await expect(relay).toHaveAttribute('aria-invalid', 'false');
        expect(new URL(page.url()).searchParams.get('relay')).toBe('127.0.0.1:15178');
        await relay.fill('');
        expect(new URL(page.url()).searchParams.has('relay')).toBe(false);
        await expect(home.getByRole('button', { name: text('选择文件…'), exact: true }).first()).toBeEnabled();
        await home.getByRole('checkbox', { name: text('联机'), exact: true }).uncheck();
        await expect(relay).toHaveCount(0);
        expect(new URL(page.url()).searchParams.get('network')).toBe('0');
        const homeBox = await home.boundingBox();
        expect(homeBox!.x).toBeGreaterThanOrEqual(0);
        expect(homeBox!.y).toBeGreaterThanOrEqual(0);
        expect(homeBox!.x + homeBox!.width).toBeLessThanOrEqual(viewport.width);
        await home.getByRole('button', { name: text('点此扫码入群'), exact: true }).scrollIntoViewIfNeeded();
        await expect(home.getByRole('button', { name: text('点此扫码入群'), exact: true })).toBeInViewport();

        await expect(page.locator('.game-download-dialog')).toHaveCount(0);
        expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const { bootState } = (await import(stateUrl)) as typeof import('../../../src/ui/pages/game/state/uiState');
          bootState.set({
            game: { id: 'ra2', title: '红色警戒 2' },
            status: { phase: 'loading', detail: 'PE 已解析：入口 0x785aa0，368 个 Win32 导入' },
            cancel: async () => {},
          });
        });
        await expect(page.locator('#vm-boot')).toBeVisible();
        await expect(page.locator('#vm-boot [role=progressbar]')).toBeVisible();
        await expect(page.locator('#vm-boot [role=progressbar]')).not.toHaveAttribute('aria-valuenow');
        await expect(page.locator('.vm-boot-title')).toHaveText(text('红色警戒 2'));
        await expect(page.locator('.vm-boot-detail')).toHaveText(text('PE 已解析：入口 0x785aa0，368 个 Win32 导入'));
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const { bootState } = (await import(stateUrl)) as typeof import('../../../src/ui/pages/game/state/uiState');
          bootState.set(null);
        });
        await expect(page.locator('#vm-boot')).toHaveCount(0);
        // The page controller has installed the toolbar; real events verify that React updates do not recreate the picker.
        {
          const choose = page.getByRole('button', { name: text('选择文件…'), exact: true });
          const chooserPromise = page.waitForEvent('filechooser');
          await choose.click();
          const chooser = await chooserPromise;
          await expect(choose).toBeDisabled();
          await page.locator('input[accept=".zip,.exe,.rar,.7z"]').dispatchEvent('cancel');
          await expect(choose).toBeEnabled();
          // Cancel arrives first, change later: do not lose the selection or let a failed import permanently disable the UI.
          await chooser.setFiles({
            name: 'broken.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from('invalid archive'),
          });
          await expect(page.locator('.game-folder-panel [role="alert"]')).not.toHaveText('');
          if (locale === 'en-US')
            await expect(page.locator('.game-folder-panel [role="alert"]')).not.toHaveText(/\p{Script=Han}/u);
          await expect(choose).toBeEnabled();
          expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
          // A synthetic two-version manifest verifies real ZIP recognition and deferred version selection without loading or faking a game EXE.
          const both = zipSync(
            Object.fromEntries(
              [
                'game.exe',
                'gamemd.exe',
                'ra2.mix',
                'language.mix',
                'ra2md.mix',
                'langmd.mix',
                'binkw32.dll',
                'blowfish.dll',
              ].map((name) => [name, new Uint8Array([1])]),
            ),
          );
          const secondChooser = page.waitForEvent('filechooser');
          await choose.click();
          await (
            await secondChooser
          ).setFiles({ name: 'both.zip', mimeType: 'application/zip', buffer: Buffer.from(both) });
          await expect(home.locator('.detected-games .dialog-button')).toHaveCount(2);
          await expect(home.locator('.detected-games')).toBeVisible();
          // Share locators with real-game CI; trial checks clickability without starting synthetic assets.
          for (const game of ['ra2', 'yr'])
            await detectedGameButton(page, game, resolveLocale([locale])).click({ trial: true });
          await page.screenshot({
            path: `${screenshotDirectory}/resource-picker-${locale}-${viewport.width}x${viewport.height}.png`,
          });
          // The home page hides the runtime toolbar; finish resource selection before checking in-game controls instead of forcing visibility through CSS.
          await page.evaluate(async () => {
            const stateUrl = '/src/ui/pages/game/state/uiState.ts';
            const { cancelSourceRequest } = (await import(
              stateUrl
            )) as typeof import('../../../src/ui/pages/game/state/uiState');
            cancelSourceRequest();
          });
          await expect(page.locator('#vm-controls')).toBeVisible();
          const overflowing = await page.locator('#vm-controls').evaluate((sidebar) => {
            const bounds = sidebar.getBoundingClientRect();
            return [
              ...sidebar.querySelectorAll<HTMLElement>(
                '.toolbar-button, .game-select-value, .label, .slider-fields, output',
              ),
            ]
              .filter((element) => element.getClientRects().length > 0)
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.left < bounds.left ||
                  rect.right > bounds.right ||
                  (element.matches('.toolbar-button, output') && element.scrollWidth > element.clientWidth + 1)
                );
              })
              .map((element) => element.id || element.textContent);
          });
          expect(overflowing, `${locale}: sidebar controls and translated text must fit`).toEqual([]);

          const upscaleBox = await page.locator('#vm-upscale-widget').boundingBox();
          const resolutionBox = await page.locator('#vm-resolution-widget').boundingBox();
          expect(Math.abs(upscaleBox!.x - resolutionBox!.x)).toBeLessThan(1);
          expect(Math.abs(upscaleBox!.width - resolutionBox!.width)).toBeLessThan(1);
          await expect(page.locator('#vm-controls > button').last()).toHaveAttribute('id', 'vm-fullscreen');
          const openSource = page.locator('#vm-open-source');
          await expect(openSource).toHaveAttribute('href', 'https://github.com/ra2-games/ra2');
          await expect(openSource).toHaveAttribute('rel', 'noopener noreferrer');
          const openSourceBox = (await openSource.boundingBox())!;
          const joinGroupBox = (await page.locator('#vm-join-group').boundingBox())!;
          expect(Math.abs(openSourceBox.x - joinGroupBox.x)).toBeLessThan(1);
          expect(openSourceBox.width).toBe(joinGroupBox.width);
          const options = page.locator('#vm-resolution-options');
          await expect(options).toBeHidden();
          await expect(page.locator('#vm-custom-maps')).toBeDisabled();
          await expect(page.locator('#vm-quick-start')).toBeDisabled();
          await page.locator('#vm-upscale-toggle').click();
          await page.keyboard.press('End');
          await page.keyboard.press('Enter');
          await expect(page.locator('#vm-upscale-mode')).toHaveValue('gan');
          await page.locator('#vm-upscale-toggle').click();
          await page.keyboard.press('Home');
          await page.keyboard.press('Enter');
          await expect(page.locator('#vm-upscale-mode')).toHaveValue('off');
          await page.locator('#vm-resolution-toggle').click();
          await expect(options).toBeVisible();
          await expect(options.getByRole('option')).toHaveCount(8);
          const popupBox = await options.boundingBox();
          expect(popupBox!.y).toBeGreaterThanOrEqual(0);
          expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(viewport.height);
          // Drag the scrollbar itself; proving wheel scrolling works is insufficient (button blur could previously close the popup early).
          const thumb = page.getByRole('scrollbar', { name: text('选项滚动条') });
          const thumbBox = await thumb.boundingBox();
          await page.mouse.move(thumbBox!.x + thumbBox!.width / 2, thumbBox!.y + thumbBox!.height / 2);
          await page.mouse.down();
          await page.mouse.move(popupBox!.x + popupBox!.width - 8, popupBox!.y + popupBox!.height - 8, { steps: 8 });
          await page.mouse.up();
          await expect(options).toBeVisible();
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          const bottomScroll = await options.evaluate((node) => node.scrollTop);
          await page.getByRole('button', { name: text('向上滚动'), exact: true }).click();
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeLessThan(bottomScroll);
          const upperScroll = await options.evaluate((node) => node.scrollTop);
          await page.getByRole('button', { name: text('向下滚动'), exact: true }).click();
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(upperScroll);
          await options.hover();
          await page.mouse.wheel(0, 500);
          await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          await expect(options.getByRole('option').last()).toBeInViewport();
          await page.keyboard.press('Escape');
          await expect(options).toBeHidden();
          await page.locator('#vm-volume').fill('70');
          await expect(page.locator('#vm-volume-value')).toHaveValue('70%');
          expect(await page.evaluate(() => localStorage.getItem('vm-master-volume'))).toBe('70');
          await page.locator('#vm-volume').focus();
          await page.keyboard.press('ArrowLeft');
          await expect(page.locator('#vm-volume-value')).toHaveValue('69%');
          const track = await page.locator('#vm-volume').boundingBox();
          await page.mouse.move(track!.x + 3, track!.y + track!.height / 2);
          await page.mouse.down();
          await page.mouse.move(track!.x + track!.width - 2, track!.y + track!.height / 2, { steps: 10 });
          await page.mouse.up();
          await expect(page.locator('#vm-volume')).toHaveValue('100');
          await page.locator('#vm-model-probe').click();
          const probe = page.getByRole('dialog', { name: text('WebGPU 模型实验'), exact: true });
          try {
            await expect(probe).toBeVisible();
          } catch (error) {
            const bodyText = await page
              .locator('body')
              .innerText()
              .catch(() => '');
            console.error('模型实验对话框未加载', JSON.stringify({ bodyText, errors, failedResponses }, null, 2));
            throw error;
          }
          await expect(probe.getByRole('button', { name: text('采样并推理') })).toBeDisabled();
          expect(modelRequests).toEqual([]);
          await probe.getByLabel(text('选择本地模型')).setInputFiles({
            name: 'invalid.onnx',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from('invalid model'),
          });
          await expect(probe.getByRole('status')).toContainText(text('模型哈希不匹配，请下载当前选择的指定版本 ONNX'));
          expect(modelRequests).toEqual([]);
          await page.keyboard.press('Escape');
          await expect(probe).toHaveCount(0);
          await page.locator('#vm-join-group').click();
          const group = page.getByRole('dialog', { name: text('微信交流群'), exact: true });
          await expect(group).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(group).toHaveCount(0);
          await page.locator('#vm-fullscreen').scrollIntoViewIfNeeded();
          await expect(page.locator('#vm-fullscreen')).toBeInViewport();
        }
        // Vite may add an HMR timestamp to the actual entry; dispose the same service instance instead of importing a separate copy.
        expect(runtimeModuleUrl).not.toBe('');
        await page.evaluate(async (pageUrl) => {
          const { stopVmPage } = (await import(pageUrl)) as typeof import('../../../src/ui/pages/game/page');
          stopVmPage();
        }, runtimeModuleUrl);
        await expect(page.locator('#vm-controls button')).toHaveCount(0);
        await expect(page.locator('.game-folder-panel')).toHaveCount(0);
        expect(errors).toEqual([]);
        console.log(`${locale} ${viewport.width}×${viewport.height}: React dialogs, focus, canvas, and cleanup passed`);
      } finally {
        await context.close();
      }
    }
  }
  // Cancel during the asynchronous handoff: the loading shell must already be visible,
  // and a late custom-map cache result must not create a VM.
  const handoff = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: true });
  try {
    const page = await handoff.newPage();
    await page.addInitScript('globalThis.__name = (value) => value');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/src/adapter/cachedGameFiles.ts*', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const patched = source.replace(
        'export async function loadCustomMapFiles(gameId) {',
        'export async function loadCustomMapFiles(gameId) { return await new Promise(resolve => { globalThis.__releaseMapRead = () => resolve(new Map()); });',
      );
      expect(patched).not.toBe(source);
      await route.fulfill({ response, body: patched });
    });
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await page.getByRole('heading', { name: 'Choose game resources', exact: true }).waitFor();
    await page.evaluate(async () => {
      const stateUrl = '/src/ui/pages/game/state/uiState.ts';
      const catalogUrl = '/src/games/catalog.ts';
      const filesUrl = '/src/platform/browser/files/sessionFiles.ts';
      const { sourceRequest } = await import(stateUrl);
      const { supportedGame } = await import(catalogUrl);
      const { SessionGameFileProvider } = await import(filesUrl);
      (globalThis as any).__finishSource = () =>
        sourceRequest.getSnapshot().finish({
          game: supportedGame('ra2'),
          files: new SessionGameFileProvider('handoff fixture', new Map()),
          executableBytes: new Uint8Array(),
        });
    });
    // Invoke the action after asynchronous module setup has returned, as a UI event would.
    await page.evaluate(() => (globalThis as any).__finishSource());
    await expect(page.locator('#vm-boot .ra2-loading-content')).toBeVisible();
    await expect(page.locator('#vm-controls')).toBeHidden();
    await page.getByRole('button', { name: 'Cancel startup', exact: true }).click();
    await expect(page.locator('#vm-boot')).toHaveCount(0);
    await page.evaluate(() => (globalThis as any).__releaseMapRead());
    await page.waitForTimeout(100);
    await expect(page.locator('#vm-boot')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Back to the web page', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await handoff.close();
  }

  // Unsupported browser languages fall back to English, including document metadata.
  const fallback = await browser.newContext({ locale: 'fr-FR', ignoreHTTPSErrors: true });
  try {
    const page = await fallback.newPage();
    await preventThirdPartyDownloads(page);
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await expect(page.getByRole('heading', { name: 'Choose game resources', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Red Alert 2 in your browser');
    expect(await page.locator('.game-source-picker').innerText()).not.toMatch(/\p{Script=Han}/u);
  } finally {
    await fallback.close();
  }
  // A cache entry can remain listed after its Blob becomes unreadable. Keep the failure visible across reloads.
  const unreadableCache = await browser.newContext({
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await unreadableCache.newPage();
    await preventThirdPartyDownloads(page);
    await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
    await page.getByRole('heading', { name: '选择游戏资源' }).waitFor();
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ra2-vm-game-files', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('files', 'readwrite');
        for (const name of ['game.exe', 'ra2.mix', 'language.mix', 'binkw32.dll', 'blowfish.dll'])
          transaction.objectStore('files').put(new Blob([new Uint8Array(name === 'ra2.mix' ? 7 : 1)]), `ra2/${name}`);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await page.addInitScript(() => {
      const slice = Blob.prototype.slice;
      Blob.prototype.slice = function (...args) {
        if (this.size === 7) throw new DOMException('The requested file could not be read', 'NotReadableError');
        return slice.apply(this, args);
      };
    });
    await page.reload();
    await expect(page.locator('.bad-page')).toBeVisible();
    await expect(page.locator('.bad-page')).toContainText('ra2/ra2.mix');
    await expect(page.locator('.bad-page')).toContainText('The requested file could not be read');
    await expect(page.locator('.game-source-picker')).toHaveCount(0);
    await page.getByRole('button', { name: '重新选择游戏资源' }).click();
    await expect(page.getByRole('heading', { name: '选择游戏资源' })).toBeVisible();
  } finally {
    await unreadableCache.close();
  }
} finally {
  await browser.close();
}
