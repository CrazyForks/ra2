import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PreviewServer, ViteDevServer } from 'vite';
import { createGameRelay } from 'relay-package/server';
import { parseRelayFaultConfig } from 'relay-package/faults';
import { createThirdPartyCacheHandler } from './src/server/thirdPartyCache';

type ViteHttpServer = NonNullable<ViteDevServer['httpServer']> | NonNullable<PreviewServer['httpServer']>;

/**
 * 把本地且被 Git 忽略的 game/ 原版资源以 /game/* 路径暴露给浏览器。
 * 这样 fetch('/game/Title.bmp') 就能拿到原版数据文件，无需复制资源。
 */
const GAME_DIR = resolve(process.env.RA2_GAME_ROOT || fileURLToPath(new URL('./game', import.meta.url)));

function gameAssetsPlugin(): Plugin {
  return {
    name: 'ra2:game-assets',
    configureServer(server) {
      // 缓存不进 public/dist，生产构建与 preview 不提供此端点。
      server.middlewares.use(
        '/__third-party',
        createThirdPartyCacheHandler(
          resolve(
            process.env.RA2_THIRD_PARTY_CACHE_DIR || fileURLToPath(new URL('./.tmp-third-party', import.meta.url)),
          ),
        ),
      );
      server.middlewares.use('/game', serveGameAsset);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/game', serveGameAsset);
    },
  };
}

function ra2NetworkRelayPlugin(): Plugin {
  return {
    name: 'ra2:network-relay',
    configureServer(server) {
      attachRa2NetworkRelay(server);
    },
    configurePreviewServer(server) {
      attachRa2NetworkRelay(server);
    },
  };
}

/** attachDplayRelay 只需要这两个成员；dev/preview 的 server 都是结构化子集。 */
interface RelayHostServer {
  httpServer: ViteHttpServer | null;
  close(): Promise<void>;
}

/** RA2 虚拟局域网中继挂在 /ra2。 */
function attachRa2NetworkRelay(server: RelayHostServer): void {
  const httpServer = server.httpServer;
  if (!httpServer) return;
  const relay = createGameRelay({ faults: parseRelayFaultConfig(process.env.RA2_NET_FAULTS) });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    } catch {
      return;
    }
    if (pathname !== '/ra2') return;
    relay.handleUpgrade(request, socket, head);
  };
  httpServer.on('upgrade', onUpgrade);
  httpServer.once('close', () => httpServer.off('upgrade', onUpgrade));
  const originalClose = server.close.bind(server);
  server.close = async () => {
    relay.close();
    await relay.drained();
    return originalClose();
  };
}

function serveGameAsset(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? '';
  const query = rawUrl.split('?')[1] ?? '';
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawUrl.split('?')[0]);
  } catch {
    res.statusCode = 400;
    res.end('bad path');
    return;
  }
  // 游戏目录枚举端点，供浏览器端自动发现 EXE（如 /game/.list?dir=ra2）。
  if (urlPath === '/.list') {
    const directory = new URLSearchParams(query).get('dir') ?? '';
    const target = resolveGameDirectory(directory);
    if (!target) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readdirSync(target)));
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
    return;
  }
  const resolved = resolveGameFile(urlPath);
  if (!resolved) {
    // 必须在 /game 中终止；交给 Vite SPA fallback 会把 index.html 误当成游戏文件。
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const st = statSync(resolved);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'max-age=86400');
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', String(end - start + 1));
        createReadStream(resolved, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.statusCode = 200;
  res.setHeader('Content-Length', String(st.size));
  createReadStream(resolved).pipe(res);
}

/** resolveGameFile 的目录版：逐级大小写无关解析，最终必须是 GAME_DIR 内的目录。 */
function resolveGameDirectory(urlPath: string): string | null {
  if (!urlPath) return GAME_DIR;
  const parts = urlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  let current = GAME_DIR;
  try {
    for (const part of parts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) return null;
      current = join(current, actual);
    }
    return statSync(current).isDirectory() && isWithinGameDirectory(current) ? current : null;
  } catch {
    return null;
  }
}

/** 原版目录和文件名大小写混乱，逐级做大小写无关解析。 */
function resolveGameFile(urlPath: string): string | null {
  const parts = urlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  let current = GAME_DIR;
  try {
    for (const part of parts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) return null;
      current = join(current, actual);
    }
    return statSync(current).isFile() && isWithinGameDirectory(current) ? current : null;
  } catch {
    return null;
  }
}

/** 跨平台判断解析后的路径仍位于 game 根目录内；Windows 使用反斜杠，不能硬编码 `/`。 */
function isWithinGameDirectory(candidate: string): boolean {
  const relativePath = relative(resolve(GAME_DIR), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export default defineConfig({
  plugins: [basicSsl(), gameAssetsPlugin(), ra2NetworkRelayPlugin()],
  // hmr=false 的 VM 页面不能依赖重载消化二次预构建；提前登记 JSX 和 Worker 动态依赖，
  // 避免懒加载页面拿到另一份 React。这里只生成开发缓存，不提前加载浏览器实验模块。
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'fflate',
      'v86',
      '7z-wasm',
      'onnxruntime-web/webgpu',
    ],
  },
  server: {
    host: true, // 监听 0.0.0.0，局域网内其他设备可访问（终端会打印 Network 地址）
    port: 15174,
    strictPort: true,
    // VM 和长时间回归都是有状态的；代码变动不应重载页面或销毁测试中的 VM。
    hmr: false,
    // 开发期禁缓存：模块热更新/硬刷新时避免浏览器复用旧模块（曾导致 map.ts 新旧混跑）
    // （/game 资源中间件自行设置 max-age=86400，不受此影响）
    headers: { 'Cache-Control': 'no-store' },
    fs: { allow: ['.'] },
  },
  preview: { port: 4174, strictPort: true },
  build: { target: 'es2022' },
  worker: {
    // vmClient.ts 以 `new Worker(new URL('./vmWorker.ts', import.meta.url), { type: 'module' })`
    // 起模块 worker；Vite 对代码分割 worker 要求 ES 输出（默认 iife 会报错）。
    format: 'es',
  },
});
