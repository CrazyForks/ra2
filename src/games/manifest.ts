/**
 * 游戏文件清单：启动需要哪些顶层文件、分别从哪来、各有什么用途。
 *
 * 文件来源：主程序（game.exe / gamemd.exe，版本敏感、shim 固定地址依赖精确
 * 字节，二进制不在本仓库）走清单登记的第三方分享固定绝对 URL（浏览器 HTTP
 * 缓存 + 客户端 IndexedDB 持久化；服务端须回 CORS 头允许站点与本地开发源跨源
 * 读取），其余资源文件由玩家本地压缩包提供。
 * 清单面板据此显示提供/缺失文件；两层导入在目录齐全且启动层就绪后启动，
 * 其他资源的字节可以后台解压，但不得当成缺失文件。
 *
 * 清单出处：
 *  - RA2：以 game/ra2（联机客户端可启动集，boot 实证）为基准，与完整版
 *    安装归档（Red_Alert_2.rar 解出内容）做差集——只在完整版出现且本项目
 *    用不到的（RegSetup.exe / Ra2.exe 启动壳 / xwis.dll / wolapi.* /
 *    mph.exe / *.mmx / secdrv.sys 等）一律不列；联机客户端集内的
 *    nl.cfg / taunts / rmcache 经 rar 启动实证不需要，也不列。
 *  - YR：docs/RESOURCE_PACKAGE_EVIDENCE.md 中的基包裁剪依据。
 */
import type { SupportedGameId } from './catalog';

export interface ThirdPartyFile {
  /** 顶层文件名（提供到游戏目录时使用此名）。 */
  name: string;
  /** 获取地址（绝对 URL，须允许站点跨源读取）。 */
  url: string;
  /** 登记 SHA-256（下载后校验，防内容被替换）。 */
  sha256: string;
}

export interface ManifestFile {
  /** 顶层文件名（任意大小写）；目录条目（如 Taunts/）填目录名。 */
  name: string;
  /** 用途说明（清单面板展示）。 */
  note: string;
  /** 目录条目：小写目录前缀（如 'taunts/'），任一名下含该前缀即视为已提供。 */
  directory?: string;
}

export interface GameManifest {
  gameId: SupportedGameId;
  /** 第三方分享文件（主程序等）。 */
  thirdParty: readonly ThirdPartyFile[];
  /** 玩家必须提供的顶层文件（缺一不可启动）。 */
  playerRequired: readonly ManifestFile[];
  /** 玩家可选提供的顶层文件（缺了不阻塞启动，例如电影/战役/音乐）。 */
  playerOptional: readonly ManifestFile[];
}

export const GAME_MANIFESTS: Record<SupportedGameId, GameManifest> = {
  ra2: {
    gameId: 'ra2',
    thirdParty: [
      {
        name: 'game.exe',
        url: 'https://oldgame.store/game.exe',
        sha256: '06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb',
      },
    ],
    playerRequired: [
      { name: 'ra2.mix', note: '游戏主数据包（单位/建筑/界面等绝大多数资源）' },
      { name: 'language.mix', note: '语言与界面字符串（CSF）' },
      { name: 'Binkw32.dll', note: 'Bink 视频解码器（电影/过场）' },
      { name: 'Blowfish.dll', note: '启动依赖（游戏读取其内容，缺失即退出）' },
    ],
    playerOptional: [
      // mod 顶层覆盖文件（经典共和国之辉的 expand01.mix / ecache01.mix /
      // ra2.csf，及通用 rules.ini / art.ini / ai.ini）：有则随本地导入保留，
      // 无则仍启动原版。不拆 MIX、不替换第三方分享的主程序；清单也会自动扩充归档提取白名单。
      { name: 'ai.ini', note: 'mod 顶层 AI 配置覆盖（可选）' },
      { name: 'art.ini', note: 'mod 顶层美术配置覆盖（可选）' },
      { name: 'ecache01.mix', note: '共和国之辉 MOD 图像资源（可选）' },
      { name: 'expand01.mix', note: '共和国之辉 MOD 规则与扩展数据（可选）' },
      { name: 'game.fnt', note: '备选字体' },
      { name: 'Maps01.mix', note: '盟军战役地图' },
      { name: 'Maps02.mix', note: '苏军战役地图' },
      { name: 'movies01.mix', note: '电影包 A' },
      { name: 'movies02.mix', note: '电影包 B' },
      { name: 'Multi.mix', note: '多人/界面补充数据' },
      { name: 'ra2.csf', note: '共和国之辉 MOD 国家、单位及界面文字（可选）' },
      { name: 'rules.ini', note: 'mod 顶层规则覆盖（可选，原版规则在 ra2.mix→local.mix 内）' },
      { name: 'subtitle.txt', note: '电影字幕' },
      { name: 'Taunts/', directory: 'taunts/', note: '多人嘲讽语音' },
      { name: 'Theme.mix', note: '游戏音乐' },
    ],
  },
  yr: {
    gameId: 'yr',
    thirdParty: [
      {
        name: 'gamemd.exe',
        url: 'https://oldgame.store/gamemd.exe',
        sha256: '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6',
      },
    ],
    playerRequired: [
      { name: 'ra2md.mix', note: '尤里的复仇主数据' },
      { name: 'langmd.mix', note: 'YR 语言/字符串' },
      { name: 'BINKW32.DLL', note: 'Bink 视频解码器' },
      { name: 'Blowfish.dll', note: '启动硬依赖（缺文件或 0 字节 → 退出）' },
    ],
    playerOptional: [
      { name: 'expandmd01.mix', note: 'YR 扩展数据' },
      { name: 'game.fnt', note: '备选字体' },
      { name: 'MAPSMD03.MIX', note: 'YR 战役任务地图' },
      { name: 'movmd03.mix', note: 'YR 电影' },
      { name: 'MULTIMD.MIX', note: 'YR 多人/界面数据' },
      { name: 'subtitlemd.txt', note: 'YR 电影字幕' },
      { name: 'Taunts/', directory: 'taunts/', note: '多人嘲讽语音' },
      { name: 'thememd.mix', note: 'YR 音乐' },
    ],
  },
};

/** 两个游戏玩家侧清单的并集：归档提取一次拿到全部所需名（主程序来自第三方分享，
 *  不随包提取）。目录条目（Taunts/）带小写目录前缀，Worker 按前缀匹配并保留
 *  目录结构。 */
export const ARCHIVE_WANTED_NAMES: readonly string[] = [
  ...new Set(
    Object.values(GAME_MANIFESTS).flatMap((manifest) =>
      [...manifest.playerRequired, ...manifest.playerOptional].map((file) => file.directory ?? file.name),
    ),
  ),
];
