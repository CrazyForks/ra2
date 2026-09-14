/**
 * 玩家导入游戏文件的浏览器持久化：清单集齐（必需文件齐全）后把会话级文件集
 * 写入 IndexedDB（ra2-vm-game-files），下次打开页面自动恢复、免重复选择。
 *
 * 主程序（game.exe / gamemd.exe）由 thirdPartyFiles.ts 单独持久化，这里只存
 * 玩家侧文件。配额不足时退化为只存必需文件（启动所需），可选包下次仍缺。
 */

import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { normalizeGuestPath } from '../vm86/paths';

const DB_NAME = 'ra2-vm-game-files';
const STORE = 'files';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function keyOf(gameId: string, name: string): string {
  return `${gameId}/${name.toLowerCase()}`;
}

/** 附加包独立保存，不因游戏本体重新导入而丢失；失败必须让前端显示，不能假称已保存。 */
export async function saveCustomMapFiles(gameId: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await writeGameFiles(`custom-${gameId}`, files);
}

export async function loadCustomMapFiles(gameId: string): Promise<Map<string, Uint8Array>> {
  return (await loadCachedGameFiles(`custom-${gameId}`)) ?? new Map();
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || (error.name === 'UnknownError' && /quota|storage/i.test(error.message)))
  );
}

