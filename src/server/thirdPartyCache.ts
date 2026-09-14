import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 仅供 Vite dev 注册：固定白名单，不暴露缓存目录枚举或任意文件读取。 */
export function createThirdPartyCacheHandler(directory: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = request.url?.split('?')[0];
    if (path !== '/game.exe' && path !== '/gamemd.exe') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    try {
      const bytes = await readFile(join(directory, path.slice(1)));
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', bytes.length);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      response.statusCode = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      response.end('local thirdParty cache unavailable');
    }
  };
}
