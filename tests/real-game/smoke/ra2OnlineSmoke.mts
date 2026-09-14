/**
 * RA2 可选包端到端冒烟（不进入 CI）：下载显式指定的战役地图包（约 2MB，
 * MAPS01.MIX + maps02.mix）与电影包（约 628MB ZIP，movies01/02.mix +
 * subtitle.txt），校验内容 SHA-256，再用两级 OverlayGameFileProvider 叠加在
 * 0 字节占位基包上（本体 < 战役 < 电影），确认稀疏播放所需语义
 * （readPrefix 返回真实 totalSize、战役/电影包独有文件 hasKnownFile 命中）。
 *
 * 用法：设置 RA2_CAMPAIGN_PACK_URL、RA2_MOVIES_PACK_URL 后运行
 * pnpm exec tsx tests/real-game/smoke/ra2OnlineSmoke.mts；内置 catalog 不再提供在线 ZIP 地址。
 * 耗时取决于网络；电影包内为 Bink 高熵数据，下载后解压快。
 */
import { MemoryGameFileProvider } from '../../../src/resources/providers/memory';
import { OverlayGameFileProvider } from '../../../src/resources/providers/overlay';
import { loadRemoteGamePackage } from '../../../scripts/resources/gamePackageDownload';
import { sha256Hex } from '../../../src/utils/sha256';

const campaignUrl = process.env.RA2_CAMPAIGN_PACK_URL;
const moviesUrl = process.env.RA2_MOVIES_PACK_URL;
if (!campaignUrl || !moviesUrl) {
  throw new Error('在线 ZIP 地址已移除，请显式设置 RA2_CAMPAIGN_PACK_URL 和 RA2_MOVIES_PACK_URL');
}

let failures = 0;
console.info(`[冒烟] 下载战役包 ${campaignUrl}`);
const campaignProvider = await loadRemoteGamePackage(campaignUrl, {
  sha256: process.env.RA2_CAMPAIGN_PACK_SHA256,
  onStatus: (message) => console.info(`[冒烟] ${message}`),
});
console.info(`[冒烟] 下载电影包 ${moviesUrl}`);
const moviesProvider = await loadRemoteGamePackage(moviesUrl, {
  sha256: process.env.RA2_MOVIES_PACK_SHA256,
  onStatus: (message) => console.info(`[冒烟] ${message}`),
});

/** 包内内容 SHA-256（与完整游戏目录源文件一致；deflate 不改变内容）。 */
const EXPECTED: Readonly<Record<string, { expected: string; minBytes: number }>> = {
  'MAPS01.MIX': {
    expected: 'b9093c9ef7efc1d24c6259196fbe90c8b78a15d0af27c93c12e1c755e5196d74',
    minBytes: 3 * 1024 * 1024,
  },
  'maps02.mix': {
    expected: '8ff61284f726a67760563c7a278c9034ff44baa5ca86a6790eddeb273301b11f',
    minBytes: 3 * 1024 * 1024,
  },
  'movies01.mix': {
    expected: '1121c4899b4f978bf9dbabbfc1776be09253b2d576e1182a8067ec3ad5c9d7fc',
    minBytes: 300 * 1024 * 1024,
  },
  'movies02.mix': {
    expected: 'e0e13c34b1b8299b9198317ac7276c4ad7790cd8996ec06ab25489f25e838643',
    minBytes: 200 * 1024 * 1024,
  },
  'subtitle.txt': {
    expected: 'adb1860542f51f287cb45ee5d4737991f16a47ddb02b2be424fcb7be22410ea4',
    minBytes: 0,
  },
};
for (const [path, { expected, minBytes }] of Object.entries(EXPECTED)) {
  const bytes =
    (await moviesProvider.read(path).catch(() => null)) ?? (await campaignProvider.read(path).catch(() => null));
  if (!bytes) {
    console.error(`[冒烟] 缺少 ${path}`);
    failures++;
    continue;
  }
  const actual = await sha256Hex(bytes);
  const ok = actual === expected;
  console.info(`[冒烟] ${path} 大小 ${bytes.length} SHA-256 ${actual} ${ok ? 'OK' : 'FAIL'}`);
  if (!ok || bytes.length < minBytes) {
    if (!ok) console.error(`[冒烟] ${path} 内容哈希不符`);
    if (bytes.length < minBytes) console.error(`[冒烟] ${path} 大小异常：${bytes.length}`);
    failures++;
  }
}

// 模拟联机精简基包：MAPS01/movies01 为 0 字节占位、无 maps02/movies02/subtitle；
// 战役包与电影包依次作 overlay（本体 < 战役 < 电影）。稀疏播放走 readPrefix/
// readRange：overlay 命中时必须返回真实 totalSize。
const placeholderBase = new MemoryGameFileProvider(
  new Map([
    ['MAPS01.MIX', new Uint8Array(0)],
    ['movies01.mix', new Uint8Array(0)],
  ]),
  true,
  '联机精简基包',
);
const withCampaign = new OverlayGameFileProvider(placeholderBase, campaignProvider.files, '（战役包）', false, false);
const base = new OverlayGameFileProvider(withCampaign, moviesProvider.files, '（电影包）', false, false);

for (const [path, minimum] of [
  ['movies01.mix', 300 * 1024 * 1024],
  ['MAPS01.MIX', 3 * 1024 * 1024],
] as const) {
  const prefix = await base.readPrefix(path, 1024 * 1024);
  console.info(`[冒烟] overlay readPrefix ${path} totalSize=${prefix?.totalSize} 字节`);
  if (!prefix || prefix.totalSize < minimum) {
    console.error(`[冒烟] overlay readPrefix ${path} 未返回真实 totalSize`);
    failures++;
  }
}
if (base.hasKnownFile('maps02.mix') !== true) {
  console.error('[冒烟] 战役包独有文件 maps02.mix 未被 overlay 认可');
  failures++;
}
if (base.hasKnownFile('movies02.mix') !== true) {
  console.error('[冒烟] 电影包独有文件 movies02.mix 未被 overlay 认可');
  failures++;
}
const range = await base.readRange('movies01.mix', 0, 4096);
if (!range || range.length !== 4096) {
  console.error('[冒烟] overlay readRange 未命中电影包 overlay');
  failures++;
}

if (failures > 0) {
  console.error(`[冒烟] ${failures} 项校验失败`);
  process.exit(1);
}
console.info('[冒烟] 通过。');
