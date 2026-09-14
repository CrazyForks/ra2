/** 分离浏览器与服务端入口，共享协议代码只生成一份，不把 Node 依赖带入网页。 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
// 构建目录完全由本脚本生成，清除旧入口和失去引用的分块。
await rm(resolve(root, 'dist/lib'), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    client: 'src/client/index.ts',
    server: 'src/server/gameRelay.ts',
    faults: 'src/server/relayFaults.ts',
    wire: 'src/network/relayWire.ts',
  },
  outdir: 'dist/lib',
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  bundle: true,
  splitting: true,
  packages: 'external',
});
