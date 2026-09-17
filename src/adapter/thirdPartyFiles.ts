/**
 * Fetch and persist third-party shared executables (game.exe / gamemd.exe, etc.) in the browser.
 *
 * Use the sharing URLs registered in the manifest, with HTTP caching and CORS headers permitting cross-origin reads. After the first download, also persist to IndexedDB (ra2-vm-third-party-files) so subsequent reads need no network. Download again if the URL changes or SHA verification fails.
 */
import { sha256Hex } from '../utils/sha256';
import type { GameManifest, ThirdPartyFile } from '../games/manifest';

const THIRD_PARTY_DB = 'ra2-vm-third-party-files';
const THIRD_PARTY_STORE = 'files';
// Preloading, importing, and cache restoration share one download; include the hash in the key to prevent reuse of old versions.
const thirdPartyLoads = new Map<string, Promise<Uint8Array>>();

function openThirdPartyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(THIRD_PARTY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(THIRD_PARTY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readThirdPartyCache(url: string): Promise<Uint8Array | null> {
  const database = await openThirdPartyDatabase();
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const request = database.transaction(THIRD_PARTY_STORE).objectStore(THIRD_PARTY_STORE).get(url);
      request.onsuccess = () => {
        const bytes = request.result as Uint8Array | undefined;
        resolve(bytes && bytes.length ? bytes : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function writeThirdPartyCache(url: string, bytes: Uint8Array): Promise<void> {
  const database = await openThirdPartyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(THIRD_PARTY_STORE, 'readwrite');
      transaction.objectStore(THIRD_PARTY_STORE).put(bytes, url);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function loadThirdPartyFile(thirdParty: ThirdPartyFile): Promise<Uint8Array> {
  const key = JSON.stringify([thirdParty.url, thirdParty.sha256]);
  const existing = thirdPartyLoads.get(key);
  if (existing) return existing;
  const pending = (async () => {
    // Prefer the development disk cache while verifying the same manifest; fall back to CDN/browser caches only if it is missing.
    // The production build removes this DEV branch, so online users never request development endpoints.
    if (import.meta.env.DEV) {
      const response = await fetch(`/__third-party/${encodeURIComponent(thirdParty.name)}`, { cache: 'no-store' });
      if (response.status !== 404) {
        if (!response.ok) throw new Error(`本地主程序缓存 ${thirdParty.name} 读取失败（HTTP ${response.status}）`);
        if (response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
          throw new Error(
            `本地主程序端点 ${thirdParty.name} 返回了 HTML 页面，请重启开发服务（pnpm run dev）后刷新页面`,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const actual = await sha256Hex(bytes);
        if (thirdParty.sha256 && actual !== thirdParty.sha256) {
          throw new Error(
            `本地主程序缓存 ${thirdParty.name} SHA-256 校验失败（期望 ${thirdParty.sha256}，实际 ${actual}），请运行 pnpm run prepare:third-party 后重试`,
          );
        }
        return bytes;
      }
    }
    // Disabled IndexedDB or insufficient storage quota must not prevent startup; retain the in-page memory cache.
    const cached = await readThirdPartyCache(thirdParty.url).catch(() => null);
    if (cached && (!thirdParty.sha256 || (await sha256Hex(cached)) === thirdParty.sha256)) return cached;
    const response = await fetch(thirdParty.url);
    if (!response.ok) throw new Error(`主程序文件 ${thirdParty.name} 下载失败（HTTP ${response.status}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (thirdParty.sha256 && (await sha256Hex(bytes)) !== thirdParty.sha256) {
      throw new Error(`主程序文件 ${thirdParty.name} SHA-256 校验失败，请刷新后重试`);
    }
    await writeThirdPartyCache(thirdParty.url, bytes).catch(() => {});
    return bytes;
  })().catch((error) => {
    // A failed background preload affects only that request; allow a fresh attempt when the user starts later.
    thirdPartyLoads.delete(key);
    throw error;
  });
  thirdPartyLoads.set(key, pending);
  return pending;
}

/**
 * Warm both games in parallel on page entry; failure does not block page initialization, and startup still retries and reports errors.
 */
export async function preloadThirdPartyFiles(manifests: readonly GameManifest[]): Promise<void> {
  await Promise.all(
    manifests.map((manifest) =>
      loadThirdPartyFiles(manifest).catch((error) => {
        console.warn(`[主程序预加载] ${manifest.gameId} 暂未就绪，启动时将重试`, error);
      }),
    ),
  );
}

export async function loadThirdPartyFiles(
  manifest: GameManifest,
  onStatus?: (message: string) => void,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  await Promise.all(
    manifest.thirdParty.map(async (thirdParty) => {
      onStatus?.(`正在加载 ${thirdParty.name}…`);
      const bytes = await loadThirdPartyFile(thirdParty);
      // The VM may modify or transfer the EXE; give each caller an independent copy to protect the preload cache.
      files.set(thirdParty.name, bytes.slice());
      onStatus?.(`已加载 ${thirdParty.name}`);
    }),
  );
  return files;
}
