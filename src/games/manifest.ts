/**
 * Game-file manifests: required top-level startup files, their sources, and their purposes.
 *
 * Players supply executables (game.exe / gamemd.exe) together with their installation resources. Runtime capabilities are detected from the selected executable; importing never downloads or replaces it. The manifest panel displays present/missing files. Two-stage imports start once the full directory and startup layer are ready; other resource bytes may extract in the background but must not be treated as missing.
 *
 * Manifest evidence:
 * - RA2: compare game/ra2, a multiplayer-client bootable set verified by boot tests, with the full installation archive extracted from Red_Alert_2.rar. Omit full-installation-only files unused here: RegSetup.exe, Ra2.exe launcher, xwis.dll, wolapi.*, mph.exe, *.mmx, secdrv.sys, etc. Also omit nl.cfg / taunts / rmcache from the multiplayer set, shown unnecessary by RAR boot tests.
 * - YR: base-package reduction evidence in docs/RESOURCE_PACKAGE_EVIDENCE.md.
 */
import type { SupportedGameId } from './catalog';

export interface ManifestFile {
  /**
   * Top-level filename in any case; use the directory name for entries such as Taunts/.
   */
  name: string;
  /**
   * Purpose displayed in the manifest panel.
   */
  note: string;
  /**
   * Directory entry: lowercase prefix such as 'taunts/'; any filename with this prefix counts as present.
   */
  directory?: string;
}

export interface GameManifest {
  gameId: SupportedGameId;
  /**
   * Required player-supplied top-level files; startup requires every one.
   */
  playerRequired: readonly ManifestFile[];
  /**
   * Optional player-supplied top-level files, such as movies/campaigns/music; absence does not block startup.
   */
  playerOptional: readonly ManifestFile[];
}

export const GAME_MANIFESTS: Record<SupportedGameId, GameManifest> = {
  ra2: {
    gameId: 'ra2',
    playerRequired: [
      { name: 'game.exe', note: '资源包中的游戏主程序' },
      { name: 'ra2.mix', note: '游戏主数据包（单位/建筑/界面等绝大多数资源）' },
      { name: 'language.mix', note: '语言与界面字符串（CSF）' },
      { name: 'Binkw32.dll', note: 'Bink 视频解码器（电影/过场）' },
      { name: 'Blowfish.dll', note: '启动依赖（游戏读取其内容，缺失即退出）' },
    ],
    playerOptional: [
      { name: 'ra2.ini', note: '安装目录中的原始游戏设置（可选）' },
      // Top-level MOD overrides (classic Gonghui's expand01.mix / ecache01.mix /
      // ra2.csf, plus generic rules.ini / art.ini / ai.ini): retain them on local import when present;
      // otherwise start the original game. Do not unpack MIX files or replace package executables; the manifest also extends the extraction allowlist automatically.
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
    playerRequired: [
      { name: 'gamemd.exe', note: '资源包中的尤里的复仇主程序' },
      { name: 'ra2md.mix', note: '尤里的复仇主数据' },
      { name: 'langmd.mix', note: 'YR 语言/字符串' },
      { name: 'BINKW32.DLL', note: 'Bink 视频解码器' },
      { name: 'Blowfish.dll', note: '启动硬依赖（缺文件或 0 字节 → 退出）' },
    ],
    playerOptional: [
      { name: 'ra2md.ini', note: '安装目录中的原始游戏设置（可选）' },
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

/**
 * Union of both games' player-supplied manifests: obtain all required names in one archive extraction, including the original package executables. Directory entries such as Taunts/ carry lowercase prefixes; the Worker matches them and preserves directory structure.
 */
export const ARCHIVE_WANTED_NAMES: readonly string[] = [
  ...new Set(
    Object.values(GAME_MANIFESTS).flatMap((manifest) =>
      [...manifest.playerRequired, ...manifest.playerOptional].map((file) => file.directory ?? file.name),
    ),
  ),
];
