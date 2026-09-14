import { expect, it } from 'vitest';
import { RA2_YR_RESOURCE_POLICY as policy } from '../../src/games/shared/resourcePolicy';
import { withGameSpeedDefault } from '../../src/games/gameSpeed';

it('RA2/YR 静态介质允许会话复用，配置、存档和未知类型仍重读', () => {
  for (const extension of [
    'mix',
    'bag',
    'idx',
    'shp',
    'pcx',
    'pal',
    'fnt',
    'csf',
    'aud',
    'vqa',
    'bik',
    'wav',
    'hva',
    'vxl',
    'map',
    'mpr',
    'yrm',
    'yro',
  ]) {
    expect(policy.isSessionStatic(`dir/FILE.${extension.toUpperCase()}`)).toBe(true);
  }
  for (const path of ['ra2.ini', 'save.sav', 'unknown', 'test.mix.tmp']) {
    expect(policy.isSessionStatic(path)).toBe(false);
  }
});

it('预载回退仅映射已有 DLL 路由，不把任意资源变成下载请求', () => {
  expect(policy.preloadFallbackUrl('BLOWFISH.DLL')).toBe('/game/ra2/Blowfish.dll');
  expect(policy.preloadFallbackUrl('binkw32.dll')).toBe('/game/ra2/BINKW32.DLL');
  for (const path of ['game.exe', 'missing.dll', '../../blowfish.dll', 'constructor', '__proto__']) {
    expect(policy.preloadFallbackUrl(path)).toBeUndefined();
  }
});

it('启动准备复用已覆盖分辨率、名字和内存 overlay 语义的速度策略', () => {
  expect(policy.prepareSource).toBe(withGameSpeedDefault);
});
