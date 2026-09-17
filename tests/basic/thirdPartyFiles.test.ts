import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/utils/sha256';
import type { GameManifest } from '../../src/games/manifest';

const bytes = new Uint8Array([1, 2, 3]);
async function manifest(gameId: 'ra2' | 'yr' = 'ra2'): Promise<GameManifest> {
  return {
    gameId,
    thirdParty: [
      {
        name: gameId === 'ra2' ? 'game.exe' : 'gamemd.exe',
        url: `https://assets.invalid/${gameId}.exe`,
        sha256: await sha256Hex(bytes),
      },
    ],
    playerRequired: [],
    playerOptional: [],
  };
}

function cache(initial: Uint8Array, failWrite = false) {
  vi.stubGlobal('indexedDB', {
    open() {
      const request: any = {};
      request.result = {
        close() {},
        transaction(_store: string, mode?: string) {
          const transaction: any = {
            objectStore() {
              return {
                get() {
                  const read: any = { result: initial };
                  queueMicrotask(() => read.onsuccess());
                  return read;
                },
                put() {
                  queueMicrotask(() => (failWrite ? transaction.onerror() : transaction.oncomplete()));
                },
              };
            },
          };
          if (mode === 'readwrite' && failWrite) transaction.error = new Error('quota');
          return transaction;
        },
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', undefined);
  vi.stubEnv('DEV', false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('主程序页面异步预加载', () => {
  it('开发模式优先本地磁盘缓存，不请求 CDN', async () => {
    vi.stubEnv('DEV', true);
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    expect((await loadThirdPartyFiles(await manifest())).get('game.exe')).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/__third-party/game.exe', { cache: 'no-store' });
  });

  it('开发缓存不存在时回退 CDN', async () => {
    vi.stubEnv('DEV', true);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    await loadThirdPartyFiles(game);
    expect(fetcher).toHaveBeenNthCalledWith(2, game.thirdParty[0]!.url);
  });

  it('开发缓存损坏时拒绝启动，不偷偷替换成 CDN 文件', async () => {
    vi.stubEnv('DEV', true);
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([9])));
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    // Compute the expected hash before creating a rejecting request, or rejects will not be attached during the await.
    const actual = await sha256Hex(new Uint8Array([9]));
    await expect(loadThirdPartyFiles(game)).rejects.toThrow(
      `本地主程序缓存 game.exe SHA-256 校验失败（期望 ${game.thirdParty[0]!.sha256}，实际 ${actual}），请运行 pnpm run prepare:third-party 后重试`,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('旧开发服务返回首页 HTML 时提示重启服务，修复后允许重试', async () => {
    vi.stubEnv('DEV', true);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<!doctype html><html></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    await expect(loadThirdPartyFiles(game)).rejects.toThrow('返回了 HTML 页面，请重启开发服务（pnpm run dev）');
    expect((await loadThirdPartyFiles(game)).get('game.exe')).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith('/__third-party/game.exe', { cache: 'no-store' });
  });
  it('两款 EXE 并发开始，启动请求复用在途下载和完成后的缓存', async () => {
    const ra2 = await manifest(),
      yr = await manifest('yr');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn(async () => {
      await gate;
      return new Response(bytes);
    });
    vi.stubGlobal('fetch', fetcher);
    const { preloadThirdPartyFiles, loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const preloading = preloadThirdPartyFiles([ra2, yr]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const starting = loadThirdPartyFiles(ra2);
    finish();
    await preloading;
    expect((await starting).get('game.exe')).toEqual(bytes);
    await loadThirdPartyFiles(yr);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('预加载失败不拒绝页面流程，启动时重新尝试', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const { preloadThirdPartyFiles, loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    await expect(preloadThirdPartyFiles([game])).resolves.toBeUndefined();
    expect((await loadThirdPartyFiles(game)).get('game.exe')).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('缓存有效时无需联网', async () => {
    cache(bytes);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    expect((await loadThirdPartyFiles(await manifest())).get('game.exe')).toEqual(bytes);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('损坏缓存重新下载，持久化失败仍能启动', async () => {
    cache(new Uint8Array([9]), true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    expect((await loadThirdPartyFiles(await manifest())).get('game.exe')).toEqual(bytes);
  });

  it('下载哈希错误不会成为可复用缓存', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([9])))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    await expect(loadThirdPartyFiles(game)).rejects.toThrow('SHA-256');
    expect((await loadThirdPartyFiles(game)).get('game.exe')).toEqual(bytes);
  });

  it('调用者修改或 transfer 副本不损坏缓存', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    const first = (await loadThirdPartyFiles(game)).get('game.exe')!;
    first[0] = 9;
    structuredClone(first, { transfer: [first.buffer] });
    expect((await loadThirdPartyFiles(game)).get('game.exe')).toEqual(bytes);
  });

  it('同 URL 更换哈希后不能复用旧内存版本', async () => {
    const next = new Uint8Array([4]);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(new Response(next));
    vi.stubGlobal('fetch', fetcher);
    const { loadThirdPartyFiles } = await import('../../src/adapter/thirdPartyFiles');
    const game = await manifest();
    await loadThirdPartyFiles(game);
    game.thirdParty[0]!.sha256 = await sha256Hex(next);
    expect((await loadThirdPartyFiles(game)).get('game.exe')).toEqual(next);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
