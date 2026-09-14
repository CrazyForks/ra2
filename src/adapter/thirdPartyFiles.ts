/**
 * 第三方分享的主程序（game.exe / gamemd.exe 等）获取与浏览器持久化。
 *
 * 主程序走 manifest 登记的第三方分享地址（HTTP 缓存生效，须回 CORS 头允许
 * 站点跨源读取）；首次下载后另落 IndexedDB（ra2-vm-third-party-files），此后
 * 直接从缓存取，不再依赖网络；地址变更或 SHA 校验失败时重新下载。
 */
import { sha256Hex } from '../utils/sha256';
import type { GameManifest, ThirdPartyFile } from '../games/manifest';

const THIRD_PARTY_DB = 'ra2-vm-third-party-files';
const THIRD_PARTY_STORE = 'files';
// 预加载、导入和恢复缓存共用同一下载；哈希也是键的一部分，不能复用旧版本。
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
    // 开发时优先使用磁盘缓存，仍校验同一份 manifest；仅缺失才回退 CDN/浏览器缓存。
    // DEV 分支由生产构建消除，不向线上用户请求开发端点。
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
    // 禁用 IndexedDB/存储配额不足不应阻止游戏启动，仍保留本页面内存缓存。
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
    // 后台预加载失败只影响本次请求；用户稍后启动时允许重新尝试。
    thirdPartyLoads.delete(key);
    throw error;
  });
  thirdPartyLoads.set(key, pending);
  return pending;
}

/** 页面进入时并行预热两款游戏；失败不阻断页面初始化，启动时仍会重试和报错。 */
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
      // VM 会修改或 transfer EXE；每个调用者拿独立副本，不能损坏预加载缓存。
      files.set(thirdParty.name, bytes.slice());
      onStatus?.(`已加载 ${thirdParty.name}`);
    }),
  );
  return files;
}
