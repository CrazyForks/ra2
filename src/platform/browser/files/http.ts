import type { GameFileProvider } from '../../../resources/contracts';
import { normalizeGuestPath } from '../../../vm86/paths';
import { IndexedDbWriteCache } from './writeCache';

type FilePrefix = { bytes: Uint8Array; totalSize: number };
const PREFIX_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const PREFIX_CACHE_MAX_ENTRIES = 4096;
const PREFIX_CACHE_MAX_ENTRY_BYTES = 64 * 1024;

const HTTP_FETCH_RETRY_DELAYS_MS = [0, 100, 300] as const;

/** 瞬时网络失败不能直接中断 VM 的 CreateFile；真实 HTTP 状态码仍由调用者处理。 */
export async function fetchGameResource(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (const delay of HTTP_FETCH_RETRY_DELAYS_MS) {
    if (delay) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delay));
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Vite 本地开发后端（URL 根 /game/）；原版资源只读，存档等写入保存到浏览器 IndexedDB。 */
export class HttpGameFileProvider implements GameFileProvider {
  /** 不支持 Range 的服务器只接收一次完整 Blob；只留最近一个，避免多个大包常驻。 */
  private rangeFallback: { path: string; blob: Blob } | null = null;
  readonly label = '开发版资源';
  // FindFirstFile 反复读取 1 字节以取得文件长度；避免每轮枚举都发起 Range 请求。
  private readonly prefixes = new Map<string, FilePrefix>();
  private prefixBytes = 0;
  private readonly pendingPrefixes = new Map<string, { length: number; request: Promise<FilePrefix | null> }>();
  private readonly writes = new Map<string, Uint8Array>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly directoryListings = new Map<string, Promise<string[] | null>>();
  private readonly directoryListingValues = new Map<string, string[] | null>();
  private cacheGeneration = 0;
  private readonly writeCache = new IndexedDbWriteCache();

  invalidateCache(): void {
    this.rangeFallback = null;
    this.prefixes.clear();
    this.prefixBytes = 0;
    this.pendingPrefixes.clear();
    this.cacheGeneration++;
    this.directoryListings.clear();
    this.directoryListingValues.clear();
    this.writeCache.invalidate();
  }

  hasKnownFile(path: string): boolean | null {
    const normalized = normalizeGuestPath(path);
    if (this.writes.has(normalized)) return true;
    const persisted = this.writeCache.hasKnownKey(normalized);
    if (persisted) return true;
    // 持久化 key 尚未枚举完成时不能把 IndexedDB 中的同名文件误判为缺失。
    if (persisted === null) return null;
    const slash = normalized.lastIndexOf('/');
    const directory = slash < 0 ? '' : normalized.slice(0, slash);
    const name = slash < 0 ? normalized : normalized.slice(slash + 1);
    if (!this.directoryListingValues.has(directory)) return null;
    const listing = this.directoryListingValues.get(directory);
    if (!listing) return null;
    return listing.some((entry) => entry.toLowerCase() === name.toLowerCase());
  }

