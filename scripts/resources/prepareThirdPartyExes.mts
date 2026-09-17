/**
 * Download executables (game.exe / gamemd.exe) from third-party shared locations, using URLs and SHA-256 values registered in the manifest, to:
 * - .tmp-third-party/ (gitignored): local cache for development startup and original EXE regressions; public unit tests do not depend on it.
 * - game/<folder>/: fill in missing EXEs when the directory exists for e2e/development; preserve existing files whose bytes differ from the registered values to avoid overwriting local MOD/experimental binaries.
 * Exit 1 on verification failure; never write unverified bytes.
 *
 * Usage: pnpm exec tsx scripts/resources/prepareThirdPartyExes.mts [--force]
 *   --force  Ignore valid local caches and force a fresh download.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../src/utils/sha256';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { GAME_MANIFESTS } from '../../src/games/manifest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_DIR = join(REPO_ROOT, '.tmp-third-party');
const force = process.argv.includes('--force');

async function readIfMatches(path: string, expectedSha: string): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    return (await sha256Hex(bytes)) === expectedSha ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * If game/ exists, fill in EXEs: write missing files, verify existing ones, and never overwrite differing bytes.
 */
async function ensureInGameDir(folder: string, name: string, expectedSha: string, bytes: Uint8Array): Promise<void> {
  const gameDir = join(REPO_ROOT, 'game', folder);
  if (!existsSync(gameDir)) return;
  const target = join(gameDir, name);
  if (existsSync(target)) {
    const existing = new Uint8Array(await readFile(target));
    const actual = await sha256Hex(existing);
    if (actual !== expectedSha) {
      console.log(`[保留原文件] ${target}（字节与登记值不同，不覆盖）`);
      return;
    }
    console.log(`[已就位] ${target}`);
    return;
  }
  await writeFile(target, bytes);
  console.log(`[已就位] ${target}`);
}

let failed = false;
for (const game of SUPPORTED_GAMES) {
  const manifest = GAME_MANIFESTS[game.id];
  for (const thirdParty of manifest.thirdParty) {
    try {
      const cachedPath = join(CACHE_DIR, thirdParty.name);
      let bytes = force ? null : await readIfMatches(cachedPath, thirdParty.sha256);
      if (bytes) {
        console.log(`[缓存命中] ${thirdParty.name}`);
      } else {
        console.log(`[下载] ${thirdParty.url}`);
        const response = await fetch(thirdParty.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
        const actual = await sha256Hex(bytes);
        if (actual !== thirdParty.sha256) {
          throw new Error(`SHA-256 校验失败（${actual}），拒绝写入`);
        }
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cachedPath, bytes);
        console.log(`[已缓存] ${cachedPath}`);
      }
      await ensureInGameDir(game.folder, thirdParty.name, thirdParty.sha256, bytes);
    } catch (error) {
      failed = true;
      console.error(`[失败] ${thirdParty.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('主程序就绪。');
}
