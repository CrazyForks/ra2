import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS } from './manifest';
import type { SupportedGameId } from './catalog';
import type { ArchiveDirectoryRule } from '../utils/archive/archiveExtractor';

/** 部分 RA2/YR 安装器把嘲讽语音平铺，沿用原版 taunts 目录归位约定。 */
export const GAME_ARCHIVE_DIRECTORY_RULES: readonly ArchiveDirectoryRule[] = [
  { directory: 'taunts/', basenamePattern: '^tau[a-z]{2}\\d{2}\\.wav$' },
];

/** 两层而非按页面细分：必需数据和 MOD 覆盖优先，地图/影片/音乐/嘲讽延后。
 * 可选不是可晚发现：全部目录必须先公布，MOD 不得在原版规则初始化后才出现。 */
export function gameArchiveLayers(gameId?: SupportedGameId): {
  required: string[];
  startup: string[];
  wanted: string[];
} {
  if (!gameId) {
    const all = Object.keys(GAME_MANIFESTS).map((id) => gameArchiveLayers(id as SupportedGameId));
    // 未选游戏时先公布完整目录，启动层取并集；只提取包内实际存在的文件。
    return {
      required: [],
      startup: [...new Set(all.flatMap((layer) => layer.startup))],
      wanted: [...ARCHIVE_WANTED_NAMES],
    };
  }
  const manifest = GAME_MANIFESTS[gameId];
  const required = manifest.playerRequired.map((file) => file.name.toLowerCase());
  const other = /^(?:maps\w*\.mix|movies\d+\.mix|movmd\d+\.mix|theme(?:md)?\.mix|subtitle(?:md)?\.txt|taunts\/)$/;
  const optional = manifest.playerOptional.map((file) => file.name.toLowerCase());
  // 保留原有归档白名单，不能因分层悄悄丢弃包内资源；YR 安装目录可能仍依赖
  // RA2 主数据，存在时一起优先准备，但不扩大现有必需清单。
  const base = gameId === 'yr' ? GAME_MANIFESTS.ra2.playerRequired.map((file) => file.name.toLowerCase()) : [];
  return {
    required,
    startup: [...new Set([...required, ...base, ...optional.filter((name) => !other.test(name))])],
    wanted: [...ARCHIVE_WANTED_NAMES],
  };
}
