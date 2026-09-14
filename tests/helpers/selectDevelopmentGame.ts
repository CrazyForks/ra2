import { expect, type Page } from '@playwright/test';
import { gameDownloadCatalog } from '../../src/games/downloadCatalog';

/** 用可访问名称定位游戏，避免绑定图标、皮肤或按钮顺序。 */
export function detectedGameButton(page: Page, game: string) {
  const entry = gameDownloadCatalog.find((entry) => entry.id === game);
  if (!entry) throw new Error('仅支持 ra2 或 yr');
  return page.locator('.detected-games').getByRole('button', { name: entry.title, exact: true });
}

/** 单游戏资源自动启动；共存资源按游戏名称选择，不依赖按钮位置。 */
export async function selectDevelopmentGame(page: Page, game: string): Promise<void> {
  if (game !== 'ra2' && game !== 'yr') throw new Error('仅支持 ra2 或 yr');
  await page.getByRole('button', { name: '开发测试', exact: true }).click();
  await page.waitForFunction(
    () => {
      const picker = document.querySelector('.game-source-picker');
      const error = picker?.querySelector<HTMLElement>('[role="alert"]');
      return (
        !picker ||
        picker.getClientRects().length === 0 ||
        !!picker.querySelector('.detected-games button') ||
        (!!error && !error.hidden && !!error.textContent)
      );
    },
    null,
    { timeout: 120000 },
  );
  await expect(page.locator('.source-picker-error:visible')).toHaveCount(0);
  if (await page.locator('.detected-games button').count()) {
    await detectedGameButton(page, game).click();
  }
}
