/**
 * 文件层独立回环测试（原 fileSystemSmoke 迁移）。
 *
 * 不启动 v86，也不点击任何关卡：只验证
 *   1. Win32Shim 的句柄、偏移和小块读写；
 *   2. File System Access 后端的串行写入与“写后立即读”；
 *   3. /game 开发后端的 IndexedDB 跨实例持久化；
 *   4. VirtualAlloc 保留区与堆 arena 互斥。
 *
 * 这样地图加载失败时，可以先确认文件字节没有在浏览器/Win32 边界被改坏。
 */
import { describe, expect, it } from 'vitest';
import { DirectoryGameFileProvider } from '../../src/platform/browser/files/directory';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { ScopedGameFileProvider } from '../../src/resources/providers/scoped';
import { listSavePaths } from '../../src/adapter/saveTransfer';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

function expectBytes(actual: Uint8Array | null, expected: Uint8Array, label: string): void {
  expect(actual, `${label}: 应读到文件`).toBeTruthy();
  expect(actual ? [...actual] : null, `${label}: 文件字节不一致`).toEqual([...expected]);
}

/* ------------------------------------------------------------------------- *
 * IndexedDB fake: 只实现 HttpGameFileProvider 用到的 open/create/get/put/getAllKeys。
 * 每次脚本运行都是新的数据库；同一数据库名的不同 provider 共享 store。
 * ------------------------------------------------------------------------- */

type FakeRequest<T = unknown> = {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
};

type FakeDatabase = {
  stores: Map<string, Map<string, ArrayBuffer>>;
  createObjectStore(name: string): void;
  transaction(
    name: string,
    mode?: 'readonly' | 'readwrite',
  ): {
    oncomplete?: () => void;
    objectStore(storeName: string): {
      get(key: string): FakeRequest<ArrayBuffer | undefined>;
      put(value: ArrayBuffer, key: string): FakeRequest<void>;
      getAllKeys(): FakeRequest<IDBValidKey[]>;
    };
  };
};

