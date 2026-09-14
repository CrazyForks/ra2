import { zipSync } from 'fflate';
import { detectedGameButton } from '../../helpers/selectDevelopmentGame';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** 无游戏素材的 React 准入：单树状态驱动、文件取消、弹窗焦点与稳定 canvas。 */
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? '/tmp';
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
    try {
      const page = await context.newPage();
      let runtimeModuleUrl = '';
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/src/ui/pages/game/page.ts') runtimeModuleUrl = response.url();
      });
      // tsx 为具名内联函数插入此辅助函数；浏览器 evaluate 的独立上下文也需提供。
      await page.addInitScript('globalThis.__name = (value) => value');
      const errors: string[] = [];
      const failedResponses: string[] = [];
      const modelRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        // Vite 的 ?url 是只返回资源路径的微型 JS 模块，不是下载 25 MB WASM 正文。
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
      const canvas = await page.locator('#screen').elementHandle();
      const entry = page.getByRole('button', { name: '↓ 没有游戏文件？点击下载', exact: true });
      await expect(entry).toBeVisible();
      await expect(page.getByRole('button', { name: '附加地图包…' })).toBeHidden();
      const background = await page.locator(viewport.width <= 560 ? '#ui' : '#stage').evaluate((node, mobile) => {
        const style = getComputedStyle(node, mobile ? '::before' : null);
        return { image: style.backgroundImage, size: style.backgroundSize };
      }, viewport.width <= 560);
      expect(background.image).toContain('ra2vm-launcher-background.jpg');
      expect(background.size).toContain('contain');
      await expect(page.getByRole('button', { name: '开发测试', exact: true })).toHaveCount(1);
      await expect(page.locator('.development-sources details, .development-sources summary')).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: '快速开局：直达遭遇战设置' })).toHaveCount(0);
      await expect(page.locator('#vm-controls')).toBeHidden();
      await expect(page.locator('#screen-frame')).toBeHidden();
      const home = page.locator('.game-source-picker');
      await expect(home.getByRole('button', { name: '选择文件…', exact: true })).toHaveCount(1);
      await expect(home.locator('.detected-games')).toHaveCount(0);
      expect(await entry.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(139, 0, 0)');
      await expect(home.getByLabel('联机 relay 地址（可选）')).toHaveCount(0);
      await home.getByRole('checkbox', { name: '联机', exact: true }).check();
      const relay = home.getByLabel('联机 relay 地址（可选）');
      await relay.fill('/missing-host');
      await expect(relay).toHaveAttribute('aria-invalid', 'true');
      await expect(home.getByRole('button', { name: '选择文件…', exact: true }).first()).toBeDisabled();
      await relay.fill('ws://127.0.0.1:15178/ra2');
      await expect(relay).toHaveAttribute('aria-invalid', 'false');
      expect(new URL(page.url()).searchParams.get('relay')).toBe('ws://127.0.0.1:15178/ra2');
      await relay.fill('127.0.0.1:15178');
      await expect(relay).toHaveAttribute('aria-invalid', 'false');
      expect(new URL(page.url()).searchParams.get('relay')).toBe('127.0.0.1:15178');
      await relay.fill('');
      expect(new URL(page.url()).searchParams.has('relay')).toBe(false);
      await expect(home.getByRole('button', { name: '选择文件…', exact: true }).first()).toBeEnabled();
      await home.getByRole('checkbox', { name: '联机', exact: true }).uncheck();
      await expect(relay).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get('network')).toBe('0');
      const homeBox = await home.boundingBox();
      expect(homeBox!.x).toBeGreaterThanOrEqual(0);
      expect(homeBox!.y).toBeGreaterThanOrEqual(0);
      expect(homeBox!.x + homeBox!.width).toBeLessThanOrEqual(viewport.width);
      await home.getByRole('button', { name: '点此扫码入群', exact: true }).scrollIntoViewIfNeeded();
      await expect(home.getByRole('button', { name: '点此扫码入群', exact: true })).toBeInViewport();
      await entry.scrollIntoViewIfNeeded();

      const dialog = page.getByRole('dialog', { name: '下载游戏资源', exact: true });
      for (let pass = 0; pass < 2; pass++) {
        await entry.click();
        await expect(dialog).toBeVisible();
        const languageSelect = dialog.getByRole('combobox', { name: '游戏文字语言', exact: true });
        await expect(languageSelect).toHaveValue('all');
        await expect(dialog.locator('a')).toHaveCount(6);
        await expect(dialog.locator('.game-download-language')).toHaveCount(6);
        await expect(dialog.locator('.game-download-language').filter({ hasText: '简体中文' })).toHaveCount(2);
        await expect(dialog.locator('.game-download-language').filter({ hasText: '繁体中文' })).toHaveCount(3);
        await expect(dialog.locator('.game-download-language').filter({ hasText: 'English' })).toHaveCount(1);
        await expect(dialog.locator('.game-download-language').filter({ hasText: '语言待核验' })).toHaveCount(0);
        expect(
          await dialog
            .locator('a.game-download-link')
            .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
        ).toEqual([
          'https://www.uc129.com/xiazai/ra2/1.006.html',
          'https://www.uc129.com/xiazai/ra2/gongheguozhihui.html',
          'https://www.jb51.net/game/1018580.html',
          'https://archive.org/download/red-alert-2-multiplayer/Red-Alert-2-Multiplayer.exe',
          'https://www.uc129.com/xiazai/ra2/6615.html',
          'https://www.jb51.net/game/26829.html',
        ]);
        await languageSelect.selectOption('zh-Hans');
        await expect(dialog.locator('a')).toHaveCount(2);
        const simplifiedLinks = dialog.locator('a.game-download-link').filter({ hasText: '简体中文' });
        await expect(simplifiedLinks).toHaveCount(2);
        await expect(dialog.locator('a.game-download-link').filter({ hasText: '繁体中文' })).toHaveCount(0);
        expect(await simplifiedLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual([
          'https://www.jb51.net/game/1018580.html',
          'https://www.jb51.net/game/26829.html',
        ]);
        await languageSelect.selectOption('zh-Hant');
        await expect(dialog.locator('a')).toHaveCount(3);
        const traditionalLinks = dialog.locator('a.game-download-link').filter({ hasText: '繁体中文' });
        await expect(traditionalLinks).toHaveCount(3);
        await expect(dialog.locator('a.game-download-link').filter({ hasText: '简体中文' })).toHaveCount(0);
        await expect(dialog.locator('a.game-download-link').filter({ hasText: 'English' })).toHaveCount(0);
        expect(await traditionalLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual([
          'https://www.uc129.com/xiazai/ra2/1.006.html',
          'https://www.uc129.com/xiazai/ra2/gongheguozhihui.html',
          'https://www.uc129.com/xiazai/ra2/6615.html',
        ]);
        await languageSelect.selectOption('en');
        await expect(dialog.locator('a')).toHaveCount(1);
        const englishLinks = dialog.locator('a.game-download-link').filter({ hasText: 'English' });
        await expect(englishLinks).toHaveCount(1);
        await expect(dialog.locator('a.game-download-link').filter({ hasText: '简体中文' })).toHaveCount(0);
        await expect(dialog.locator('a.game-download-link').filter({ hasText: '繁体中文' })).toHaveCount(0);
        await expect(dialog.locator('.download-links-empty-global')).toHaveCount(0);
        expect(await englishLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual([
          'https://archive.org/download/red-alert-2-multiplayer/Red-Alert-2-Multiplayer.exe',
        ]);
        await languageSelect.selectOption('all');
        await expect(dialog.locator('a')).toHaveCount(6);
        for (const link of await dialog.locator('a').all()) {
          await expect(link).toHaveAttribute('target', '_blank');
          await expect(link).toHaveAttribute('rel', /noopener/);
        }
        const box = await dialog.boundingBox();
        expect(box!.width).toBeLessThanOrEqual(viewport.width);
        if (pass === 0)
          await page.screenshot({ path: `${screenshotDirectory}/ra2-react-download-${viewport.width}.png` });
        if (pass === 0) await page.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(entry).toBeFocused();
      }
      expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
      await page.evaluate(async () => {
        const stateUrl = '/src/ui/pages/game/state/uiState.ts';
        const { bootState } = (await import(stateUrl)) as typeof import('../../../src/ui/pages/game/state/uiState');
        bootState.set({
          game: { id: 'ra2', title: '测试' },
          status: { phase: 'loading', detail: '测试' },
          cancel: async () => {},
        });
      });
      await expect(page.locator('#vm-boot')).toBeVisible();
      await page.evaluate(async () => {
        const stateUrl = '/src/ui/pages/game/state/uiState.ts';
        const { bootState } = (await import(stateUrl)) as typeof import('../../../src/ui/pages/game/state/uiState');
        bootState.set(null);
      });
      await expect(page.locator('#vm-boot')).toHaveCount(0);
      // 页面控制器已装好工具栏；通过真实事件验证 React 更新不会重建选择器。
      {
        const choose = page.getByRole('button', { name: '选择文件…', exact: true });
        const chooserPromise = page.waitForEvent('filechooser');
        await choose.click();
        const chooser = await chooserPromise;
        await expect(choose).toBeDisabled();
        await page.locator('input[accept=".zip,.exe,.rar,.7z"]').dispatchEvent('cancel');
        await expect(choose).toBeEnabled();
        // 取消先到、change 迟到：不能吞掉选择，也不能让失败导入永久禁用界面。
        await chooser.setFiles({
          name: 'broken.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from('invalid archive'),
        });
        await expect(page.locator('.game-folder-panel [role="alert"]')).not.toHaveText('');
        await expect(choose).toBeEnabled();
        expect(await canvas!.evaluate((node) => node === document.querySelector('#screen'))).toBe(true);
        // 合成双版本清单验证真实 ZIP 识别及后置选择，不加载/伪造游戏 EXE。
        const both = zipSync(
          Object.fromEntries(
            ['ra2.mix', 'language.mix', 'ra2md.mix', 'langmd.mix', 'binkw32.dll', 'blowfish.dll'].map((name) => [
              name,
              new Uint8Array([1]),
            ]),
          ),
        );
        const secondChooser = page.waitForEvent('filechooser');
        await choose.click();
        await (
          await secondChooser
        ).setFiles({ name: 'both.zip', mimeType: 'application/zip', buffer: Buffer.from(both) });
        await expect(home.locator('.detected-games .dialog-button')).toHaveCount(2);
        await expect(home.locator('.detected-games')).toBeVisible();
        // 与真实游戏 CI 共用定位器；trial 校验可点击性，不启动合成资源。
        for (const game of ['ra2', 'yr']) await detectedGameButton(page, game).click({ trial: true });
        await page.screenshot({
          path: `${screenshotDirectory}/resource-picker-${viewport.width}x${viewport.height}.png`,
        });
        // 首页不展示运行工具栏；结束资源选择后再验证游戏态控制，不靠 CSS 强行显露。
        await page.evaluate(async () => {
          const stateUrl = '/src/ui/pages/game/state/uiState.ts';
          const { cancelSourceRequest } = (await import(
            stateUrl
          )) as typeof import('../../../src/ui/pages/game/state/uiState');
          cancelSourceRequest();
        });
        await expect(page.locator('#vm-controls')).toBeVisible();
        const upscaleBox = await page.locator('#vm-upscale-widget').boundingBox();
        const resolutionBox = await page.locator('#vm-resolution-widget').boundingBox();
        expect(Math.abs(upscaleBox!.x - resolutionBox!.x)).toBeLessThan(1);
        expect(Math.abs(upscaleBox!.width - resolutionBox!.width)).toBeLessThan(1);
        await expect(page.locator('#vm-controls > button').last()).toHaveAttribute('id', 'vm-fullscreen');
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
        // 直接拖动卷轴，不能只证明滚轮有效（按钮失焦曾可能提前关闭浮层）。
        const thumb = page.getByRole('scrollbar', { name: '选项滚动条' });
        const thumbBox = await thumb.boundingBox();
        await page.mouse.move(thumbBox!.x + thumbBox!.width / 2, thumbBox!.y + thumbBox!.height / 2);
        await page.mouse.down();
        await page.mouse.move(popupBox!.x + popupBox!.width - 8, popupBox!.y + popupBox!.height - 8, { steps: 8 });
        await page.mouse.up();
        await expect(options).toBeVisible();
        await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        const bottomScroll = await options.evaluate((node) => node.scrollTop);
        await page.getByRole('button', { name: '向上滚动', exact: true }).click();
        await expect.poll(() => options.evaluate((node) => node.scrollTop)).toBeLessThan(bottomScroll);
        const upperScroll = await options.evaluate((node) => node.scrollTop);
        await page.getByRole('button', { name: '向下滚动', exact: true }).click();
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
        const probe = page.getByRole('dialog', { name: 'WebGPU 模型实验', exact: true });
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
        await expect(probe.getByRole('button', { name: '采样并推理' })).toBeDisabled();
        expect(modelRequests).toEqual([]);
        await probe.getByLabel('选择本地模型').setInputFiles({
          name: 'invalid.onnx',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('invalid model'),
        });
        await expect(probe.getByRole('status')).toContainText('模型哈希不匹配');
        expect(modelRequests).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(probe).toHaveCount(0);
        await page.locator('#vm-join-group').click();
        const group = page.getByRole('dialog', { name: '微信交流群', exact: true });
        await expect(group).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(group).toHaveCount(0);
        await page.locator('#vm-fullscreen').scrollIntoViewIfNeeded();
        await expect(page.locator('#vm-fullscreen')).toBeInViewport();
      }
      // Vite 可能给实际入口加 HMR 时间戳，必须销毁同一个服务实例，不能另 import 一个副本。
      expect(runtimeModuleUrl).not.toBe('');
      await page.evaluate(async (pageUrl) => {
        const { stopVmPage } = (await import(pageUrl)) as typeof import('../../../src/ui/pages/game/page');
        stopVmPage();
      }, runtimeModuleUrl);
      await expect(page.locator('#vm-controls button')).toHaveCount(0);
      await expect(page.locator('.game-folder-panel')).toHaveCount(0);
      expect(errors).toEqual([]);
      console.log(`${viewport.width}×${viewport.height}：React 弹窗、焦点、画布与卸载通过`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
