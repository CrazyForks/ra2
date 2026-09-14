/** 有界的资源准备子进程：退出即回收 WASM、LZMA 与临时 JS 缓冲。 */
import { isAbsolute } from 'node:path';
import { prepareGame } from './prepareGame';
import { logMemory } from './memory';
const [game, root, ...extra] = process.argv.slice(2);
if ((game !== 'ra2' && game !== 'yr') || !root || !isAbsolute(root) || extra.length)
  throw new Error('用法：prepareGameProcess.mts <ra2|yr> <绝对资源目录>');
logMemory('prepare-start');
try {
  await prepareGame(game, root);
} catch (error) {
  console.error(error instanceof Error ? error.message : '资源准备失败');
  process.exitCode = 1;
} finally {
  logMemory('prepare-end');
}
