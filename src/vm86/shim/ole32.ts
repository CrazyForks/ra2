import type { Win32Call, Win32Result } from '../win32';
import { shimTraceEnabled, type Constructor } from './state';
import type { withDplayx } from './dplayx';
import { CLSID_DIRECTPLAY, formatGuid, guidBytes, isDirectPlayIid } from './dplayx';
import { normalizeGuestPath } from '../paths';

type DplayxChain = InstanceType<ReturnType<typeof withDplayx>>;

interface OleStorageState {
  path: string;
  refs: number;
  streams: Map<string, Uint8Array>;
  /** Reusable backing capacity; streams exposes views at each stream's logical length. */
  streamCapacities: Map<string, Uint8Array>;
  propertySets: Map<string, OlePropertySetState>;
}

interface OleStreamState {
  storage: OleStorageState;
  name: string;
  refs: number;
  position: number;
}

interface OlePropertySetState {
  fmtid: Uint8Array;
}

interface OlePropertySetStorageObject {
  storage: OleStorageState;
  refs: number;
}

interface OlePropertyStorageObject {
  propertySet: OlePropertySetState;
  refs: number;
}

const IID_IUNKNOWN = '{00000000-0000-0000-c000-000000000046}';
const IID_ISTORAGE = '{0000000b-0000-0000-c000-000000000046}';
const IID_ISTREAM = '{0000000c-0000-0000-c000-000000000046}';
const IID_IPROPERTYSETSTORAGE = '{0000013a-0000-0000-c000-000000000046}';
const IID_IPROPERTYSTORAGE = '{00000138-0000-0000-c000-000000000046}';

const ISTORAGE_METHODS: ReadonlyArray<readonly [string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['CreateStream', 24],
  ['OpenStream', 24],
  ['CreateStorage', 24],
  ['OpenStorage', 28],
  ['CopyTo', 20],
  ['MoveElementTo', 20],
  ['Commit', 8],
  ['Revert', 4],
  ['EnumElements', 20],
  ['DestroyElement', 8],
  ['RenameElement', 12],
  ['SetElementTimes', 20],
  ['SetClass', 8],
  ['SetStateBits', 12],
  ['Stat', 12],
];

const ISTREAM_METHODS: ReadonlyArray<readonly [string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['Read', 16],
  ['Write', 16],
  ['Seek', 20],
  ['SetSize', 12],
  ['CopyTo', 24],
  ['Commit', 8],
  ['Revert', 4],
  ['LockRegion', 24],
  ['UnlockRegion', 24],
  ['Stat', 12],
  ['Clone', 8],
];

const IPROPERTYSETSTORAGE_METHODS: ReadonlyArray<readonly [string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['Create', 24],
  ['Open', 16],
  ['Delete', 8],
  ['Enum', 8],
];

const IPROPERTYSTORAGE_METHODS: ReadonlyArray<readonly [string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['ReadMultiple', 16],
  ['WriteMultiple', 20],
  ['DeleteMultiple', 12],
  ['ReadPropertyNames', 16],
  ['WritePropertyNames', 16],
  ['DeletePropertyNames', 12],
  ['Commit', 8],
  ['Revert', 4],
  ['Enum', 8],
  ['SetTimes', 16],
  ['SetClass', 8],
  ['Stat', 8],
];

const STORAGE_MAGIC = new TextEncoder().encode('SGBYSTG1');
/** Guest-controlled IStream sizes must not turn a corrupt save pointer into a host OOM. */
const MAX_OLE_STREAM_BYTES = 64 * 1024 * 1024;

/**
 * OLE32 最小面。CoInitialize 只是每线程 COM 初始化计数（单执行线模型恒为主线程）；
 * CoCreateInstance 除了宿主实现的 DirectPlay，还会调用客体通过
 * CoRegisterClassObject 注册的 IClassFactory。RA2 用这条标准 COM 路径创建
 * Locomotor 等游戏内部对象，不能把注册调用仅当作成功的空操作。
 */
