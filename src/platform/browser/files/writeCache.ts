import { normalizeGuestPath } from '../../../vm86/paths';

/**
 * IndexedDB 写入缓存：只读来源（开发服务器、内存 ZIP/安装包）上的存档/写回持久化层。
 * IndexedDB 中通常只有少量存档，而 RA2 载入关卡时会探测数千个 MIX 内素材名：
 * 先缓存一次 key 集合，缺失素材就不再各自创建一次异步 IDB transaction。
 */
export class IndexedDbWriteCache {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private persistedKeysPromise: Promise<Set<string>> | null = null;
  private persistedKeysSnapshot: Set<string> | null = null;
  private generation = 0;

  invalidate(): void {
    this.generation++;
    this.persistedKeysPromise = null;
    this.persistedKeysSnapshot = null;
  }

  /** 同步判定（key 尚未枚举完成时返回 null），供 hasKnownFile 免 await 拒绝缺失文件。 */
  hasKnownKey(path: string): boolean | null {
    if (!this.persistedKeysSnapshot) return null;
    return this.persistedKeysSnapshot.has(path);
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (!(await this.keys()).has(path)) return null;
    const database = await this.database();
    if (!database) return null;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const request = database.transaction(DEVELOPMENT_FILE_STORE).objectStore(DEVELOPMENT_FILE_STORE).get(path);
      request.onsuccess = () => {
        const value = request.result as ArrayBuffer | Uint8Array | undefined;
        // get 已通过 IndexedDB 的结构化克隆取得独占副本；再次复制会让大存档
        // 在交给文件端口前多占一份内存。保留旧 Uint8Array 记录的视图边界。
        resolve(value === undefined ? null : value instanceof Uint8Array ? value : new Uint8Array(value));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const database = await this.database();
    if (!database) return;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVELOPMENT_FILE_STORE, 'readwrite');
      // 请求成功不代表事务已提交；配额不足或随后中止都必须让保存失败。
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new DOMException('保存事务已中止', 'AbortError'));
      transaction.onerror = () => reject(transaction.error ?? new Error('保存事务失败'));
      const request = transaction.objectStore(DEVELOPMENT_FILE_STORE).put(buffer, path);
      request.onerror = () => reject(request.error);
    });
    (await this.keys()).add(path);
  }

  keys(): Promise<Set<string>> {
    if (this.persistedKeysPromise) return this.persistedKeysPromise;
    const generation = this.generation;
    const request = (async () => {
      const database = await this.database();
      if (!database) return new Set<string>();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction(DEVELOPMENT_FILE_STORE).objectStore(DEVELOPMENT_FILE_STORE).getAllKeys();
        request.onsuccess = () => resolve(request.result as IDBValidKey[]);
        request.onerror = () => reject(request.error);
      });
      return new Set(keys.map((key) => normalizeGuestPath(String(key))));
    })();
    this.persistedKeysPromise = request;
    void request.then(
      (keys) => {
        if (generation === this.generation) this.persistedKeysSnapshot = keys;
      },
      () => {},
    );
    return request;
  }

  private async database(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    this.databasePromise ??= openDevelopmentDatabase();
    return this.databasePromise;
  }
}

const DEVELOPMENT_FILE_DB = 'ra2-vm-development-files';
const DEVELOPMENT_FILE_STORE = 'files';

function openDevelopmentDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVELOPMENT_FILE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DEVELOPMENT_FILE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
