import type { GameFileProvider } from '../contracts';
import { normalizeGuestPath } from '../../vm86/paths';

/** 用内存文件覆盖底层 provider 的读取；写入/落盘仍走底层。 */
export class OverlayGameFileProvider implements GameFileProvider {
  readonly label: string;
  private readonly overlay: ReadonlyMap<string, Uint8Array>;

  constructor(
    readonly parent: GameFileProvider,
    files: ReadonlyMap<string, Uint8Array>,
    labelSuffix: string,
    /** overlay 命中的文件写入只在客体会话内视为成功，不下沉到真实目录。 */
    private readonly shadowOverlayWrites = false,
    /** copy=false 时直接持有传入字节（调用方保证之后不再改动）。 */
    copy = true,
    /** 底层优先：先读底层（玩家自己的完整安装，如中文资源），缺失时再用
     *  覆盖层（在线包）补齐。默认 false=覆盖层优先。写入不受影响，始终走底层。 */
    private readonly parentFirst = false,
  ) {
    const normalized = new Map<string, Uint8Array>();
    for (const [path, bytes] of files) normalized.set(normalizeGuestPath(path), copy ? bytes.slice() : bytes);
    this.overlay = normalized;
    this.label = `${parent.label}${labelSuffix}`;
  }

  /** 本层覆盖文件（已归一化路径）；供 worker init 消息序列化用。 */
  get overlays(): ReadonlyMap<string, Uint8Array> {
    return this.overlay;
  }

  invalidateCache(): void {
    this.parent.invalidateCache?.();
  }

  hasKnownFile(path: string): boolean | null {
    const normalized = normalizeGuestPath(path);
    if (this.parentFirst) {
      const base = this.parent.hasKnownFile?.(path);
      if (base === true) return true;
      return this.overlay.has(normalized) ? true : (base ?? null);
    }
    if (this.overlay.has(normalized)) return true;
    return this.parent.hasKnownFile?.(path) ?? null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (this.parentFirst) {
      const base = await this.parent.read(path);
      if (base) return base;
      return this.overlay.get(normalizeGuestPath(path))?.slice() ?? null;
    }
    const hit = this.overlay.get(normalizeGuestPath(path));
    if (hit) return hit.slice();
    return this.parent.read(path);
  }

  async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    if (this.parentFirst) {
      const base = this.parent.readPrefix
        ? await this.parent.readPrefix(path, maxBytes)
        : await this.parent
            .read(path)
            .then((bytes) => (bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null));
      if (base) return base;
      const hit = this.overlay.get(normalizeGuestPath(path));
      return hit ? { bytes: hit.slice(0, maxBytes), totalSize: hit.length } : null;
    }
    const hit = this.overlay.get(normalizeGuestPath(path));
    if (hit) return { bytes: hit.slice(0, maxBytes), totalSize: hit.length };
    if (this.parent.readPrefix) return this.parent.readPrefix(path, maxBytes);
    const bytes = await this.parent.read(path);
    return bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null;
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    if (this.parentFirst) {
      const base = this.parent.readRange
        ? await this.parent.readRange(path, offset, length)
        : await this.parent.read(path).then((bytes) => bytes?.slice(offset, offset + length) ?? null);
      if (base) return base;
      const hit = this.overlay.get(normalizeGuestPath(path));
      return hit?.slice(offset, offset + length) ?? null;
    }
    const hit = this.overlay.get(normalizeGuestPath(path));
    if (hit) return hit.slice(offset, offset + length);
    if (this.parent.readRange) return this.parent.readRange(path, offset, length);
    const bytes = await this.parent.read(path);
    return bytes?.slice(offset, offset + length) ?? null;
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    if (this.shadowOverlayWrites && this.overlay.has(normalizeGuestPath(path))) return Promise.resolve();
    return this.parent.write(path, bytes);
  }

  flush(): Promise<void> {
    return this.parent.flush();
  }

  async list(directory: string): Promise<string[] | null> {
    const base = await this.parent.list(directory);
    const prefix = normalizeGuestPath(directory);
    const depth = prefix ? prefix.split('/').length : 0;
    const overlayNames = new Set<string>();
    for (const path of this.overlay.keys()) {
      const parts = path.split('/');
      if (parts.length <= depth) continue;
      const parentPath = parts.slice(0, depth).join('/');
      if (depth ? parentPath === prefix : true) overlayNames.add(parts[depth]!);
    }
    if (!overlayNames.size) return base;
    return [...new Set([...(base ?? []), ...overlayNames])];
  }
}
