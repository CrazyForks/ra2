import { GAME_ARCHIVE_DIRECTORY_RULES } from '../../src/games/archivePolicy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchiveExtractor } from '../../src/utils/archive/archiveExtractor';
import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS } from '../../src/games/manifest';
import type { SupportedGameId } from '../../src/games/catalog';
import { assertGameResources, inventoryResources, sha256 } from './gameResources';
import { downloadResources } from './downloadResources';

/** 与前端相同的完整导入；CI 等待全部提取结束，不启用启动层抢跑。 */
export async function extractGameArchive(
  archive: string,
  destination: string,
  wanted: readonly string[],
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.extract-'));
  try {
    let files = 0,
      size = 0,
      complete = false;
    let failure: string | undefined;
    const extract = createArchiveExtractor({
      mountInput(sevenZip) {
        // 只挂载本次下载目录；NODEFS 按需读取，与浏览器 WORKERFS 不复制整包的语义一致。
        sevenZip.FS.mount(sevenZip.NODEFS, { root: dirname(archive) }, '/work');
      },
      mountOutput(sevenZip) {
        // solid/嵌套包仍用共享提取算法；大批输出落盘，避免整包常驻 MEMFS。
        sevenZip.FS.mount(sevenZip.NODEFS, { root: staging }, '/out');
      },
      post(message) {
        if (message.type === 'error') failure = message.message;
        if (message.type === 'done') complete = true;
        if (message.type !== 'file') return;
        const path = message.name.replaceAll('\\', '/');
        if (
          path.startsWith('/') ||
          path.split('/').some((part) => !part || part === '..' || part === '.') ||
          /[\r\n\0:]/.test(path)
        )
          throw new Error('提取结果路径无效');
        size += message.bytes.length;
        if (++files > 200_000 || size > 32 * 1024 ** 3) throw new Error('资源提取数量或体积超限');
        const target = join(destination, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, message.bytes, { flag: 'wx' });
      },
    });
    // 下载模块固定保存为 archive.bin，避免原始 URL/文件名进入提取器日志。
    await extract({ type: 'extract', wanted: [...wanted], directoryRules: GAME_ARCHIVE_DIRECTORY_RULES });
    if (failure || !complete || !files) throw new Error('游戏包提取失败或未提取到所需资源');
    console.log(`游戏包提取完成：${files} 个文件，${size} 字节`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareGame(
  game: SupportedGameId,
  root: string,
): Promise<{ manifest: string; expected: string }> {
  const gameDirectory = join(root, 'game', 'ra2');
  const thirdParty = join(root, 'thirdParty');
  await mkdir(gameDirectory, { recursive: true });
  await mkdir(thirdParty);
  await extractGameArchive(join(root, 'archive.bin'), gameDirectory, ARCHIVE_WANTED_NAMES);
  // 前端同样以清单登记的精确 EXE 覆盖游戏包主程序，固定哈希是独立的版本契约。
  for (const file of GAME_MANIFESTS[game].thirdParty) {
    console.log(`准备主程序：${file.name}`);
    await downloadResources(file.url, file.sha256, join(thirdParty, file.name));
    await copyFile(join(thirdParty, file.name), join(gameDirectory, file.name));
  }
  const inventory = await inventoryResources({ game: join(root, 'game'), thirdParty });
  assertGameResources(inventory, game);
  // 输入已由 secret 整包哈希、主程序固定哈希认证；此清单记录本次物化结果，非新信任基线。
  const manifest = join(root, 'inventory.json');
  await writeFile(manifest, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return { manifest, expected: sha256(await readFile(manifest)) };
}

// 独立进程拥有提取器和 WASM 内存；退出后再开始 VM 验收。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [game, root, ...extra] = process.argv.slice(2);
  if (extra.length || (game !== 'ra2' && game !== 'yr') || !root || !isAbsolute(root)) {
    throw new Error('用法：prepareGame.ts <ra2|yr> <绝对资源目录>');
  }
  const prepared = await prepareGame(game, root);
  await writeFile(join(root, 'prepared.json'), JSON.stringify(prepared), { flag: 'wx' });
  console.log(`资源提取进程峰值 RSS：${Math.round(process.resourceUsage().maxRSS / 1024)} MiB`);
}