function asyncRequest<T>(result: T): FakeRequest<T> {
  return { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
}

function installFakeIndexedDb(): { getCalls: number; getAllKeysCalls: number } {
  const metrics = { getCalls: 0, getAllKeysCalls: 0 };
  const databases = new Map<string, FakeDatabase>();
  const fakeIndexedDb = {
    open(name: string): FakeRequest<FakeDatabase> {
      const existing = databases.get(name);
      const database = existing ?? createFakeDatabase(metrics);
      if (!existing) databases.set(name, database);
      const request = asyncRequest(database);
      queueMicrotask(() => {
        if (!existing) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  // DOM lib 下 globalThis.indexedDB 已是 IDBFactory，假实现只覆盖 open，交叉类型需经 unknown 过渡。
  (globalThis as unknown as { indexedDB: typeof fakeIndexedDb }).indexedDB = fakeIndexedDb;
  return metrics;
}

function createFakeDatabase(metrics: { getCalls: number; getAllKeysCalls: number }): FakeDatabase {
  const stores = new Map<string, Map<string, ArrayBuffer>>();
  return {
    stores,
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    transaction(name) {
      const store = stores.get(name);
      if (!store) throw new Error(`Fake IndexedDB store missing: ${name}`);
      const transaction: ReturnType<FakeDatabase['transaction']> = {
        objectStore() {
          return {
            get(key: string) {
              metrics.getCalls++;
              // IndexedDB 的 get 也会结构化克隆；不能直接暴露 store 的缓冲，
              // 否则测试会把独占读结果的修改/transfer 错当成数据库损坏。
              const request = asyncRequest(structuredClone(store.get(key)));
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
            put(value: ArrayBuffer, key: string) {
              const request = asyncRequest(undefined);
              // IndexedDB structured-clones ArrayBuffer values.  Do the same so
              // mutating the caller's Uint8Array cannot mutate the stored copy.
              const copy = value.slice(0);
              queueMicrotask(() => {
                request.onsuccess?.();
                queueMicrotask(() => {
                  store.set(key, copy);
                  transaction.oncomplete?.();
                });
              });
              return request;
            },
            getAllKeys() {
              metrics.getAllKeysCalls++;
              const request = asyncRequest([...store.keys()]);
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
}

describe('HttpGameFileProvider（IndexedDB 持久化）', () => {
  it('写后同实例读、flush 后跨实例读、缺失回退 HTTP、list 合并 IndexedDB 键', async () => {
    const idb = installFakeIndexedDb();
    const path = `Save/fs-smoke-${process.pid}.sav`;
    const first = new HttpGameFileProvider();
    const source = Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff);
    await first.write(path, source);
    source[0] = 0;
    expectBytes(
      await first.read(path),
      Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff),
      'Http 同实例',
    );
    await first.flush();

    // A new provider has no in-memory map.  This is the persistence boundary
    // that a browser reload exercises.
    const second = new HttpGameFileProvider();
    const persisted = await second.read(`save/FS-SMOKE-${process.pid}.SAV`);
    expectBytes(
      persisted,
      Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff),
      'Http 跨实例 IndexedDB',
    );
    if (persisted) persisted[1] = 0;
    expect((await second.read(path))?.[1], '读取结果必须是独立副本').toBe((1 * 37 + 11) & 0xff);
    if (persisted) {
      structuredClone(persisted, { transfer: [persisted.buffer] });
      expect(persisted.byteLength).toBe(0);
    }
    expectBytes(
      await second.read(path),
      Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff),
      '跨实例读结果 transfer 后不能损坏持久化记录',
    );

    // Missing development files still fall through to HTTP rather than being
    // reported as an empty persisted file.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('dir=gone')) return new Response(null, { status: 404 });
      return url.startsWith('/game/.list')
        ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 404 });
    };
    try {
      expect(await second.read(`missing/fs-smoke-${process.pid}.dat`)).toBe(null);
      // 存档写入只落 IndexedDB 不落盘：list 必须合并 IndexedDB 键，否则开发版
      // 导出存档（listSavePaths 枚举）会漏掉玩家真正的局内存档。
      expect(await second.list('save')).toEqual([`fs-smoke-${process.pid}.sav`]);
      expect(await second.list('other')).toEqual([]);
      expect(await second.list('')).toEqual([]);
      expect(second.hasKnownFile(path)).toBe(true);
      expect(second.hasKnownFile(`missing/material-indexed.shp`)).toBe(false);
      expect(await second.read('gone/material.shp')).toBe(null);
      expect(second.hasKnownFile('gone/another.shp')).toBe(false);
      // 一个 provider 只枚举一次持久化 key；不存在的 MIX 内素材不应各自触发 get。
      const getsBeforeMisses = idb.getCalls;
      await Promise.all(Array.from({ length: 100 }, (_, index) => second.read(`missing/material-${index}.shp`)));
      expect(idb.getCalls).toBe(getsBeforeMisses);
      // first/second 各自建立一次索引，重复 read/list 均复用。
      expect(idb.getAllKeysCalls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('跨 Provider 写入后，存档枚举会刷新 IndexedDB key 缓存', async () => {
    installFakeIndexedDb();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      return url.startsWith('/game/.list')
        ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 404 });
    };
    try {
      const main = new HttpGameFileProvider();
      const worker = new HttpGameFileProvider();
      expect(await listSavePaths(main)).toEqual([]);

      await worker.write('save/cross-provider.sav', new Uint8Array([4, 5, 6]));
      await worker.flush();

      expect(await listSavePaths(main)).toEqual(['save/cross-provider.sav']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('存档枚举会刷新动态目录清单缓存', async () => {
    installFakeIndexedDb();
    let fresh = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.startsWith('/game/.list')) return new Response(null, { status: 404 });
      if (url.includes('dir=save')) {
        return new Response(fresh ? '["fresh.sav"]' : '[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('["save"]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const provider = new HttpGameFileProvider();
      expect(await listSavePaths(provider)).toEqual([]);
      fresh = true;
      expect(await listSavePaths(provider)).toEqual(['save/fresh.sav']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

/* ------------------------------------------------------------------------- *
 * File System Access fake.  The writable deliberately pauses so that read()
 * can be checked while close() is still pending.
 * ------------------------------------------------------------------------- */

class FakeDirectory {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDirectory | FakeFile>();
  entriesCalls = 0;

  constructor(readonly name: string) {}

  async *entries(): AsyncIterableIterator<[string, FakeDirectory | FakeFile]> {
    this.entriesCalls++;
    yield* this.children;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FakeDirectory(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.children.get(name);
    if (existing instanceof FakeFile) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FakeFile(name);
    this.children.set(name, created);
    return created;
  }
}

class FakeFile {
  readonly kind = 'file' as const;
  bytes = new Uint8Array();
  writeStarted: Promise<void> | null = null;
  private releaseWrite: (() => void) | null = null;

  constructor(readonly name: string) {}

  async getFile(): Promise<Blob> {
    return new Blob([this.bytes]);
  }

  async createWritable(): Promise<{
    write(data: ArrayBuffer): Promise<void>;
    close(): Promise<void>;
  }> {
    let started!: () => void;
    this.writeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseWrite = release;
    return {
      write: async (data) => {
        started();
        await gate;
        this.bytes = new Uint8Array(data.slice(0));
      },
      close: async () => {},
    };
  }

  release(): void {
    this.releaseWrite?.();
    this.releaseWrite = null;
  }
}

class FailingDirectory extends FakeDirectory {
  override async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FailingDirectory(name);
    this.children.set(name, created);
    return created;
  }

  override async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    if (options?.create && name.toLowerCase() === 'fail.sav') throw new Error('simulated disk failure');
    return super.getFileHandle(name, options);
  }
}

describe('DirectoryGameFileProvider（File System Access）', () => {
  it('写后立即读见快照、flush 等待 close、目录索引缓存、跨实例读、外部覆盖后读新内容', async () => {
    const root = new FakeDirectory('RA2');
    const provider = new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle);
    const bytes = Uint8Array.from({ length: 1025 }, (_, index) => index & 0xff);
    const pending = provider.write('Save/Delayed.SAV', bytes);
    for (let attempt = 0; attempt < 20 && !root.children.has('save'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const saveDirectory = root.children.get('save');
    expect(saveDirectory instanceof FakeDirectory, 'write 应创建 Save 目录').toBe(true);
    const file = (saveDirectory as FakeDirectory).children.get('delayed.sav');
    expect(file instanceof FakeFile, 'write 应创建存档文件').toBe(true);
    const fakeFile = file as FakeFile;
    await fakeFile.writeStarted;

    // The host write is intentionally blocked.  A load in this interval must
    // see the immutable snapshot instead of waiting behind FileSystemAccess.
    expectBytes(await provider.read('save/delayed.sav'), bytes, 'Directory 写后立即读');
    let flushed = false;
    const flush = provider.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed, 'flush 必须等待底层 close 完成').toBe(false);
    fakeFile.release();
    await pending;
    await flush;
    expect(flushed).toBe(true);
    expect(root.entriesCalls, '同一 provider 的根目录索引应缓存').toBe(1);
    const freshProvider = new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle);
    expectBytes(await freshProvider.read('SAVE/DELAYED.SAV'), bytes, 'Directory 跨实例');
    expect(root.entriesCalls, '新 provider 应重新建立自己的目录索引').toBe(2);
    // 落盘完成后快照即撤：Windows 端在同一页面会话中覆盖存档后，下一次读取必须
    // 看到新内容（旧行为永远返回 VM 自己的快照——「读档后游戏状态错误」的根源）。
    fakeFile.bytes = Uint8Array.from([0xaa, 0xbb]);
    expectBytes(await provider.read('SAVE/DELAYED.SAV'), fakeFile.bytes, 'Directory 外部覆盖后读');
  });

  it('失败写入不留永久脏快照、不毒化后续存档队列', async () => {
    // A failed write must not leave a permanent stale read snapshot and must not
    // poison the queue for a later save.
    const failingRoot = new FailingDirectory('FAIL');
    const failingProvider = new DirectoryGameFileProvider(failingRoot as unknown as FileSystemDirectoryHandle);
    await expect(failingProvider.write('Save/fail.sav', new Uint8Array([1]))).rejects.toThrow();
    expect(await failingProvider.read('Save/fail.sav')).toBe(null);
    const okay = failingProvider.write('Save/ok.sav', new Uint8Array([2]));
    for (let attempt = 0; attempt < 20 && !failingRoot.children.has('save'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const okayDirectory = failingRoot.children.get('save');
    expect(okayDirectory instanceof FakeDirectory).toBe(true);
    for (let attempt = 0; attempt < 20 && !(okayDirectory as FakeDirectory).children.has('ok.sav'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const okayFile = (okayDirectory as FakeDirectory).children.get('ok.sav');
    expect(okayFile instanceof FakeFile).toBe(true);
    const fakeOkayFile = okayFile as FakeFile;
    await fakeOkayFile.writeStarted;
    fakeOkayFile.release();
    await okay;

    expectBytes(await failingProvider.read('Save/ok.sav'), new Uint8Array([2]), '失败后队列继续');
  });

  it('跨 Provider 写入后，scoped 存档枚举会刷新目录索引', async () => {
    const root = new FakeDirectory('INSTALL');
    root.children.set('ra2', new FakeDirectory('ra2'));
    const main = new ScopedGameFileProvider(
      new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle),
      'ra2',
    );
    const worker = new ScopedGameFileProvider(
      new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle),
      'ra2',
    );

    expect(await main.list('save')).toBe(null);
    const pending = worker.write('save/cross-provider.sav', new Uint8Array([7, 8, 9]));
    const gameRoot = root.children.get('ra2');
    for (let attempt = 0; attempt < 20 && !(gameRoot as FakeDirectory).children.has('save'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const saveDirectory = (gameRoot as FakeDirectory).children.get('save');
    expect(saveDirectory instanceof FakeDirectory).toBe(true);
    for (
      let attempt = 0;
      attempt < 20 && !(saveDirectory as FakeDirectory).children.has('cross-provider.sav');
      attempt++
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const file = (saveDirectory as FakeDirectory).children.get('cross-provider.sav');
    expect(file instanceof FakeFile).toBe(true);
    await (file as FakeFile).writeStarted;
    (file as FakeFile).release();
    await pending;
    await worker.flush();

    expect(await listSavePaths(main)).toEqual(['save/cross-provider.sav']);
  });
});

/* ------------------------------------------------------------------------- *
 * Win32 file handles: use real stage-shaped bytes and read them in the same
 * 16-byte pattern seen in the slow trace.  No v86 or game screen is involved.
 * ------------------------------------------------------------------------- */

describe('Win32 文件句柄（_lopen/_lread/_llseek/_lwrite）', () => {
  const pathPtr = 0x1000;
  const bufferPtr = 0x4000;

  it('16 字节小块顺序读全文件、EOF 归 0；独立句柄独立偏移、负 seek 不越文件头', () => {
    const memory = createGuestMemory(32 * 1024 * 1024);
    const shim = createTestShim(memory);
    const dispatch = (key: string, args: number[]): number => callShim(shim, key, args).eax >>> 0;
    const source = Uint8Array.from({ length: 96 * 1024 + 37 }, (_, index) => (index * 13 + 5) & 0xff);
    const original = source.slice();
    shim.mountFile('stage11.stg', source);
    source[0] = 0;
    source[source.length - 1] = 0;
    writeAsciiZ(memory, pathPtr, 'C:\\STAGE11.STG');
    const handle = dispatch('KERNEL32.DLL!_lopen', [pathPtr, 0]);
    expect(handle, '_lopen 应找到挂载文件').not.toBe(0xffff_ffff);

    const actual = new Uint8Array(original.length);
    let offset = 0;
    while (offset < actual.length) {
      const requested = Math.min(16, actual.length - offset);
      const count = dispatch('KERNEL32.DLL!_lread', [handle, bufferPtr, requested]);
      expect(count, `_lread 16-byte chunk at ${offset}`).toBe(requested);
      actual.set(memory.read_memory(bufferPtr, count), offset);
      offset += count;
    }
    expect([...actual], 'Win32 小块读出的文件内容必须逐字节一致').toEqual([...original]);
    expect(dispatch('KERNEL32.DLL!_lread', [handle, bufferPtr, 16]), 'EOF 应返回 0').toBe(0);
    expect(dispatch('KERNEL32.DLL!_lclose', [handle])).toBe(0);

    // Independent handles must have independent positions; seek must accept a
    // signed 32-bit offset and SetFilePointer must publish the high dword.
    const second = dispatch('KERNEL32.DLL!_lopen', [pathPtr, 0]);
    expect(dispatch('KERNEL32.DLL!_llseek', [second, 0x8000_0000, 0]), '负 seek 不应越过文件头').toBe(0xffff_ffff);
    expect(dispatch('KERNEL32.DLL!_llseek', [second, 1234, 0])).toBe(1234);
    expect(dispatch('KERNEL32.DLL!_lread', [second, bufferPtr, 16])).toBe(16);
    expect([...memory.read_memory(bufferPtr, 16)]).toEqual([...original.subarray(1234, 1250)]);
    expect(dispatch('KERNEL32.DLL!_lclose', [second])).toBe(0);
  });

  it('_lcreat 小块写关闭时一次落盘；重挂载读回；OF_WRITE 原地重写后可读', () => {
    const memory = createGuestMemory(32 * 1024 * 1024);
    const createPathPtr = 0x2000;
    writeAsciiZ(memory, createPathPtr, 'Save\\fs-smoke.sav');
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const writer = createTestShim(memory, { onFileWrite: (path, value) => writes.push({ path, bytes: value }) });
    const create = (key: string, args: number[]): number => callShim(writer, key, args).eax >>> 0;
    const saveHandle = create('KERNEL32.DLL!_lcreat', [createPathPtr, 0]);
    for (let index = 0; index < 4096; index++) {
      memory.bytes[bufferPtr] = index & 0xff;
      expect(create('KERNEL32.DLL!_lwrite', [saveHandle, bufferPtr, 1])).toBe(1);
    }
    expect(writes.length, '小块写期间不应反复落盘').toBe(0);
    expect(create('KERNEL32.DLL!_lclose', [saveHandle])).toBe(0);
    expect(writes.length).toBe(1);
    expect(writes[0]!.bytes.length).toBe(4096);
    expect(writes[0]!.path).toBe('save/fs-smoke.sav');
    expect([...writes[0]!.bytes.subarray(0, 4)]).toEqual([0, 1, 2, 3]);

    // A second shim is the load half of save -> reload.
    const loaded = createGuestMemory(32 * 1024 * 1024);
    const loadedShim = createTestShim(loaded);
    loadedShim.mountFile(writes[0]!.path, writes[0]!.bytes);
    writeAsciiZ(loaded, pathPtr, 'SAVE\\FS-SMOKE.SAV');
    const loadedHandle = callShim(loadedShim, 'KERNEL32.DLL!_lopen', [pathPtr, 0]).eax >>> 0;
    expect(callShim(loadedShim, 'KERNEL32.DLL!_lread', [loadedHandle, bufferPtr, 4096]).eax).toBe(4096);
    expect([...loaded.read_memory(bufferPtr, 4096)]).toEqual([...writes[0]!.bytes]);
    expect(callShim(loadedShim, 'KERNEL32.DLL!_lclose', [loadedHandle]).eax).toBe(0);

    // 原版存档流程用 _lopen(path, OF_WRITE) 原地重写 label.sav/record.sav。
    // 可写标志被忽略时 _lwrite 静默失败，新存档在读档界面就看不到/对不上。
    writeAsciiZ(memory, createPathPtr, 'Label.sav');
    writer.mountFile('label.sav', new Uint8Array(324));
    const labelHandle = create('KERNEL32.DLL!_lopen', [createPathPtr, 1]);
    expect(labelHandle, '_lopen OF_WRITE 应打开已挂载文件').not.toBe(0xffff_ffff);
    for (let index = 0; index < 324; index++) {
      memory.bytes[bufferPtr] = (index * 7 + 3) & 0xff;
      expect(
        create('KERNEL32.DLL!_lwrite', [labelHandle, bufferPtr, 1]),
        `OF_WRITE 句柄 _lwrite@${index} 不应被拒绝`,
      ).toBe(1);
    }
    expect(create('KERNEL32.DLL!_lclose', [labelHandle])).toBe(0);
    expect(writes.length, 'OF_WRITE 句柄关闭后应 flush 新内容').toBe(2);
    expect(writes[1]!.path).toBe('label.sav');
    expect(writes[1]!.bytes.length).toBe(324);
    expect([...writes[1]!.bytes.subarray(0, 4)]).toEqual([3, 10, 17, 24]);

    // 读档路径：只读 _lopen 应读到刚才写入的内容。
    const labelReadHandle = create('KERNEL32.DLL!_lopen', [createPathPtr, 0]);
    expect(create('KERNEL32.DLL!_lread', [labelReadHandle, bufferPtr, 324])).toBe(324);
    expect(memory.bytes[bufferPtr]).toBe(3);
    expect(memory.bytes[bufferPtr + 1]).toBe(10);
    expect(create('KERNEL32.DLL!_lclose', [labelReadHandle])).toBe(0);
  });
});

/**
 * VirtualAlloc 保留区与堆互斥回环：原版 VC6 CRT 启动时 VirtualAlloc(NULL, 1MB,
 * MEM_RESERVE)，再在保留区内逐 32KB 块 COMMIT/DECOMMIT。保留区绝不能进入堆
 * 空闲链表（否则文件镜像/HeapAlloc 会复用游戏正在使用的块，历史上触发过
 * CPU #6 @EIP=0x8f）。virtualTop 压到 8MB 让堆必然穿过保留区，验证跳越屏障。
 *
 * 原脚本用 Win32Shim 默认 arena 顶 0x7e00000；createTestShim 默认把 heapTop
 * 收窄到 0xc00000，会让「界内固定地址 0xc00000」与 5MB bump 断言越界，
 * 这里显式钉回原始默认值。
 */
describe('VirtualAlloc 保留区与堆互斥', () => {
  const ARENA_TOP = 0x07e0_0000;
  const VIRTUAL_TOP = 0x0080_0000;

  it('reserve/commit/decommit/跳越屏障/释放链表复用全流程', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { heapTop: ARENA_TOP, virtualTop: VIRTUAL_TOP });
    const dispatch = (key: string, args: number[]): number => callShim(shim, key, args).eax >>> 0;

    // 1. NULL 保留 1MB。
    const region = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(
      region >= 0x0050_0000 && region < 0x0080_0000,
      `NULL 保留应落在堆上方: 0x${region.toString(16)}`,
    ).toBeTruthy();

    // 2. 保留区内逐块提交（游戏从返回值派生提交地址）。
    const commitA = dispatch('KERNEL32.DLL!VirtualAlloc', [region + 0x130, 0x8000]);
    expect(commitA, '保留区内提交应返回请求地址').toBe(region + 0x130);
    const commitB = dispatch('KERNEL32.DLL!VirtualAlloc', [region + 0x8130, 0x8000]);
    expect(commitB, '第二个提交块应在同一保留区').toBe(region + 0x8130);

    // 3. DECOMMIT 保持保留：区域仍在，且同一地址可重新提交。
    expect(dispatch('KERNEL32.DLL!VirtualFree', [commitA, 0x8000, 0x4000]), 'DECOMMIT 应成功').toBe(1);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [commitA, 0x8000]), 'DECOMMIT 后应能重新提交同一地址').toBe(commitA);

    // 4. 堆增长到穿过保留区的高度，仍不得侵入保留区（跳越屏障）。
    const live: number[] = [];
    for (let round = 0; round < 200; round++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x4000 + (round % 8) * 16]);
      expect(ptr, `HeapAlloc 第 ${round} 轮应成功`).toBeTruthy();
      expect(ptr < region || ptr >= region + 0x100000, `HeapAlloc 0x${ptr.toString(16)} 侵入保留区`).toBeTruthy();
      live.push(ptr);
      if (live.length > 5) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, live.shift()!])).toBe(1);
    }
    for (const ptr of live) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);

    // 5. 与活动堆分配重叠的 VirtualAlloc 必须拒绝而不是静默别名。
    const heapPtr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [heapPtr, 0x1000]), '重叠的 VirtualAlloc 应拒绝').toBe(0);

    // 6. MEM_RELEASE 释放整个保留区。
    expect(dispatch('KERNEL32.DLL!VirtualFree', [region, 0, 0x8000]), 'MEM_RELEASE 应成功').toBe(1);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [commitB, 0x8000, 0x4000]), '释放后区内 DECOMMIT 应失败').toBe(0);
    expect(shim.inspectHeapState().virtualRegions, '释放后不应有残留保留区').toBe(0);

    // 7. 覆盖空闲堆块的保留必须把空闲块剔除，堆不能复用该范围。
    const freed: number[] = [];
    for (let i = 0; i < 8; i++) freed.push(dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]));
    for (const ptr of freed) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [freed[0]!, 0x2000]), '空闲块上的保留应成功').toBe(freed[0]);
    for (let i = 0; i < 8; i++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
      expect(
        ptr < freed[0]! || ptr >= freed[0]! + 0x2000,
        `HeapAlloc 0x${ptr.toString(16)} 复用被保留的空闲块`,
      ).toBeTruthy();
    }

    // 8. MEM_RELEASE 把区域还给 VirtualAlloc 专用释放链表（wemu try_free 模型），
    //    绝不进入堆空闲链表：HeapAlloc 拿不到，随后的 NULL 保留自高向低复用。
    const virtualFreeBefore = shim.inspectHeapState().virtualFreeBytes;
    expect(dispatch('KERNEL32.DLL!VirtualFree', [freed[0]!, 0, 0x8000]), 'MEM_RELEASE 应成功').toBe(1);
    expect(shim.inspectHeapState().virtualFreeBytes, '释放后应计入虚拟释放字节').toBe(virtualFreeBefore + 0x2000);
    const heapAfterRelease = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x2000]);
    expect(heapAfterRelease, 'HeapAlloc 不得复用已释放的保留区').not.toBe(freed[0]);
    expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, heapAfterRelease])).toBe(1);
    // 释放链表里有步骤 6 的 1MB 与刚释放的 8KB。堆基址 0x500000→0x700000
    // 抬升后（避开低区游戏栈），8KB 块落在 1MB 块上方：NULL 保留应自高向低
    // 复用最高的已释放块（8KB），把 1MB 块留给大保留。
    const reuseHigh = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x2000]);
    expect(reuseHigh, 'NULL 保留应复用最高的已释放块顶端').toBe(freed[0]);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [reuseHigh, 0, 0x8000]), '复用区再次释放应成功').toBe(1);
    // 0x2000 用完整块后链表只剩 1MB 块：同尺寸的 NULL 保留应整块复用。
    const reuseBig = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(reuseBig, '1MB 块应留给大保留复用').toBe(region);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [reuseBig, 0, 0x8000]), '1MB 复用区再次释放应成功').toBe(1);

    // 9. 保留区外的固定地址在 arena 界内按请求基址新建区域（wemu alloc_at），
    //    界外拒绝；DECOMMIT 保持保留、零填充，RELEASE 后整体可复用。
    const fixed = 0x00c0_0000;
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [fixed, 0x2000]), '界内固定地址应新建保留区').toBe(fixed);
    memory.write_memory(new Uint8Array([0xab, 0xcd]), fixed);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [fixed, 0x2000, 0x4000]), '固定区 DECOMMIT 应成功').toBe(1);
    expect(memory.read_memory(fixed, 2)[0], 'DECOMMIT 后内容应清零').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [fixed, 0x2000]), 'DECOMMIT 后应能重新提交').toBe(fixed);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [0x1000, 0x1000]), '低于堆下界的固定地址应拒绝').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [0x07f0_0000, 0x2000]), '越过堆上界的固定地址应拒绝').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [fixed, 0x2000, 0]), '既非 RELEASE 也非 DECOMMIT 的类型应拒绝').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [fixed, 0, 0x8000]), '固定区 MEM_RELEASE 应成功').toBe(1);

    // 10. 释放区可复用时 NULL 保留应优先整块复用（步骤 6/8 的 1MB 已重新
    //     合并，virtualTop=8MB 时 1MB 保留应恰为 0x700000）。
    const fill: number[] = [];
    for (let i = 0; i < 12; i++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x40000]);
      expect(ptr, `堆填充第 ${i} 块应成功`).toBeTruthy();
      fill.push(ptr);
    }
    for (const ptr of fill) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);
    const topRegion = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(topRegion, `NULL 保留应复用 0x700000 释放区，实得 0x${topRegion.toString(16)}`).toBe(0x0070_0000);
    for (let i = 0; i < 16; i++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
      expect(
        ptr < topRegion || ptr >= topRegion + 0x100000,
        `HeapAlloc 0x${ptr.toString(16)} 复用落在空闲块上的保留区`,
      ).toBeTruthy();
    }
  });

  it('堆 bump 驶入 nextHeap 之上的已释放区域时必须同步剔除', () => {
    // wemu 靠独立 arena 规避；共用一个地址空间时 bump 自取即从释放链表移除。
    const shim2 = createTestShim(createGuestMemory(), { heapTop: ARENA_TOP, virtualTop: VIRTUAL_TOP });
    const dispatch2 = (key: string, args: number[]): number => callShim(shim2, key, args).eax >>> 0;
    const top = dispatch2('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(dispatch2('KERNEL32.DLL!VirtualFree', [top, 0, 0x8000]), 'MEM_RELEASE 应成功').toBe(1);
    const big = dispatch2('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x500000]);
    expect(big, `大块应自 0x700000 前进分配，实得 0x${big.toString(16)}`).toBe(0x0070_0000);
    expect(shim2.inspectHeapState().virtualFreeBytes, 'bump 驶入的释放区必须从链表剔除').toBe(0);
    // 0x700000 被 5MB bump 吃掉后，1MB 保留自顶向下落到 0x600000 空闲带。
    const again = dispatch2('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(again, '被 bump 吃掉的释放区不得再发给 VirtualAlloc').toBe(0x0060_0000);
    expect(dispatch2('KERNEL32.DLL!VirtualFree', [again, 0, 0x8000]), '0x600000 复用区释放应成功').toBe(1);
  });

  it('无释放区可复用时 NULL 保留必须剔除堆空闲链表重叠（trimFreeBlocks 回归）', () => {
    // 回归历史上漏掉的 trimFreeBlocks 调用：堆填满 3MB 再全释放，1MB 保留骑在
    // 空闲块上，此后 HeapAlloc 不得复用保留范围。
    const shim3 = createTestShim(createGuestMemory(), { heapTop: ARENA_TOP, virtualTop: VIRTUAL_TOP });
    const dispatch3 = (key: string, args: number[]): number => callShim(shim3, key, args).eax >>> 0;
    const fill3: number[] = [];
    for (let i = 0; i < 12; i++) fill3.push(dispatch3('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x40000]));
    for (const ptr of fill3) expect(dispatch3('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);
    const reserve3 = dispatch3('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(reserve3, `NULL 保留应落在自顶向下的 0x700000，实得 0x${reserve3.toString(16)}`).toBe(0x0070_0000);
    for (let i = 0; i < 16; i++) {
      const ptr = dispatch3('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
      expect(
        ptr < reserve3 || ptr >= reserve3 + 0x100000,
        `HeapAlloc 0x${ptr.toString(16)} 复用落在空闲块上的保留区`,
      ).toBeTruthy();
    }
  });

  it('ExitProcess 落在 KERNEL32 路由并携带退出码', () => {
    // 退出家族必须落在 KERNEL32 路由上（曾在 DLL 拆分时误入 directx 分派成死代码）。
    // 原脚本复用上面的 shim；路由断言与堆状态无关，这里用独立 shim。
    const shim = createTestShim(createGuestMemory());
    const exitResult = callShim(shim, 'KERNEL32.DLL!ExitProcess', [7]);
    expect(exitResult.exit, 'ExitProcess 应走 KERNEL32 路由并携带退出码').toBeTruthy();
    expect(exitResult.eax, 'ExitProcess 应走 KERNEL32 路由并携带退出码').toBe(7);
  });
});

describe('MemoryGameFileProvider 控制组', () => {
  it('路径归一化与副本语义与持久化实现一致', async () => {
    // Memory provider is a control: path normalization/copy semantics should
    // match the persistent implementations.
    const memory = new MemoryGameFileProvider();
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    await memory.write('Save\\control.sav', bytes);
    bytes[0] = 0;
    expectBytes(await memory.read('save/CONTROL.SAV'), new Uint8Array([3, 1, 4, 1, 5]), 'Memory 控制组');
  });
});
