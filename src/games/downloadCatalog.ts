export type DownloadLanguage = 'zh-Hans' | 'zh-Hant' | 'en';
export type DownloadLanguageFilter = 'all' | DownloadLanguage;

export interface DownloadLink {
  href: string;
  label: string;
  language: DownloadLanguage;
}

export interface GameDownloadGroup {
  id: 'ra2' | 'yr';
  title: string;
  links: readonly DownloadLink[];
}

export const downloadLanguageLabels = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁体中文',
  en: 'English',
} as const satisfies Record<DownloadLanguage, string>;

export const downloadLanguageOptions = [
  { value: 'all', label: '全部' },
  { value: 'zh-Hans', label: downloadLanguageLabels['zh-Hans'] },
  { value: 'zh-Hant', label: downloadLanguageLabels['zh-Hant'] },
  { value: 'en', label: downloadLanguageLabels.en },
] as const satisfies readonly { value: DownloadLanguageFilter; label: string }[];

export function isDownloadLanguageFilter(value: string): value is DownloadLanguageFilter {
  return value === 'all' || value === 'zh-Hans' || value === 'zh-Hant' || value === 'en';
}

// 仅保留展示和语言筛选需要的数据；链接内容变化时重新核对语言。
export const gameDownloadCatalog: readonly GameDownloadGroup[] = [
  {
    id: 'ra2',
    title: '红警2（1.006）',
    links: [
      {
        href: 'https://www.uc129.com/xiazai/ra2/1.006.html',
        label: '红警之家 红色警戒2标准版(1.006可联机)',
        language: 'zh-Hant',
      },
      {
        href: 'https://www.uc129.com/xiazai/ra2/gongheguozhihui.html',
        label: '红警之家 红色警戒2共和国之辉联机版（纯净版）',
        language: 'zh-Hant',
      },
      {
        href: 'https://www.jb51.net/game/1018580.html',
        label: '脚本之家 红色警戒2标准版 v1.006(原版RA2纯游戏包可联机)',
        language: 'zh-Hans',
      },
      {
        href: 'https://archive.org/download/red-alert-2-multiplayer/Red-Alert-2-Multiplayer.exe',
        label: 'Archive.org（XWIS 联机版安装包）',
        language: 'en',
      },
    ],
  },
  {
    id: 'yr',
    title: '尤里的复仇（1.001）',
    links: [
      {
        href: 'https://www.uc129.com/xiazai/ra2/6615.html',
        label: '红警之家 红色警戒2尤里的复仇Yuri_s_v1.001',
        language: 'zh-Hant',
      },
      {
        href: 'https://www.jb51.net/game/26829.html',
        label: '脚本之家 红色警戒2 尤里的复仇 安装包 v1.001最新版',
        language: 'zh-Hans',
      },
    ],
  },
];
