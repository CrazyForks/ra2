import type { GameFileProvider } from '../contracts';
import { normalizeGuestPath } from '../../vm86/paths';

/** Node/浏览器单元测试均可使用的可写内存文件后端。 */
export class MemoryGameFileProvider implements GameFileProvider {
  readonly label: string;
  readonly files = new Map<string, Uint8Array>();

  /** copy=false 时直接持有传入字节（调用方保证之后不再改动），
   *  ZIP/安装包解压结果用它避免整包在 JS 堆里多复制一份。 */
  constructor(files: ReadonlyMap<string, Uint8Array> = new Map(), copy = true, label = '内存测试目录') {
    this.label = label;
    for (const [path, bytes] of files) this.files.set(normalizeGuestPath(path), copy ? bytes.slice() : bytes);
  }

  hasKnownFile(path: string): boolean | null {
    return this.files.has(normalizeGuestPath(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(normalizeGuestPath(path))?.slice() ?? null;
  }

  async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    const bytes = this.files.get(normalizeGuestPath(path));
    return bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null;
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return this.files.get(normalizeGuestPath(path))?.slice(offset, offset + length) ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(normalizeGuestPath(path), bytes.slice());
  }

  async flush(): Promise<void> {}

  async list(directory: string): Promise<string[] | null> {
    const prefix = normalizeGuestPath(directory);
    const depth = prefix ? prefix.split('/').length : 0;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      const parts = path.split('/');
      if (parts.length <= depth) continue;
      const parent = parts.slice(0, depth).join('/');
      if (depth ? parent === prefix : true) names.add(parts[depth]!);
    }
    return [...names];
  }
}
