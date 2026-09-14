import { withGameSpeedDefault } from '../gameSpeed';
import type { ResourcePolicy } from '../../resources/contracts';
import type { GameSource } from '../source';

/** 安装介质资源可复用会话快照；INI/SAV 等可变文件必须在打开时重读。
 * YR 的 .yro 同样是静态地图，不能遗漏而导致每次扫描都跨线程读取。
 */
const STATIC_RESOURCE = /\.(?:mix|bag|idx|shp|pcx|pal|fnt|csf|aud|vqa|bik|wav|hva|vxl|map|mpr|yrm|yro)$/i;
/** 保留现有目录句柄缺 DLL 时的本地路由回退；不是 CDN 或新下载来源。 */
const PRELOAD_FALLBACK: Readonly<Record<string, string>> = {
  'blowfish.dll': '/game/ra2/Blowfish.dll',
  'binkw32.dll': '/game/ra2/BINKW32.DLL',
};

export const RA2_YR_RESOURCE_POLICY: ResourcePolicy<GameSource> = Object.freeze({
  prepareSource: withGameSpeedDefault,
  isSessionStatic: (normalizedPath: string) => STATIC_RESOURCE.test(normalizedPath),
  preloadFallbackUrl: (path: string) =>
    Object.hasOwn(PRELOAD_FALLBACK, path.toLowerCase()) ? PRELOAD_FALLBACK[path.toLowerCase()] : undefined,
});
