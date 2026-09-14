import { describe, expect, it } from 'vitest';
import { gameDownloadCatalog } from '../../src/games/downloadCatalog';
import type { DownloadLink } from '../../src/games/downloadCatalog';

const allLinks: DownloadLink[] = gameDownloadCatalog.flatMap((game) => game.links);

describe('下载来源语言目录', () => {
  it('保留六个不重复的下载入口', () => {
    expect(allLinks).toHaveLength(6);
    expect(new Set(allLinks.map((link) => link.href)).size).toBe(allLinks.length);
  });

  it('保留简繁英语言映射', () => {
    const languageByHref = new Map(allLinks.map((link) => [link.href, link.language]));
    expect(languageByHref.get('https://www.uc129.com/xiazai/ra2/gongheguozhihui.html')).toBe('zh-Hant');
    expect(languageByHref.get('https://archive.org/download/red-alert-2-multiplayer/Red-Alert-2-Multiplayer.exe')).toBe(
      'en',
    );
    expect(allLinks.filter((link) => link.language === 'zh-Hans')).toHaveLength(2);
    expect(allLinks.filter((link) => link.language === 'zh-Hant')).toHaveLength(3);
    expect(allLinks.filter((link) => link.language === 'en')).toHaveLength(1);
  });
});
