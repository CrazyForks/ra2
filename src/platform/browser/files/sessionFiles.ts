import { normalizeGuestPath } from '../../../vm86/paths';
import { MemoryGameFileProvider } from '../../../resources/providers/memory';
import { IndexedDbWriteCache } from './writeCache';

/**
 * 会话级内存包 provider：解包产物免拷贝持有，读访问按需 slice；
 * 写档落到浏览器 IndexedDB（与开发后端同库），刷新页面后仍可恢复。
 */
export class SessionGameFileProvider extends MemoryGameFileProvider {
  /** 每款游戏包内目录结构不固定：发现流程递归枚举所有子目录。 */
  readonly deepDiscovery = true;
  private readonly writeCache = new IndexedDbWriteCache();

  constructor(label: string, files: ReadonlyMap<string, Uint8Array>) {
    super(files, false, label);
  }

  invalidateCache(): void {
    this.writeCache.invalidate();
  }

  hasKnownFile(path: string): boolean | null {
    const normalized = normalizeGuestPath(path);
    if (this.files.has(normalized)) return true;
    return this.writeCache.hasKnownKey(normalized);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const normalized = normalizeGuestPath(path);
    const inMemory = this.files.get(normalized);
    if (inMemory) return inMemory.slice();
    return this.writeCache.read(normalized);
  }

  override async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    // 内存中的大包只复制所需区间；持久化回退与 read 使用同一优先级。
    const bytes = this.files.get(normalizeGuestPath(path)) ?? (await this.writeCache.read(normalizeGuestPath(path)));
    return bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null;
  }

  override async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const bytes = this.files.get(normalizeGuestPath(path)) ?? (await this.writeCache.read(normalizeGuestPath(path)));
    return bytes?.slice(offset, offset + length) ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeGuestPath(path);
    if (!normalized) throw new Error('拒绝写入空游戏路径');
    await super.write(path, bytes);
    await this.writeCache.write(normalized, bytes);
  }

  async list(directory: string): Promise<string[] | null> {
    const base = await super.list(directory);
    const prefix = normalizeGuestPath(directory);
    const extra = new Set<string>();
    for (const key of await this.writeCache.keys()) {
      if (prefix && !key.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      if (rest) extra.add(rest.split('/')[0]!);
    }
    if (!extra.size) return base;
    return [...new Set([...(base ?? []), ...extra])];
  }
}