export function withOle32<TBase extends Constructor<DplayxChain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    /** 单执行线模型下只有一条线程，初始化深度用计数即可。 */
    private comInitCount = 0;
    private nextClassCookie = 1;
    private registeredClasses = new Map<string, { cookie: number; factory: number }>();
    private registeredClassCookies = new Map<number, string>();
    private storageVtable = 0;
    private streamVtable = 0;
    private propertySetStorageVtable = 0;
    private propertyStorageVtable = 0;
    private readonly storages = new Map<number, OleStorageState>();
    private readonly streams = new Map<number, OleStreamState>();
    private readonly propertySetStorages = new Map<number, OlePropertySetStorageObject>();
    private readonly propertyStorages = new Map<number, OlePropertyStorageObject>();
    private readonly storedDocuments = new Map<string, OleStorageState>();

    dispatchOle32(call: Win32Call, key: string, _name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'OLE32.DLL!CoInitialize': {
          // 官方语义：首次 S_OK(0)，重复初始化 S_FALSE(1)。pvReserved 必须为 NULL，
          // 原版调用点传 0，这里不检查。
          const first = this.comInitCount === 0;
          this.comInitCount++;
          return { eax: first ? 0 : 1 };
        }
        case 'OLE32.DLL!OleInitialize': {
          const first = this.comInitCount === 0;
          this.comInitCount++;
          return { eax: first ? 0 : 1 };
        }
        case 'OLE32.DLL!OleUninitialize':
          this.comInitCount = Math.max(0, this.comInitCount - 1);
          return { eax: 0 };
        case 'OLE32.DLL!StringFromGUID2': {
          const value = a[0] ? formatGuid(this.readBytes(a[0], 16)) : '';
          const capacity = a[2] ?? 0;
          if (!a[1] || capacity <= value.length) return { eax: 0 };
          const bytes = new Uint8Array((value.length + 1) * 2);
          for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            bytes[i * 2] = code & 0xff;
            bytes[i * 2 + 1] = code >>> 8;
          }
          this.memory.write_memory(bytes, a[1]);
          return { eax: value.length + 1 };
        }
        case 'OLE32.DLL!CLSIDFromString': {
          const destination = a[1] ?? 0;
          if (!destination) return { eax: 0x8000_4003 }; // E_POINTER
          if (!a[0]) {
            this.zero(destination, 16); // NULL 字符串按 GUID_NULL
            return { eax: 0 };
          }
          const value = this.readOleWideString(a[0]).trim();
          const normalized = value.startsWith('{') ? value : `{${value}}`;
          if (!/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(normalized)) {
            this.zero(destination, 16);
            return { eax: 0x8004_01f3 }; // CO_E_CLASSSTRING
          }
          this.memory.write_memory(guidBytes(normalized.toLowerCase()), destination);
          return { eax: 0 };
        }
        case 'OLE32.DLL!StringFromCLSID': {
          if (!a[0] || !a[1]) return { eax: 0x8000_4003 };
          const value = formatGuid(this.readBytes(a[0], 16));
          const pointer = this.alloc((value.length + 1) * 2, true);
          const bytes = new Uint8Array((value.length + 1) * 2);
          for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            bytes[index * 2] = code & 0xff;
            bytes[index * 2 + 1] = code >>> 8;
          }
          this.memory.write_memory(bytes, pointer);
          this.writeU32(a[1], pointer);
          return { eax: 0 };
        }
        case 'OLE32.DLL!CoRegisterClassObject': {
          const rclsid = a[0] ?? 0;
          const factory = a[1] ?? 0;
          const cookieOut = a[4] ?? 0;
          if (!rclsid || !factory || !cookieOut) return { eax: 0x8000_4003 }; // E_POINTER
          const clsid = formatGuid(this.readBytes(rclsid, 16));
          const old = this.registeredClasses.get(clsid);
          if (old) this.registeredClassCookies.delete(old.cookie);
          const cookie = this.nextClassCookie++ >>> 0 || this.nextClassCookie++ >>> 0;
          this.registeredClasses.set(clsid, { cookie, factory });
          this.registeredClassCookies.set(cookie, clsid);
          this.writeU32(cookieOut, cookie);
          return { eax: 0 };
        }
        case 'OLE32.DLL!CoRevokeClassObject': {
          const cookie = a[0] ?? 0;
          const clsid = this.registeredClassCookies.get(cookie);
          if (!clsid) return { eax: 0x8004_017b }; // CO_E_OBJNOTREG
          this.registeredClassCookies.delete(cookie);
          const registration = this.registeredClasses.get(clsid);
          if (registration?.cookie === cookie) this.registeredClasses.delete(clsid);
          return { eax: 0 };
        }
        case 'OLE32.DLL!CoFileTimeNow': {
          const fileTime = a[0] ?? 0;
          if (!fileTime) return { eax: 0x8000_4003 }; // E_POINTER
          const value = this.guestNowFileTime();
          this.writeU32(fileTime, Number(value & 0xffff_ffffn));
          this.writeU32(fileTime + 4, Number((value >> 32n) & 0xffff_ffffn));
          return { eax: 0 }; // S_OK
        }
        case 'OLE32.DLL!CoDisconnectObject':
        case 'OLE32.DLL!OleRun':
          return { eax: 0 };
        case 'OLE32.DLL!OleSaveToStream': {
          const persistStream = a[0] ?? 0;
          const stream = a[1] ?? 0;
          if (!persistStream || !stream) return { eax: 0x8000_4003 }; // E_POINTER
          if (this.options.gameProfile?.skipGuestOleSaveToStream) return { eax: 0 };
          this.redirectOleSaveToStream(call, persistStream, stream);
          return { eax: 0 };
        }
        case 'OLE32.DLL!OleLoadFromStream':
          // 当前存档路径只用 OleSaveToStream；保持可识别的 HRESULT，
          // 不让未实现导入直接终止 VM。
          if (a[2]) this.writeU32(a[2], 0);
          return { eax: 0x8000_4001 }; // E_NOTIMPL
        case 'OLE32.DLL!StgCreateDocfile': {
          const out = a[3] ?? 0;
          if (!out) return { eax: 0x8000_4003 }; // E_POINTER
          this.writeU32(out, 0);
          const path = a[0] ? normalizeGuestPath(this.readOleWideString(a[0])) : '';
          if (!path) return { eax: 0x8003_00fc }; // STG_E_INVALIDNAME
          const storage: OleStorageState = {
            path,
            refs: 1,
            streams: new Map(),
            streamCapacities: new Map(),
            propertySets: new Map(),
          };
          this.storedDocuments.set(path, storage);
          this.writeU32(out, this.createStorageObject(storage));
          return { eax: 0 };
        }
        case 'OLE32.DLL!StgOpenStorage': {
          const out = a[5] ?? 0;
          if (!out) return { eax: 0x8000_4003 };
          this.writeU32(out, 0);
          const path = a[0] ? normalizeGuestPath(this.readOleWideString(a[0])) : '';
          let storage = this.storedDocuments.get(path);
          if (!storage) {
            const bytes = this.getMountedFileBytes(path);
            if (bytes) storage = this.decodeStorage(path, bytes);
            if (storage) this.storedDocuments.set(path, storage);
          }
          if (!storage) return { eax: 0x8003_0002 }; // STG_E_FILENOTFOUND
          storage.refs++;
          this.writeU32(out, this.createStorageObject(storage));
          return { eax: 0 };
        }
        default:
          if (key.startsWith('OLE32.DLL!IStorage.')) {
            return this.dispatchStorage(key.slice('OLE32.DLL!IStorage.'.length), a);
          }
          if (key.startsWith('OLE32.DLL!IStream.')) {
            return this.dispatchStream(key.slice('OLE32.DLL!IStream.'.length), a);
          }
          if (key.startsWith('OLE32.DLL!IPropertySetStorage.')) {
            return this.dispatchPropertySetStorage(key.slice('OLE32.DLL!IPropertySetStorage.'.length), a);
          }
          if (key.startsWith('OLE32.DLL!IPropertyStorage.')) {
            return this.dispatchPropertyStorage(key.slice('OLE32.DLL!IPropertyStorage.'.length), a);
          }
          return null;
        case 'OLE32.DLL!CoCreateInstance': {
          // stdcall 5 参数 20 字节：rclsid, pUnkOuter, dwClsContext, riid, ppv。
          const rclsid = a[0] ?? 0;
          const pUnkOuter = a[1] ?? 0;
          const riid = a[3] ?? 0;
          const ppv = a[4] ?? 0;
          const clsid = rclsid ? formatGuid(this.readBytes(rclsid, 16)) : '(null)';
          const iid = riid ? formatGuid(this.readBytes(riid, 16)) : '(null)';
          if (!ppv) return { eax: 0x8000_4003 }; // E_POINTER
          this.writeU32(ppv, 0);
          if (pUnkOuter) return { eax: 0x8004_0110 }; // CLASS_E_NOAGGREGATION
          const registration = this.registeredClasses.get(clsid);
          if (registration) {
            this.redirectRegisteredCoCreate(call, registration.factory, pUnkOuter, riid, ppv);
            return { eax: 0 };
          }
          if (clsid === CLSID_DIRECTPLAY) {
            if (isDirectPlayIid(iid)) {
              this.writeU32(ppv, this.createDirectPlay());
              return { eax: 0 }; // S_OK
            }
            this.unimplementedDetail = `CLSID_DirectPlay 请求未实现的接口 riid=${iid}`;
            return null;
          }
          if (clsid === '{1440ad10-6aa8-11d1-b6f9-00a024ddafd1}') {
            const module = this.loadedGuestDlls.get('blowfish.dll');
            const getClassObject = module?.exports.get('DllGetClassObject');
            if (module?.initialized && getClassObject) {
              this.redirectGuestCoCreate(call, getClassObject, rclsid, pUnkOuter, riid, ppv);
              return { eax: 0 };
            }
          }
          // RA2 会探测可选的 WOL/DirectPlay lobby COM 类。单机模式没有注册这些
          // 外部组件，按真实 Windows 的“类未注册”返回，让游戏走离线路径。
          return { eax: 0x8004_0154 }; // REGDB_E_CLASSNOTREG
        }
      }
    }
    private createStorageObject(storage: OleStorageState): number {
      if (!this.storageVtable) {
        this.storageVtable = this.alloc(ISTORAGE_METHODS.length * 4, true);
        ISTORAGE_METHODS.forEach(([name, bytes], index) => {
          this.writeU32(
            this.storageVtable + index * 4,
            this.registerDynamicWin32Import('OLE32.DLL', `IStorage.${name}`, bytes),
          );
        });
      }
      const object = this.alloc(8, true);
      this.writeU32(object, this.storageVtable);
      this.storages.set(object, storage);
      return object;
    }

    private createStreamObject(storage: OleStorageState, name: string): number {
      if (!this.streamVtable) {
        this.streamVtable = this.alloc(ISTREAM_METHODS.length * 4, true);
        ISTREAM_METHODS.forEach(([method, bytes], index) => {
          this.writeU32(
            this.streamVtable + index * 4,
            this.registerDynamicWin32Import('OLE32.DLL', `IStream.${method}`, bytes),
          );
        });
      }
      const object = this.alloc(8, true);
      this.writeU32(object, this.streamVtable);
      this.streams.set(object, { storage, name, refs: 1, position: 0 });
      return object;
    }

    private createPropertySetStorageObject(storage: OleStorageState): number {
      if (!this.propertySetStorageVtable) {
        this.propertySetStorageVtable = this.alloc(IPROPERTYSETSTORAGE_METHODS.length * 4, true);
        IPROPERTYSETSTORAGE_METHODS.forEach(([method, bytes], index) => {
          this.writeU32(
            this.propertySetStorageVtable + index * 4,
            this.registerDynamicWin32Import('OLE32.DLL', `IPropertySetStorage.${method}`, bytes),
          );
        });
      }
      const object = this.alloc(8, true);
      this.writeU32(object, this.propertySetStorageVtable);
      this.propertySetStorages.set(object, { storage, refs: 1 });
      return object;
    }

    private createPropertyStorageObject(propertySet: OlePropertySetState): number {
      if (!this.propertyStorageVtable) {
        this.propertyStorageVtable = this.alloc(IPROPERTYSTORAGE_METHODS.length * 4, true);
        IPROPERTYSTORAGE_METHODS.forEach(([method, bytes], index) => {
          this.writeU32(
            this.propertyStorageVtable + index * 4,
            this.registerDynamicWin32Import('OLE32.DLL', `IPropertyStorage.${method}`, bytes),
          );
        });
      }
      const object = this.alloc(8, true);
      this.writeU32(object, this.propertyStorageVtable);
      this.propertyStorages.set(object, { propertySet, refs: 1 });
      return object;
    }

    private dispatchStorage(method: string, a: number[]): Win32Result {
      const object = a[0] ?? 0;
      const storage = this.storages.get(object);
      if (!storage) return { eax: 0x8003_0008 }; // STG_E_INVALIDHANDLE
      switch (method) {
        case 'QueryInterface':
          return this.queryStorageInterface(object, storage, a[1] ?? 0, a[2] ?? 0);
        case 'AddRef':
          return { eax: ++storage.refs };
        case 'Release': {
          storage.refs = Math.max(0, storage.refs - 1);
          this.storages.delete(object);
          return { eax: storage.refs };
        }
        case 'CreateStream': {
          const out = a[5] ?? 0;
          if (!out) return { eax: 0x8000_4003 };
          const name = this.readOleWideString(a[1] ?? 0).toLowerCase();
          storage.streams.set(name, new Uint8Array());
          storage.streamCapacities.delete(name);
          this.writeU32(out, this.createStreamObject(storage, name));
          return { eax: 0 };
        }
        case 'OpenStream': {
          const out = a[5] ?? 0;
          if (!out) return { eax: 0x8000_4003 };
          const name = this.readOleWideString(a[1] ?? 0).toLowerCase();
          if (!storage.streams.has(name)) {
            this.writeU32(out, 0);
            return { eax: 0x8003_0002 };
          }
          this.writeU32(out, this.createStreamObject(storage, name));
          return { eax: 0 };
        }
        case 'Commit':
          this.commitStorage(storage);
          return { eax: 0 };
        case 'SetClass':
        case 'SetStateBits':
        case 'SetElementTimes':
          return { eax: 0 };
        case 'DestroyElement': {
          const name = this.readOleWideString(a[1] ?? 0).toLowerCase();
          storage.streamCapacities.delete(name);
          return { eax: storage.streams.delete(name) ? 0 : 0x8003_0002 };
        }
        case 'RenameElement': {
          const oldName = this.readOleWideString(a[1] ?? 0).toLowerCase();
          const newName = this.readOleWideString(a[2] ?? 0).toLowerCase();
          const bytes = storage.streams.get(oldName);
          if (!bytes) return { eax: 0x8003_0002 };
          const capacity = storage.streamCapacities.get(oldName);
          storage.streams.delete(oldName);
          storage.streams.set(newName, bytes);
          storage.streamCapacities.delete(oldName);
          if (capacity) storage.streamCapacities.set(newName, capacity);
          return { eax: 0 };
        }
        case 'Stat':
          if (!a[1]) return { eax: 0x8000_4003 };
          this.zero(a[1], 72);
          this.writeU32(a[1] + 4, 1); // STGTY_STORAGE
          return { eax: 0 };
        default:
          return { eax: 0x8003_0001 }; // STG_E_INVALIDFUNCTION
      }
    }

    private dispatchStream(method: string, a: number[]): Win32Result {
      const object = a[0] ?? 0;
      const stream = this.streams.get(object);
      if (!stream) return { eax: 0x8003_0008 };
      switch (method) {
        case 'QueryInterface':
          return this.queryStreamInterface(object, stream, a[1] ?? 0, a[2] ?? 0);
        case 'AddRef':
          return { eax: ++stream.refs };
        case 'Release':
          stream.refs = Math.max(0, stream.refs - 1);
          if (!stream.refs) this.streams.delete(object);
          return { eax: stream.refs };
        case 'Read': {
          const bytes = stream.storage.streams.get(stream.name) ?? new Uint8Array();
          const count = Math.min(a[2] ?? 0, Math.max(0, bytes.length - stream.position));
          if (count && a[1]) this.memory.write_memory(bytes.subarray(stream.position, stream.position + count), a[1]);
          stream.position += count;
          if (a[3]) this.writeU32(a[3], count);
          return { eax: count === (a[2] ?? 0) ? 0 : 1 }; // S_OK / S_FALSE
        }
        case 'Write': {
          const count = (a[2] ?? 0) >>> 0;
          const old = stream.storage.streams.get(stream.name) ?? new Uint8Array();
          const end = stream.position + count;
          if (shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
            console.log(
              `[VM OLE] IStream.Write ${stream.storage.path}/${stream.name} pos=${stream.position} count=${count} end=${end} old=${old.length}`,
            );
          }
          if (stream.position > MAX_OLE_STREAM_BYTES || count > MAX_OLE_STREAM_BYTES - stream.position) {
            if (a[3]) this.writeU32(a[3], 0);
            return { eax: 0x8003_0070 }; // STG_E_MEDIUMFULL
          }
          let capacity = stream.storage.streamCapacities.get(stream.name) ?? old;
          if (end > capacity.length) {
            const grown = new Uint8Array(Math.max(end, 4096, capacity.length * 2));
            grown.set(old);
            capacity = grown;
          }
          const logicalLength = Math.max(old.length, end);
          if (count && a[1]) capacity.set(this.readBytes(a[1], count), stream.position);
          stream.storage.streamCapacities.set(stream.name, capacity);
          stream.storage.streams.set(stream.name, capacity.subarray(0, logicalLength));
          stream.position = end;
          if (a[3]) this.writeU32(a[3], count);
          return { eax: 0 };
        }
        case 'Seek': {
          const low = a[1] ?? 0;
          const high = a[2] ?? 0;
          const signed = high === 0xffff_ffff ? low - 0x1_0000_0000 : low;
          const size = stream.storage.streams.get(stream.name)?.length ?? 0;
          const origin = a[3] ?? 0;
          const base = origin === 1 ? stream.position : origin === 2 ? size : 0;
          stream.position = Math.max(0, base + signed);
          if (shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
            console.log(
              `[VM OLE] IStream.Seek ${stream.storage.path}/${stream.name} origin=${origin} low=0x${(low >>> 0).toString(16)} high=0x${(high >>> 0).toString(16)} ->${stream.position}`,
            );
          }
          if (a[4]) {
            this.writeU32(a[4], stream.position);
            this.writeU32(a[4] + 4, 0);
          }
          return { eax: 0 };
        }
        case 'SetSize': {
          if (a[2]) return { eax: 0x8003_0070 }; // STG_E_MEDIUMFULL（>4GiB）
          const size = (a[1] ?? 0) >>> 0;
          if (shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
            console.log(
              `[VM OLE] IStream.SetSize ${stream.storage.path}/${stream.name} size=${size} high=${a[2] ?? 0}`,
            );
          }
          if (size > MAX_OLE_STREAM_BYTES) return { eax: 0x8003_0070 };
          const old = stream.storage.streams.get(stream.name) ?? new Uint8Array();
          let capacity = stream.storage.streamCapacities.get(stream.name) ?? old;
          if (size > capacity.length) {
            const grown = new Uint8Array(Math.max(size, 4096, capacity.length * 2));
            grown.set(old);
            capacity = grown;
          } else if (size > old.length) {
            // A stream expanded after a prior shrink must expose zero-filled bytes.
            capacity.fill(0, old.length, size);
          }
          stream.storage.streamCapacities.set(stream.name, capacity);
          stream.storage.streams.set(stream.name, capacity.subarray(0, size));
          if (stream.position > size) stream.position = size;
          return { eax: 0 };
        }
        case 'Commit':
          this.commitStorage(stream.storage);
          return { eax: 0 };
        case 'Stat':
          if (!a[1]) return { eax: 0x8000_4003 };
          this.zero(a[1], 72);
          this.writeU32(a[1] + 4, 2); // STGTY_STREAM
          this.writeU32(a[1] + 8, stream.storage.streams.get(stream.name)?.length ?? 0);
          return { eax: 0 };
        case 'Revert':
        case 'LockRegion':
        case 'UnlockRegion':
          return { eax: 0 };
        default:
          return { eax: 0x8003_0001 };
      }
    }

    private queryStorageInterface(
      object: number,
      storage: OleStorageState,
      iidPointer: number,
      output: number,
    ): Win32Result {
      if (!output) return { eax: 0x8000_4003 }; // E_POINTER
      this.writeU32(output, 0);
      if (!iidPointer) return { eax: 0x8000_4003 };
      const iid = formatGuid(this.readBytes(iidPointer, 16));
      if (iid === IID_IUNKNOWN || iid === IID_ISTORAGE) {
        storage.refs++;
        this.writeU32(output, object);
        return { eax: 0 };
      }
      if (iid === IID_IPROPERTYSETSTORAGE) {
        this.writeU32(output, this.createPropertySetStorageObject(storage));
        return { eax: 0 };
      }
      return { eax: 0x8000_4002 }; // E_NOINTERFACE
    }

    private queryStreamInterface(
      object: number,
      stream: OleStreamState,
      iidPointer: number,
      output: number,
    ): Win32Result {
      if (!output) return { eax: 0x8000_4003 };
      this.writeU32(output, 0);
      if (!iidPointer) return { eax: 0x8000_4003 };
      const iid = formatGuid(this.readBytes(iidPointer, 16));
      if (iid !== IID_IUNKNOWN && iid !== IID_ISTREAM) return { eax: 0x8000_4002 };
      stream.refs++;
      this.writeU32(output, object);
      return { eax: 0 };
    }

    private dispatchPropertySetStorage(method: string, a: number[]): Win32Result {
      const object = a[0] ?? 0;
      const wrapper = this.propertySetStorages.get(object);
      if (!wrapper) return { eax: 0x8003_0008 }; // STG_E_INVALIDHANDLE
      switch (method) {
        case 'QueryInterface': {
          const output = a[2] ?? 0;
          if (!output) return { eax: 0x8000_4003 };
          this.writeU32(output, 0);
          if (!a[1]) return { eax: 0x8000_4003 };
          const iid = formatGuid(this.readBytes(a[1], 16));
          if (iid !== IID_IUNKNOWN && iid !== IID_IPROPERTYSETSTORAGE) return { eax: 0x8000_4002 };
          wrapper.refs++;
          this.writeU32(output, object);
          return { eax: 0 };
        }
        case 'AddRef':
          return { eax: ++wrapper.refs };
        case 'Release':
          wrapper.refs = Math.max(0, wrapper.refs - 1);
          if (!wrapper.refs) this.propertySetStorages.delete(object);
          return { eax: wrapper.refs };
        case 'Create': {
          const output = a[5] ?? 0;
          if (!a[1] || !output) return { eax: 0x8000_4003 };
          this.writeU32(output, 0);
          const fmtid = this.readBytes(a[1], 16).slice();
          const key = formatGuid(fmtid);
          const propertySet: OlePropertySetState = { fmtid };
          wrapper.storage.propertySets.set(key, propertySet);
          this.writeU32(output, this.createPropertyStorageObject(propertySet));
          return { eax: 0 };
        }
        case 'Open': {
          const output = a[3] ?? 0;
          if (!a[1] || !output) return { eax: 0x8000_4003 };
          this.writeU32(output, 0);
          const propertySet = wrapper.storage.propertySets.get(formatGuid(this.readBytes(a[1], 16)));
          if (!propertySet) return { eax: 0x8003_0002 }; // STG_E_FILENOTFOUND
          this.writeU32(output, this.createPropertyStorageObject(propertySet));
          return { eax: 0 };
        }
        case 'Delete':
          if (!a[1]) return { eax: 0x8000_4003 };
          return { eax: wrapper.storage.propertySets.delete(formatGuid(this.readBytes(a[1], 16))) ? 0 : 0x8003_0002 };
        case 'Enum':
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: 0x8000_4001 }; // E_NOTIMPL
        default:
          return { eax: 0x8003_0001 };
      }
    }

    private dispatchPropertyStorage(method: string, a: number[]): Win32Result {
      const object = a[0] ?? 0;
      const wrapper = this.propertyStorages.get(object);
      if (!wrapper) return { eax: 0x8003_0008 };
      switch (method) {
        case 'QueryInterface': {
          const output = a[2] ?? 0;
          if (!output) return { eax: 0x8000_4003 };
          this.writeU32(output, 0);
          if (!a[1]) return { eax: 0x8000_4003 };
          const iid = formatGuid(this.readBytes(a[1], 16));
          if (iid !== IID_IUNKNOWN && iid !== IID_IPROPERTYSTORAGE) return { eax: 0x8000_4002 };
          wrapper.refs++;
          this.writeU32(output, object);
          return { eax: 0 };
        }
        case 'AddRef':
          return { eax: ++wrapper.refs };
        case 'Release':
          wrapper.refs = Math.max(0, wrapper.refs - 1);
          if (!wrapper.refs) this.propertyStorages.delete(object);
          return { eax: wrapper.refs };
        case 'ReadMultiple': {
          const count = a[1] ?? 0;
          const values = a[3] ?? 0;
          if (count && (!a[2] || !values)) return { eax: 0x8000_4003 };
          if (values) this.zero(values, count * 16); // VT_EMPTY
          return { eax: count ? 1 : 0 }; // S_FALSE / S_OK
        }
        case 'ReadPropertyNames': {
          const count = a[1] ?? 0;
          const names = a[3] ?? 0;
          if (count && (!a[2] || !names)) return { eax: 0x8000_4003 };
          if (names) this.zero(names, count * 4);
          return { eax: count ? 1 : 0 };
        }
        case 'Enum':
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: 0x8000_4001 };
        case 'Stat':
          if (!a[1]) return { eax: 0x8000_4003 };
          this.zero(a[1], 64);
          this.memory.write_memory(wrapper.propertySet.fmtid, a[1]);
          return { eax: 0 };
        case 'WriteMultiple':
        case 'DeleteMultiple':
        case 'WritePropertyNames':
        case 'DeletePropertyNames':
        case 'Commit':
        case 'Revert':
        case 'SetTimes':
        case 'SetClass':
          return { eax: 0 };
        default:
          return { eax: 0x8003_0001 };
      }
    }

    private commitStorage(storage: OleStorageState): void {
      const encoded = this.encodeStorage(storage);
      this.storeFile(storage.path, encoded);
      this.notifyFileWrite(storage.path, encoded);
    }

    private encodeStorage(storage: OleStorageState): Uint8Array {
      const encoder = new TextEncoder();
      const entries = [...storage.streams].map(([name, bytes]) => ({ name: encoder.encode(name), bytes }));
      const size =
        STORAGE_MAGIC.length + 4 + entries.reduce((sum, item) => sum + 8 + item.name.length + item.bytes.length, 0);
      const result = new Uint8Array(size);
      result.set(STORAGE_MAGIC);
      const view = new DataView(result.buffer);
      let offset = STORAGE_MAGIC.length;
      view.setUint32(offset, entries.length, true);
      offset += 4;
      for (const item of entries) {
        view.setUint32(offset, item.name.length, true);
        view.setUint32(offset + 4, item.bytes.length, true);
        offset += 8;
        result.set(item.name, offset);
        offset += item.name.length;
        result.set(item.bytes, offset);
        offset += item.bytes.length;
      }
      return result;
    }

    private decodeStorage(path: string, bytes: Uint8Array): OleStorageState | undefined {
      if (bytes.length < STORAGE_MAGIC.length + 4 || !STORAGE_MAGIC.every((byte, index) => bytes[index] === byte))
        return undefined;
      try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = STORAGE_MAGIC.length;
        const count = view.getUint32(offset, true);
        offset += 4;
        const streams = new Map<string, Uint8Array>();
        for (let index = 0; index < count; index++) {
          const nameLength = view.getUint32(offset, true);
          const dataLength = view.getUint32(offset + 4, true);
          offset += 8;
          if (offset + nameLength + dataLength > bytes.length) return undefined;
          const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));
          offset += nameLength;
          streams.set(name, bytes.slice(offset, offset + dataLength));
          offset += dataLength;
        }
        return {
          path,
          refs: 1,
          streams,
          streamCapacities: new Map(streams),
          propertySets: new Map(),
        };
      } catch {
        return undefined;
      }
    }

    private readOleWideString(pointer: number, limit = 1023): string {
      let value = '';
      for (let index = 0; index < limit; index++) {
        const code = this.readU16(pointer + index * 2);
        if (!code) break;
        value += String.fromCharCode(code);
      }
      return value;
    }

    /**
     * OleSaveToStream 不是简单的成功桩：RA2 传入的 IPersistStream 是客体
     * C++ COM 对象。借导入桩返回地址串起 GetClassID、IStream::Write 和
     * IPersistStream::Save，让客体对象仍按原版 vtable 执行，同时宿主 IStream
     * 继续通过动态 Win32 桩落入上面的存储实现。
     */
    private redirectOleSaveToStream(call: Win32Call, persistStream: number, stream: number): void {
      const originalReturn = this.readU32(call.stack);
      const clsid = this.alloc(16, true);
      const written = this.alloc(4, true);
      const code: number[] = [];
      const emit32 = (value: number) =>
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      const push = (value: number) => {
        code.push(0x68);
        emit32(value);
      };
      const failurePatches: number[] = [];
      const jumpIfFailed = () => {
        code.push(0x85, 0xc0); // test eax,eax
        code.push(0x0f, 0x88, 0, 0, 0, 0); // js finish
        failurePatches.push(code.length - 4);
      };

      // persistStream->GetClassID(&clsid)
      push(clsid);
      push(persistStream);
      code.push(0xb9);
      emit32(persistStream);
      code.push(0x8b, 0x11, 0xff, 0x52, 0x0c);
      jumpIfFailed();

      // WriteClassStm 的有效载荷就是 16-byte CLSID。
      push(written);
      push(16);
      push(clsid);
      push(stream);
      code.push(0xb9);
      emit32(stream);
      code.push(0x8b, 0x11, 0xff, 0x52, 0x10); // IStream::Write
      jumpIfFailed();

      // persistStream->Save(stream, TRUE)
      push(1);
      push(stream);
      push(persistStream);
      code.push(0xb9);
      emit32(persistStream);
      code.push(0x8b, 0x11, 0xff, 0x52, 0x18);

      const finish = code.length;
      code.push(0xb9);
      emit32(originalReturn);
      code.push(0xff, 0xe1);
      for (const patch of failurePatches) {
        const relative = finish - (patch + 4);
        code[patch] = relative & 0xff;
        code[patch + 1] = (relative >>> 8) & 0xff;
        code[patch + 2] = (relative >>> 16) & 0xff;
        code[patch + 3] = relative >>> 24;
      }
      this.writeU32(call.stack, this.allocateDynamicCode(code));
    }
    protected redirectGuestCoCreate(
      call: Win32Call,
      getClassObject: number,
      rclsid: number,
      outer: number,
      riid: number,
      ppv: number,
    ): void {
      const factory = this.alloc(4, true);
      const iidClassFactory = this.alloc(16, true);
      // IID_IClassFactory = {00000001-0000-0000-C000-000000000046}（内存字节序）。
      this.memory.write_memory([1, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46], iidClassFactory);
      const originalReturn = this.readU32(call.stack);
      const code: number[] = [];
      const emit32 = (value: number) =>
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      const push = (value: number) => {
        code.push(0x68);
        emit32(value);
      };
      push(factory);
      push(iidClassFactory);
      push(rclsid);
      code.push(0xb8);
      emit32(getClassObject);
      code.push(0xff, 0xd0); // DllGetClassObject(rclsid, IID_IClassFactory, &factory)
      code.push(0x85, 0xc0, 0x0f, 0x88, 0, 0, 0, 0); // test eax,eax; js finish
      const failedPatch = code.length - 4;
      code.push(0x8b, 0x0d);
      emit32(factory); // mov ecx,[factory]
      code.push(0x85, 0xc9, 0x0f, 0x84, 0, 0, 0, 0); // jz finish
      const emptyPatch = code.length - 4;
      push(ppv);
      push(riid);
      push(outer);
      code.push(0x51, 0x8b, 0x11, 0xff, 0x52, 0x0c); // factory->CreateInstance
      code.push(0x50); // 保存 HRESULT
      code.push(0x8b, 0x0d);
      emit32(factory);
      code.push(0x51, 0x8b, 0x11, 0xff, 0x52, 0x08); // factory->Release
      code.push(0x58); // 恢复 CreateInstance HRESULT
      const finish = code.length;
      code.push(0xb9);
      emit32(originalReturn);
      code.push(0xff, 0xe1);
      for (const patch of [failedPatch, emptyPatch]) {
        const relative = finish - (patch + 4);
        code[patch] = relative & 0xff;
        code[patch + 1] = (relative >>> 8) & 0xff;
        code[patch + 2] = (relative >>> 16) & 0xff;
        code[patch + 3] = relative >>> 24;
      }
      this.writeU32(call.stack, this.allocateDynamicCode(code));
    }

    /**
     * import stub 执行 ret 20 后落入这段桥，直接调用客体 IClassFactory vtable。
     * 此时 CoCreateInstance 的参数已由 stdcall 清理，所以最后必须跳回原返回地址，
     * 同时原样保留 CreateInstance 的 HRESULT。
     */
    protected redirectRegisteredCoCreate(
      call: Win32Call,
      factory: number,
      outer: number,
      riid: number,
      ppv: number,
    ): void {
      const originalReturn = this.readU32(call.stack);
      const code: number[] = [];
      const emit32 = (value: number) =>
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      const push = (value: number) => {
        code.push(0x68);
        emit32(value);
      };
      push(ppv);
      push(riid);
      push(outer);
      push(factory);
      code.push(0xb9);
      emit32(factory); // mov ecx,factory
      code.push(0x8b, 0x11); // mov edx,[ecx]
      code.push(0xff, 0x52, 0x0c); // call [edx+12] (IClassFactory::CreateInstance)
      code.push(0xb9);
      emit32(originalReturn);
      code.push(0xff, 0xe1); // jmp originalReturn
      this.writeU32(call.stack, this.allocateDynamicCode(code));
    }
  };
}
