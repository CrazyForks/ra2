import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createThirdPartyCacheHandler } from '../../src/server/thirdPartyCache';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('开发主程序缓存端点', () => {
  it('只提供指定 EXE，缺失返回 404，不落入 SPA HTML', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ra2-third-party-test-'));
    await writeFile(join(directory, 'game.exe'), new Uint8Array([77, 90]));
    const handler = createThirdPartyCacheHandler(directory);
    async function request(url: string, method = 'GET') {
      let body: unknown;
      const headers = new Map();
      const response = {
        statusCode: 200,
        setHeader(name: string, value: unknown) {
          headers.set(name, value);
        },
        end(value: unknown) {
          body = value;
        },
      };
      await handler({ url, method } as IncomingMessage, response as unknown as ServerResponse);
      return { status: response.statusCode, headers, body };
    }
    const result = await request('/game.exe');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(Buffer.from([77, 90]));
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('/game.exe', 'HEAD')).body).toBeUndefined();
    expect((await request('/gamemd.exe')).status).toBe(404);
    expect((await request('/game.exe', 'POST')).status).toBe(405);
    for (const path of ['/', '/../game.exe', '/%2e%2e/game.exe', '/secret.txt']) {
      expect((await request(path)).status).toBe(404);
    }
  });
});
