/**
 * 本地同步在线游戏包：下载显式指定的 ZIP（可校验 SHA-256），把压缩包
 * 留档到 game/<id>[-<pack>].zip，并解压到 game/<folder>/（RA2 与 YR 共用
 * game/ra2，与目录发现流程一致）。解压后 dev 按钮、e2e 冒烟与离线调试
 * 直接使用本地文件，不必每次在浏览器里下载。
 *
 * 用法：
 *   RA2_PACKAGE_URL="$RA2_DOWNLOAD_URL" pnpm run sync:game -- ra2
 *   YR_PACKAGE_URL="$YR_DOWNLOAD_URL" pnpm run sync:game -- yr
 * 内置 catalog 已移除下载源；使用上述环境变量指定 ZIP，亦可设置对应的
 * RA2_PACKAGE_SHA256 / YR_PACKAGE_SHA256。主程序缓存由 prepare:third-party 准备。
 *
 * 注意：RA2 的 e2e 冒烟（tests/real-game/ra2/）按原版安装主程序校准（368 个导入），
 * 在线包的 game.exe 是联机再打包版（369 个导入）；同步后 e2e 的导入数断言
 * 会不匹配，可用 VM_GAME_DIR 指向原版目录，或仅以浏览器 dev 流程为准。
 * 此留档入口只支持 ZIP；其他原始包直接在前端导入，CI 使用共享提取器。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SUPPORTED_GAMES, supportedGame, type SupportedGameId } from '../../src/games/catalog';
import { readZipArchive } from '../../src/utils/archive/zip';
import { sha256Hex } from '../../src/utils/sha256';
import { isArchiveTargetWithinRoot } from './archivePath';
import { fetchPackageFile } from './gamePackageDownload';

const requested = process.argv.slice(2);
const games = (requested.length ? requested : SUPPORTED_GAMES.map((game) => game.id)).map((id) =>
  supportedGame(id as SupportedGameId),
);

async function syncPackage(
  name: string,
  url: string,
  sha256: string | undefined,
  targetDirectory: string,
): Promise<void> {
  console.info(`[同步] 下载 ${url}`);
  let lastReportedMb = -1;
  const bytes = await fetchPackageFile(url, (downloaded, total) => {
    const mb = Math.floor(downloaded / (8 * 1024 * 1024));
    if (mb === lastReportedMb) return;
    lastReportedMb = mb;
    console.info(`[同步]   ${mb * 8} MB${total ? ` / ${Math.ceil(total / (8 * 1024 * 1024)) * 8} MB` : ''}`);
  });
  if (sha256) {
    console.info('[同步] 校验 SHA-256…');
    const actual = await sha256Hex(bytes);
    if (actual !== sha256) throw new Error(`${name} SHA-256 不匹配：${actual}`);
  }
  const zipPath = resolve('game', `${name}.zip`);
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, bytes);
  console.info(`[同步] 压缩包留档 ${zipPath}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
  const entries = await readZipArchive(bytes);
  const root = resolve(targetDirectory);
  let written = 0;
  for (const entry of entries) {
    const target = resolve(root, entry.path);
    // readZipArchive 已归一化路径（无盘符/反斜杠/上级段），此处仅纵深防御。
    if (!isArchiveTargetWithinRoot(root, target)) throw new Error(`拒绝写出目录外的路径：${entry.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes);
    written++;
  }
  console.info(`[同步] 解压 ${written} 个文件 → ${targetDirectory}`);
}

let synced = 0;
let failed = false;
for (const game of games) {
  const prefix = game.id.toUpperCase();
  const url = process.env[`${prefix}_PACKAGE_URL`];
  const sha256 = process.env[`${prefix}_PACKAGE_SHA256`];
  if (!url) {
    console.warn(`[同步] ${game.id} 未登记在线包，请设置 ${prefix}_PACKAGE_URL 指定 ZIP 地址。`);
    if (requested.length) failed = true;
    continue;
  }
  console.info(`[同步] === ${game.title}（${game.id}）本体 ===`);
  try {
    await syncPackage(`${game.id}-base`, url, sha256, resolve('game', game.folder));
    synced++;
  } catch (error) {
    failed = true;
    console.warn(`[同步] ${game.id} 本体失败：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
}
if (failed || !synced) {
  process.exitCode = 1;
  console.error(
    `[同步] ${synced ? '部分包同步失败，请检查上述错误。' : '未同步任何游戏包。'} 主程序缓存请运行 pnpm run prepare:third-party。`,
  );
} else {
  console.info(`[同步] 已同步 ${synced} 个游戏本体。主程序缓存请运行 pnpm run prepare:third-party。`);
}