async function writeGameFiles(gameId: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    // 先清掉该游戏旧记录，再逐文件写入（新文件集整体替换旧集）。
    await new Promise<void>((resolve, reject) => {
      const clear = store.delete(IDBKeyRange.bound(`${gameId}/`, `${gameId}/￿`));
      clear.onsuccess = () => resolve();
      clear.onerror = () => reject(clear.error);
    });
    for (const [name, bytes] of files) {
      // 空文件也属于资源集：RA2 轻量包用零字节 MIX 表示存在但无影片内容。
      // 丢掉它会把文件探测从“存在”变成 ENOENT，刷新后可能 ExitProcess(0)。
      // Blob 在 IndexedDB 中可按片读取，恢复影片包时不先把整包复制进 JS 堆。
      store.put(new Blob([bytes as BlobPart]), keyOf(gameId, name));
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/**
 * 保存导入的游戏文件集。配额不足且给了必需文件清单时，退化为只存必需文件
 * （控制台提示）；仍失败则放弃持久化，本次会话不受影响。
 */
export async function saveCachedGameFiles(
  gameId: string,
  files: ReadonlyMap<string, Uint8Array>,
  requiredFiles: readonly string[] = [],
): Promise<void> {
  try {
    await writeGameFiles(gameId, files);
  } catch (error) {
    if (!isQuotaError(error)) {
      console.warn('[游戏文件] 持久化导入文件失败', error);
      return;
    }
    const required = new Map<string, Uint8Array>();
    for (const name of requiredFiles) {
      for (const [candidate, bytes] of files) {
        if (candidate.toLowerCase() === name.toLowerCase()) {
          required.set(candidate, bytes);
          break;
        }
      }
    }
    if (!required.size) {
      console.warn('[游戏文件] 存储配额不足：本次资源未缓存，保留原缓存；刷新后可能需要重新选择资源。', error);
      return;
    }
    try {
      await writeGameFiles(gameId, required);
      console.warn('[游戏文件] 存储配额不足：仅持久化必需文件');
    } catch (secondError) {
      console.warn('[游戏文件] 持久化导入文件失败', secondError);
    }
  }
}

/** 读取某游戏已持久化的文件集（键为小写文件名）；无记录返回 null。 */
export async function loadCachedGameFiles(gameId: string): Promise<Map<string, Uint8Array> | null> {
  const database = await openDatabase();
  try {
    const prefix = `${gameId}/`;
    const files = new Map<string, Uint8Array>();
    const blobs: Array<Promise<void>> = [];
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE)
        .objectStore(STORE)
        .openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const name = (cursor.key as string).slice(prefix.length);
        const bytes = cursor.value as Uint8Array | Blob;
        // 与保存对称，不能用 length 的真值判断记录存在性。
        if (bytes instanceof Uint8Array) files.set(name, bytes);
        if (bytes instanceof Blob)
          blobs.push(
            bytes.arrayBuffer().then((buffer) => {
              files.set(name, new Uint8Array(buffer));
            }),
          );
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await Promise.all(blobs);
    return files.size ? files : null;
  } finally {
    database.close();
  }
}

/** 只恢复目录；正文首次读取才取得 Blob。旧 Uint8Array 记录按文件兼容，不要求重导入。 */
export async function restoreCachedFileProvider(gameId: string): Promise<CachedGameFileProvider | null> {
  const database = await openDatabase();
  try {
    const prefix = `${gameId}/`;
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database
        .transaction(STORE)
        .objectStore(STORE)
        .getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = keys.map((key) => String(key).slice(prefix.length));
    return names.length ? new CachedGameFileProvider(gameId, names) : null;
  } finally {
    database.close();
  }
}

export class CachedGameFileProvider extends SessionGameFileProvider {
  private readonly names: Set<string>;
  private readonly blobs = new Map<string, Promise<Blob | null>>();
  constructor(
    private readonly gameId: string,
    names: string[],
  ) {
    super('本地缓存', new Map());
    this.names = new Set(names.map(normalizeGuestPath));
  }
  override hasKnownFile(path: string): boolean | null {
    return this.names.has(normalizeGuestPath(path)) || super.hasKnownFile(path);
  }
  private blob(path: string): Promise<Blob | null> {
    const name = normalizeGuestPath(path);
    if (!this.names.has(name)) return Promise.resolve(null);
    let pending = this.blobs.get(name);
    if (!pending) {
      pending = (async () => {
        const database = await openDatabase();
        try {
          return await new Promise<Blob | null>((resolve, reject) => {
            const request = database.transaction(STORE).objectStore(STORE).get(keyOf(this.gameId, name));
            request.onsuccess = () => {
              const value: unknown = request.result;
              resolve(
                value instanceof Blob ? value : value instanceof Uint8Array ? new Blob([value as BlobPart]) : null,
              );
            };
            request.onerror = () => reject(request.error);
          });
        } finally {
          database.close();
        }
      })();
      this.blobs.set(name, pending);
      // 只保留少量 Blob 句柄；失败可重试，不永久缓存拒绝的 Promise。
      if (this.blobs.size > 8) this.blobs.delete(this.blobs.keys().next().value!);
      void pending.catch(() => {
        if (this.blobs.get(name) === pending) this.blobs.delete(name);
      });
    }
    return pending;
  }
  override async read(path: string): Promise<Uint8Array | null> {
    if (this.files.has(normalizeGuestPath(path))) return super.read(path);
    const blob = await this.blob(path);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : super.read(path);
  }
  override async readPrefix(path: string, length: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    if (this.files.has(normalizeGuestPath(path))) return super.readPrefix(path, length);
    const blob = await this.blob(path);
    if (blob) return { bytes: new Uint8Array(await blob.slice(0, length).arrayBuffer()), totalSize: blob.size };
    const bytes = await super.read(path);
    return bytes ? { bytes: bytes.slice(0, length), totalSize: bytes.length } : null;
  }
  override async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    if (this.files.has(normalizeGuestPath(path))) return super.readRange(path, offset, length);
    const blob = await this.blob(path);
    return blob
      ? new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
      : ((await super.read(path))?.slice(offset, offset + length) ?? null);
  }
  override async list(directory: string): Promise<string[]> {
    const prefix = normalizeGuestPath(directory);
    const entries = new Set(await super.list(directory));
    for (const name of this.names) {
      if (prefix && !name.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? name.slice(prefix.length + 1) : name;
      if (rest) entries.add(rest.split('/')[0]!);
    }
    return [...entries];
  }
}

/** 清空全部持久化文件集（换源时调用：回到选择面板而非自动恢复）。 */
export async function clearCachedGameFiles(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
