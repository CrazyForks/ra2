/**
 * 真实在线包端到端冒烟（不进入 CI）：下载显式指定的 RA2 联机安装包
 * （206MB NSIS solid LZMA），解包后用 SHA-256 校验主程序与关键资源。
 *
 * 用法：pnpm exec tsx tests/real-game/smoke/ra2NsisSmoke.mts
 * 耗时约 1-2 分钟（下载 + LZMA 解码），内存峰值 ~1.5GB。
 */
import { loadRemoteGamePackage } from '../../../scripts/resources/gamePackageDownload';
import { sha256Hex } from '../../../src/utils/sha256';

// 本地预转 ZIP 验证：RA2_PACKAGE_URL=http://localhost:8000/ra2.zip pnpm run test:ra2-nsis
const url = process.env.RA2_PACKAGE_URL;
if (!url) throw new Error('在线包地址已移除，请显式设置 RA2_PACKAGE_URL');

console.info(`[冒烟] 下载 ${url}`);
const provider = await loadRemoteGamePackage(url, {
  sha256: process.env.RA2_PACKAGE_SHA256,
  onStatus: (message) => console.info(`[冒烟] ${message}`),
});

/** 关键文件及其期望 SHA-256（7-Zip 解包基准；game.exe 为 2011 年中文 1.006 补丁版）。 */
const EXPECTED: Readonly<Record<string, string>> = {
  'game.exe': '06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb',
  'ra2.exe': '06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb',
};
let failures = 0;
for (const [path, expected] of Object.entries(EXPECTED)) {
  const bytes = await provider.read(path);
  if (!bytes) {
    console.error(`[冒烟] 缺少 ${path}`);
    failures++;
    continue;
  }
  const actual = await sha256Hex(bytes);
  const ok = actual === expected;
  console.info(`[冒烟] ${path} 大小 ${bytes.length} SHA-256 ${actual} ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failures++;
}
const listing = await provider.list('');
console.info(
  `[冒烟] 根目录条目：${(listing ?? []).length} 项；语言资源 ${listing?.includes('language.mix') ? '含 language.mix' : '缺少 language.mix'}`,
);
if (!listing?.includes('language.mix')) failures++;

if (failures > 0) {
  console.error(`[冒烟] ${failures} 项校验失败`);
  process.exit(1);
}
console.info('[冒烟] 通过。');
