import { withGameSpeedDefault } from '../gameSpeed';
import type { ResourcePolicy } from '../../resources/contracts';
import type { GameSource } from '../source';

/**
 * Installation-media resources may reuse session snapshots; mutable INI/SAV files must be reread on open.
 * YR .yro files are static maps too; omitting them would cause cross-thread reads on every scan.
 */
const STATIC_RESOURCE = /\.(?:mix|bag|idx|shp|pcx|pal|fnt|csf|aud|vqa|bik|wav|hva|vxl|map|mpr|yrm|yro)$/i;
/** Preserve the existing local-route fallback for missing DLLs in directory handles; this is neither a CDN nor a new download source. */
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
