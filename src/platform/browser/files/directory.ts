import type { GameFileProvider } from '../../../resources/contracts';
import { normalizeGuestPath } from '../../../vm86/paths';

// 当前 DOM 类型库未声明异步目录枚举，仅补充实际使用的 entries。
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** 用户授权的真实游戏目录；大小写无关读取，写操作串行落盘。 */
export class DirectoryGameFileProvider implements GameFileProvider {
  readonly label: string;
  private writeChain: Promise<void> = Promise.resolve();
  /** 写入尚未落盘时的快照优先于磁盘读取（避免 save 后立即 load 被异步 close 卡住）。
   *  落盘完成即移除：此后读盘即最新内容，Windows 端在会话中覆盖的存档下次打开可见。 */
  private readonly writeSnapshots = new Map<string, Uint8Array>();
  /** File System Access 的 entries() 在大目录上很贵，每个目录只建一次大小写无关索引。 */
  private entryIndexes = new WeakMap<
    FileSystemDirectoryHandle,
    Promise<Map<string, { name: string; handle: FileSystemHandle }>>
  >();

  constructor(readonly handle: FileSystemDirectoryHandle) {
    this.label = handle.name;
  }

  invalidateCache(): void {
    this.entryIndexes = new WeakMap();
  }

  async read(path: string): Promise<Uint8Array | null> {
    const normalized = normalizeGuestPath(path);
    const snapshot = this.writeSnapshots.get(normalized);
    if (snapshot) return snapshot.slice();
    const parts = splitGuestPath(path);
    if (!parts.length) return null;
    const parent = await this.resolveDirectory(parts.slice(0, -1), false);
    if (!parent) return null;
    const file = await this.findChild(parent, parts.at(-1)!, 'file');
    if (!file || file.kind !== 'file') return null;
    const blob = await (file as FileSystemFileHandle).getFile();
    return new Uint8Array(await blob.arrayBuffer());
  }

  async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    const normalized = normalizeGuestPath(path);
    const snapshot = this.writeSnapshots.get(normalized);
    if (snapshot) return { bytes: snapshot.slice(0, maxBytes), totalSize: snapshot.length };
    const parts = splitGuestPath(path);
    if (!parts.length) return null;
    const parent = await this.resolveDirectory(parts.slice(0, -1), false);
    if (!parent) return null;
    const file = await this.findChild(parent, parts.at(-1)!, 'file');
    if (!file || file.kind !== 'file') return null;
    const blob = await (file as FileSystemFileHandle).getFile();
    return {
      bytes: new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer()),
      totalSize: blob.size,
    };
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const normalized = normalizeGuestPath(path);
    const snapshot = this.writeSnapshots.get(normalized);
    if (snapshot) return snapshot.slice(offset, offset + length);
    const parts = splitGuestPath(path);
    if (!parts.length) return null;
    const parent = await this.resolveDirectory(parts.slice(0, -1), false);
    if (!parent) return null;
    const file = await this.findChild(parent, parts.at(-1)!, 'file');
    if (!file || file.kind !== 'file') return null;
    const blob = await (file as FileSystemFileHandle).getFile();
    return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeGuestPath(path);
    if (!normalized) return Promise.reject(new Error('拒绝写入空游戏路径'));
    const snapshot = bytes.slice();
    this.writeSnapshots.set(normalized, snapshot);
    const operation = this.writeChain.then(() => this.writeNow(path, snapshot));
    this.writeChain = operation.catch(() => {
      if (this.writeSnapshots.get(normalized) === snapshot) this.writeSnapshots.delete(normalized);
      // 保持后续存档写入可以继续排队；调用方仍会收到 operation 的原始 reject。
    });
    void operation.then(
      () => {
        // 落盘完成：磁盘已是最新内容，撤掉快照让后续读取（包括 Windows 端的外部
        // 覆盖）直接走 getFile()。身份比较防止误删更新一次写入的快照。
        if (this.writeSnapshots.get(normalized) === snapshot) this.writeSnapshots.delete(normalized);
      },
      () => {},
    );
    return operation;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async list(directory: string): Promise<string[] | null> {
    const handle = directory ? await this.resolveDirectory(splitGuestPath(directory), false) : this.handle;
    if (!handle) return null;
    const index = await this.directoryIndex(handle);
    return [...index.values()].map((entry) => entry.name);
  }

  private async writeNow(path: string, bytes: Uint8Array): Promise<void> {
    const parts = splitGuestPath(path);
    if (!parts.length) throw new Error('拒绝写入空游戏路径');
    const parent = await this.resolveDirectory(parts.slice(0, -1), true);
    if (!parent) throw new Error(`无法创建目录: ${path}`);
    const requestedName = parts.at(-1)!;
    const existing = await this.findChild(parent, requestedName, 'file');
    const file =
      existing?.kind === 'file'
        ? (existing as FileSystemFileHandle)
        : await parent.getFileHandle(requestedName, { create: true });
    if (!existing) await this.rememberChild(parent, requestedName, file);
    const writable = await file.createWritable();
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await writable.write(buffer);
    } finally {
      await writable.close();
    }
  }

  private async resolveDirectory(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let directory = this.handle;
    for (const part of parts) {
      const existing = await this.findChild(directory, part, 'directory');
      if (existing?.kind === 'directory') {
        directory = existing as FileSystemDirectoryHandle;
      } else if (create) {
        const parent = directory;
        directory = await parent.getDirectoryHandle(part, { create: true });
        await this.rememberChild(parent, part, directory);
      } else {
        return null;
      }
    }
    return directory;
  }

  private async findChild(
    directory: FileSystemDirectoryHandle,
    wantedName: string,
    wantedKind: FileSystemHandleKind,
  ): Promise<FileSystemHandle | null> {
    const handle = (await this.directoryIndex(directory)).get(wantedName.toLowerCase())?.handle;
    return handle?.kind === wantedKind ? handle : null;
  }

  private directoryIndex(
    directory: FileSystemDirectoryHandle,
  ): Promise<Map<string, { name: string; handle: FileSystemHandle }>> {
    const cached = this.entryIndexes.get(directory);
    if (cached) return cached;
    const pending = (async () => {
      const result = new Map<string, { name: string; handle: FileSystemHandle }>();
      for await (const [name, handle] of (directory as IterableDirectoryHandle).entries()) {
        result.set(name.toLowerCase(), { name, handle });
      }
      return result;
    })();
    this.entryIndexes.set(directory, pending);
    void pending.catch(() => this.entryIndexes.delete(directory));
    return pending;
  }

  private async rememberChild(
    directory: FileSystemDirectoryHandle,
    name: string,
    handle: FileSystemHandle,
  ): Promise<void> {
    (await this.directoryIndex(directory)).set(name.toLowerCase(), { name, handle });
  }
}

function splitGuestPath(path: string): string[] {
  const normalized = normalizeGuestPath(path);
  return normalized.split('/').filter(Boolean);
}