  async read(path: string): Promise<Uint8Array | null> {
    const normalized = normalizeGuestPath(path);
    const written = this.writes.get(normalized);
    if (written) return written.slice();
    const persisted = await this.writeCache.read(normalized);
    if (persisted) return persisted;
    // RA2 asks CreateFile for thousands of names that actually live inside a
    // MIX archive. Fetching every loose-name probe and waiting for its 404 made
    // startup network-bound. The development server already exposes directory
    // listings, so one manifest lookup can reject absent files locally.
    const slash = normalized.lastIndexOf('/');
    const directory = slash < 0 ? '' : normalized.slice(0, slash);
    const name = slash < 0 ? normalized : normalized.slice(slash + 1);
    const listing = await this.readDirectoryListing(directory);
    if (listing && !listing.some((entry) => entry.toLowerCase() === name.toLowerCase())) return null;
    const url = gameFileUrl(normalized);
    if (!url) return null;
    const response = await fetchGameResource(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readPrefix(path: string, maxBytes: number): Promise<FilePrefix | null> {
    const normalized = normalizeGuestPath(path);
    const local = this.writes.get(normalized) ?? (await this.writeCache.read(normalized));
    if (local) return { bytes: local.slice(0, maxBytes), totalSize: local.length };
    const cached = this.prefixes.get(normalized);
    if (cached && cached.bytes.length >= Math.min(maxBytes, cached.totalSize)) {
      this.prefixes.delete(normalized);
      this.prefixes.set(normalized, cached);
      return { bytes: cached.bytes.slice(0, maxBytes), totalSize: cached.totalSize };
    }
    if (this.rangeFallback?.path === normalized) {
      const blob = this.rangeFallback.blob;
      return { bytes: new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer()), totalSize: blob.size };
    }
    const pending = this.pendingPrefixes.get(normalized);
    if (pending && pending.length >= maxBytes) {
      const result = await pending.request;
      return result ? { bytes: result.bytes.slice(0, maxBytes), totalSize: result.totalSize } : null;
    }
    const generation = this.cacheGeneration;
    const entry = { length: maxBytes, request: this.readHttpPrefix(normalized, maxBytes, generation) };
    this.pendingPrefixes.set(normalized, entry);
    try {
      const result = await entry.request;
      if (result && generation === this.cacheGeneration && !this.writes.has(normalized)) {
        this.rememberPrefix(normalized, result);
      }
      // 不把缓存或共享 Promise 的缓冲交给调用者修改或 transfer。
      return result ? { bytes: result.bytes.slice(), totalSize: result.totalSize } : null;
    } finally {
      if (this.pendingPrefixes.get(normalized) === entry) this.pendingPrefixes.delete(normalized);
    }
  }

  private rememberPrefix(path: string, value: FilePrefix): void {
    if (value.bytes.length > PREFIX_CACHE_MAX_ENTRY_BYTES) return;
    const previous = this.prefixes.get(path);
    if (previous && previous.bytes.length > value.bytes.length) return;
    if (previous) {
      this.prefixBytes -= previous.bytes.length;
      this.prefixes.delete(path);
    }
    this.prefixes.set(path, value);
    this.prefixBytes += value.bytes.length;
    while (this.prefixBytes > PREFIX_CACHE_MAX_BYTES || this.prefixes.size > PREFIX_CACHE_MAX_ENTRIES) {
      const first = this.prefixes.keys().next().value!;
      this.prefixBytes -= this.prefixes.get(first)!.bytes.length;
      this.prefixes.delete(first);
    }
  }

  private async readHttpPrefix(normalized: string, maxBytes: number, generation: number): Promise<FilePrefix | null> {
    const url = gameFileUrl(normalized);
    if (!url) return null;
    const response = await fetchGameResource(url, { headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    if (response.status === 200) {
      const blob = await response.blob();
      if (generation === this.cacheGeneration && !this.writes.has(normalized))
        this.rangeFallback = { path: normalized, blob };
      return { bytes: new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer()), totalSize: blob.size };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const range = response.headers.get('Content-Range');
    const totalSize = range
      ? Number(range.slice(range.lastIndexOf('/') + 1))
      : Number(response.headers.get('Content-Length') ?? bytes.length);
    return { bytes: bytes.slice(0, maxBytes), totalSize: Number.isFinite(totalSize) ? totalSize : bytes.length };
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const normalized = normalizeGuestPath(path);
    const local = this.writes.get(normalized) ?? (await this.writeCache.read(normalized));
    if (local) return local.slice(offset, offset + length);
    if (this.rangeFallback?.path === normalized) {
      return new Uint8Array(await this.rangeFallback.blob.slice(offset, offset + length).arrayBuffer());
    }
    const url = gameFileUrl(normalized);
    if (!url) return null;
    const end = Math.max(offset, offset + Math.max(0, length) - 1);
    const response = await fetchGameResource(url, { headers: { Range: `bytes=${offset}-${end}` } });
    if (response.status === 404 || response.status === 416) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    if (response.status === 200) {
      const blob = await response.blob();
      this.rangeFallback = { path: normalized, blob };
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // 支持 Range 的开发服务器返回 206；普通静态服务器若忽略 Range 返回 200，
    // 仍只把所需切片交给 VM，避免在客体文件层再保留整个影片包。
    return response.status === 206 ? bytes : bytes.slice(offset, offset + length);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeGuestPath(path);
    if (!normalized) throw new Error('拒绝写入空游戏路径');
    const snapshot = bytes.slice();
    this.writes.set(normalized, snapshot);
    const prefix = this.prefixes.get(normalized);
    if (prefix) {
      this.prefixBytes -= prefix.bytes.length;
      this.prefixes.delete(normalized);
    }
    this.pendingPrefixes.delete(normalized);
    if (this.rangeFallback?.path === normalized) this.rangeFallback = null;
    const operation = this.writeCache.write(normalized, snapshot);
    this.pendingWrites.add(operation);
    try {
      await operation;
    } finally {
      this.pendingWrites.delete(operation);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pendingWrites]);
  }

  async list(directory: string): Promise<string[] | null> {
    const normalized = normalizeGuestPath(directory);
    const listing = await this.readDirectoryListing(normalized);
    // 存档等写入保存在 IndexedDB 而不落盘：合并进来，否则 list（导出存档的
    // 枚举路径）看不到它们，跨浏览器传输会导出残包。
    const prefix = normalized ? `${normalized}/` : '';
    const extra = new Set<string>();
    const absorb = (key: string): void => {
      if (!key.startsWith(prefix)) return;
      const rest = key.slice(prefix.length);
      if (rest.includes('/') || !rest) return;
      extra.add(rest);
    };
    for (const key of this.writes.keys()) absorb(key);
    for (const key of await this.writeCache.keys()) absorb(key);
    if (extra.size === 0) return listing?.slice() ?? [];
    return [...new Set([...(listing ?? []), ...extra])];
  }

  private readDirectoryListing(directory: string): Promise<string[] | null> {
    const cached = this.directoryListings.get(directory);
    if (cached) return cached;
    const generation = this.cacheGeneration;
    const url = `/game/.list${directory ? `?dir=${encodeURIComponent(directory)}` : ''}`;
    const request = fetchGameResource(url)
      .then(async (response) => {
        // 清单端点的 404 表示目录确定不存在（RA2 常先探测虚拟的 @:/ 路径），
        // 与网络/端点不可用不同。缓存为空清单后可同步拒绝该目录下所有 loose 文件。
        if (response.status === 404) return [];
        if (!response.ok) return null;
        return response.json() as Promise<string[]>;
      })
      .catch(() => null)
      .then((listing) => {
        if (generation === this.cacheGeneration) this.directoryListingValues.set(directory, listing);
        return listing;
      });
    this.directoryListings.set(directory, request);
    return request;
  }
}

function gameFileUrl(normalizedPath: string): string | null {
  const parts = normalizedPath.split('/').filter(Boolean);
  return parts.length ? `/game/${parts.map(encodeURIComponent).join('/')}` : null;
}
