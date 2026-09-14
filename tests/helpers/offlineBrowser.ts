import type { Page } from '@playwright/test';

/** 公共 UI/绘图验收不需要 EXE。首页预加载也必须离线，避免隐式依赖 CDN 或私有缓存。
 * 真实游戏回归不调用此函数；这里不伪造成功的游戏文件或修改 manifest 哈希。
 */
export async function preventThirdPartyDownloads(page: Page): Promise<void> {
  await page.route('**/__third-party/**', (route) => route.abort('blockedbyclient'));
  await page.route('https://oldgame.store/**', (route) => route.abort('blockedbyclient'));
}
