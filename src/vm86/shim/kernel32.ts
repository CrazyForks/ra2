import type { FileState, Win32Call, Win32Result } from '../win32';
import type { Constructor } from './state';
import type { ShimGraphicsChain } from './stateGraphics';
import {
  DRIVE_CDROM,
  DRIVE_NO_ROOT_DIR,
  FAST_FILE_ENTRY_BYTES,
  FAST_FILE_HANDLE_BASE,
  FAST_FILE_TABLE,
  FAST_FILE_TABLE_ENTRIES,
  FAST_TLS_ENTRIES,
  FAST_TLS_TABLE,
  FAST_TLS_THREAD_BYTES,
  GUEST_PROCESS_ID,
  shimTraceEnabled,
} from './state';
import {
  GUEST_THREAD_RUN_STATES,
  HYPERCALL_THREAD_COUNT,
  HYPERCALL_THREAD_CURRENT,
  GUEST_THREAD_CONTEXT_ESPS,
  GUEST_THREAD_CONTEXT_LAST_ERROR,
  GUEST_THREAD_CONTEXT_SEH,
  GUEST_THREAD_CONTEXT_STACK_BOTTOM,
  GUEST_THREAD_CONTEXT_STACK_TOP,
  GUEST_THREAD_LIMIT,
} from '../pe';
import { normalizeGuestPath } from '../paths';
import { guestFileSearch, type GuestFileEntry } from './fileSearch';

/** Kernel32 的 Win32 API case（原 Win32Shim.dispatch 主 switch 拆分）。 */
export function withKernel32<TBase extends Constructor<ShimGraphicsChain>>(Base: TBase) {
  return class extends Base {
    private dllGetVersionStub = 0;
    private readonly fileSearchListings = new Map<string, readonly GuestFileEntry[]>();
    private readonly fileSearchHandles = new Map<number, { entries: GuestFileEntry[]; index: number }>();
    private nextFileSearchHandle = 0x6100_0000;

    /** host 提供目录快照，不把元数据占位挂成空文件；每次搜索更新，避免漏掉新存档。 */
    setFileSearchResults(pattern: string, entries: readonly GuestFileEntry[]): void {
      this.fileSearchListings.set(
        normalizeGuestPath(pattern),
        entries.map((entry) => ({ ...entry })),
      );
    }

    private writeFindData(address: number, entry: GuestFileEntry): void {
      this.zero(address, 320); // WIN32_FIND_DATAA，cFileName 从偏移 44 开始
      this.writeU32(address, entry.directory ? 0x10 : 0x20);
      const times = this.fileTimes.get(normalizeGuestPath(entry.path));
      for (const [offset, time] of [
        [4, times?.created],
        [12, times?.accessed],
        [20, times?.written],
      ] as const) {
        this.writeU32(address + offset, Number((time ?? 0n) & 0xffff_ffffn));
        this.writeU32(address + offset + 4, Number((time ?? 0n) >> 32n));
      }
      this.writeU32(address + 28, Math.floor(entry.size / 0x1_0000_0000));
      this.writeU32(address + 32, entry.size >>> 0);
      const name = entry.path.replace(/\\/g, '/').split('/').at(-1)!;
      // 原生 A 接口保留单字节文件名；游戏扩展包及存档使用 ASCII 名称。
      this.memory.write_memory(
        Uint8Array.from(name.slice(0, 259), (c) => c.charCodeAt(0) & 0xff),
        address + 44,
      );
    }
    constructor(...args: any[]) {
      super(...args);
    }

    dispatchKernel32(call: Win32Call, key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'KERNEL32.DLL!HeapCreate':
          return { eax: 0x10001 };
        case 'KERNEL32.DLL!HeapDestroy':
          return { eax: 1 };
        case 'KERNEL32.DLL!HeapAlloc':
          return { eax: this.alloc(a[2] ?? 0, ((a[1] ?? 0) & 8) !== 0) };
        case 'KERNEL32.DLL!HeapReAlloc':
          return { eax: this.realloc(a[2] ?? 0, a[3] ?? 0, ((a[1] ?? 0) & 8) !== 0) };
        case 'KERNEL32.DLL!HeapFree':
          return { eax: this.freeAllocation(a[2] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!HeapSize': {
          const size = this.allocations.get(a[2] ?? 0);
          if (size === undefined) {
            this.lastError = 87; // ERROR_INVALID_PARAMETER
            return { eax: 0xffff_ffff }; // (SIZE_T)-1
          }
          return { eax: size };
        }
        case 'KERNEL32.DLL!GlobalAlloc':
          return { eax: this.alloc(a[1] ?? 0, ((a[0] ?? 0) & 0x40) !== 0) };
        case 'KERNEL32.DLL!GlobalFree':
          return { eax: this.freeAllocation(a[0] ?? 0) ? 0 : (a[0] ?? 0) };
        case 'KERNEL32.DLL!GlobalLock':
        case 'KERNEL32.DLL!GlobalHandle':
          return { eax: a[0] ?? 0 };
        case 'KERNEL32.DLL!GlobalUnlock':
          return { eax: 1 };
        case 'KERNEL32.DLL!GlobalMemoryStatus': {
          const status = a[0] ?? 0;
          if (status) {
            this.zero(status, 32);
            this.writeU32(status, 32);
            this.writeU32(status + 4, 25); // dwMemoryLoad
            this.writeU32(status + 8, 256 * 1024 * 1024);
            this.writeU32(status + 12, 192 * 1024 * 1024);
            this.writeU32(status + 16, 512 * 1024 * 1024);
            this.writeU32(status + 20, 384 * 1024 * 1024);
            this.writeU32(status + 24, 0x7fff_ffff);
            this.writeU32(status + 28, 0x7000_0000);
          }
          return { eax: 0 };
        }
        case 'KERNEL32.DLL!VirtualAlloc':
          return { eax: this.virtualAlloc(a[0] ?? 0, a[1] ?? 0) };
        case 'KERNEL32.DLL!VirtualFree':
          return { eax: this.virtualFree(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!GetVersion':
          // Windows 98 4.10；高位为 1 表示 Win9x，与游戏的 2001 年运行环境一致。
          return { eax: 0x8000_0a04 };
        case 'KERNEL32.DLL!GetVersionExA': {
          const info = a[0] ?? 0;
          if (!info) return { eax: 0 };
          const size = this.readU32(info);
          if (size < 148) return { eax: 0 };
          this.zero(info, Math.min(size, 156));
          this.writeU32(info, size);
          this.writeU32(info + 4, 4); // Windows 98: major 4
          this.writeU32(info + 8, 10);
          this.writeU32(info + 12, 2222);
          this.writeU32(info + 16, 1); // VER_PLATFORM_WIN32_WINDOWS
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetTickCount':
          return { eax: this.clock.now() >>> 0 };
        case 'KERNEL32.DLL!QueryPerformanceFrequency':
          // 与客体统一毫秒时钟同源，1 tick = 1ms。
          if (a[0]) {
            this.writeU32(a[0], 1000);
            this.writeU32(a[0] + 4, 0);
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!QueryPerformanceCounter': {
          const value = BigInt(Math.max(0, Math.floor(this.clock.now())));
          if (a[0]) {
            this.writeU32(a[0], Number(value & 0xffff_ffffn));
            this.writeU32(a[0] + 4, Number(value >> 32n));
          }
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetDriveTypeA':
          return { eax: this.getDriveType(a[0] ?? 0) };
        case 'KERNEL32.DLL!GetLogicalDriveStringsA': {
          const drives =
            [...this.driveTypes.keys()]
              .sort()
              .map((letter) => `${letter}:\\\0`)
              .join('') + '\0';
          const required = drives.length - 1;
          if ((a[0] ?? 0) >= required && a[1]) {
            this.memory.write_memory(new TextEncoder().encode(drives), a[1]);
          }
          return { eax: required };
        }
        case 'KERNEL32.DLL!GetDiskFreeSpaceA': {
          const cdrom = this.getDriveType(a[0] ?? 0) === DRIVE_CDROM;
          // 只读 CD-ROM 没有可写簇。RA2 会据此继续查询卷标/序列号；
          // 把光驱伪装成有空闲空间的硬盘会走入原版 AutoDet 防盗版路径。
          if (a[1]) this.writeU32(a[1], cdrom ? 1 : 8); // sectors / cluster
          if (a[2]) this.writeU32(a[2], cdrom ? 2048 : 512);
          if (a[3]) this.writeU32(a[3], cdrom ? 0 : 0x0010_0000);
          if (a[4]) this.writeU32(a[4], cdrom ? 300_000 : 0x0020_0000);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetVolumeInformationA': {
          const cdrom = this.getDriveType(a[0] ?? 0) === DRIVE_CDROM;
          const writeString = (pointer: number, capacity: number, value: string) => {
            if (!pointer || capacity <= 0) return;
            const bytes = new TextEncoder().encode(value.slice(0, Math.max(0, capacity - 1)));
            this.memory.write_memory(Uint8Array.from([...bytes, 0]), pointer);
          };
          writeString(a[1] ?? 0, a[2] ?? 0, cdrom ? (this.gameProfile.cdromVolumeLabel ?? 'CDROM') : 'GAME');
          if (a[3]) this.writeU32(a[3], (this.options.volumeSerial ?? 0x2001_0701) >>> 0);
          if (a[4]) this.writeU32(a[4], 255);
          if (a[5]) this.writeU32(a[5], 0);
          writeString(a[6] ?? 0, a[7] ?? 0, cdrom ? 'CDFS' : 'FAT32');
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!SetCurrentDirectoryA': {
          const path = this.readCString(a[0] ?? 0);
          if (!path) return { eax: 0 };
          this.currentDirectory = path.replace(/[\\/]+$/, '') || 'C:\\';
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetCurrentDirectoryA': {
          const required = this.currentDirectory.length;
          const capacity = a[0] ?? 0;
          if (a[1] && capacity > required) this.writeAscii(a[1], this.currentDirectory);
          return { eax: capacity > required ? required : required + 1 };
        }
        case 'KERNEL32.DLL!GetComputerNameA': {
          const name = 'BROWSER-PC';
          const capacity = a[1] ? this.readU32(a[1]) : 0;
          if (capacity <= name.length) {
            if (a[1]) this.writeU32(a[1], name.length + 1);
            return { eax: 0 };
          }
          if (a[0]) this.writeAscii(a[0], name);
          if (a[1]) this.writeU32(a[1], name.length);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetSystemTime':
          this.writeSystemTime(a[0] ?? 0, false);
          return { eax: 0 };
        case 'KERNEL32.DLL!GetLocalTime':
          // SYSTEMTIME 是 8 个连续 WORD。这里必须使用宿主本地时区；RA2 会在
          // 首页初始化时直接调用该接口，不能用 UTC 的 GetSystemTime 语义代替。
          this.writeSystemTime(a[0] ?? 0, true);
          return { eax: 0 };
        case 'KERNEL32.DLL!SystemTimeToFileTime':
          return { eax: this.systemTimeToFileTime(a[0] ?? 0, a[1] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!GetTimeZoneInformation': {
          const info = a[0] ?? 0;
          if (!info) {
            this.lastError = 87; // ERROR_INVALID_PARAMETER
            return { eax: 0xffff_ffff }; // TIME_ZONE_ID_INVALID
          }
          // TIME_ZONE_INFORMATION 共 172 字节。JavaScript 不提供 Windows 式的
          // SYSTEMTIME 夏令时转换表，因此报告合法的 TIME_ZONE_ID_UNKNOWN，并
          // 把当前宿主偏移写入 Bias。Bias 的符号与 getTimezoneOffset 一致：
          // UTC = local + Bias。
          this.zero(info, 172);
          this.writeU32(info, new Date(this.clock.wallNow()).getTimezoneOffset() | 0);
          this.lastError = 0;
          return { eax: 0 }; // TIME_ZONE_ID_UNKNOWN
        }
        case 'KERNEL32.DLL!CreateFileA':
          return { eax: this.openFile(a) };
        case 'KERNEL32.DLL!FindFirstFileA': {
          if (!a[0] || !a[1]) {
            this.lastError = 87;
            return { eax: 0xffff_ffff };
          }
          const search = guestFileSearch(this.readCString(a[0]));
          const entries = new Map<string, GuestFileEntry>();
          for (const entry of this.fileSearchListings.get(search.normalized) ?? []) {
            entries.set(normalizeGuestPath(entry.path), entry);
          }
          // 大只读档案镜像到客体后会释放 JS 内容快照，但仍是可枚举的现存文件。
          for (const [path, mirror] of this.sharedFileMirrors) {
            entries.set(path, { path, size: mirror.size });
          }
          // 同步层新建/修改的文件覆盖 provider 元数据，已开始的搜索保持独立快照。
          for (const [path, bytes] of this.files) {
            entries.set(path, { path, size: this.fileLogicalSizes.get(path) ?? bytes.length });
          }
          const matched = [...entries.values()]
            .filter((entry) => {
              const path = normalizeGuestPath(entry.path);
              const slash = path.lastIndexOf('/');
              return (
                (slash < 0 ? '' : path.slice(0, slash)) === search.directory && search.matches(path.slice(slash + 1))
              );
            })
            .sort((a, b) => normalizeGuestPath(a.path).localeCompare(normalizeGuestPath(b.path)));
          if (!matched.length) {
            this.lastError = 2;
            return { eax: 0xffff_ffff };
          }
          const handle = this.nextFileSearchHandle++;
          this.fileSearchHandles.set(handle, { entries: matched, index: 0 });
          this.writeFindData(a[1], matched[0]!);
          this.lastError = 0;
          return { eax: handle };
        }
        case 'KERNEL32.DLL!FindNextFileA': {
          const search = this.fileSearchHandles.get(a[0] ?? 0);
          if (!search) {
            this.lastError = 6;
            return { eax: 0 };
          }
          if (!a[1]) {
            this.lastError = 87;
            return { eax: 0 };
          }
          const entry = search.entries[search.index + 1];
          if (!entry) {
            this.lastError = 18;
            return { eax: 0 };
          }
          search.index++;
          this.writeFindData(a[1], entry);
          this.lastError = 0;
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!FindClose': {
          const closed = this.fileSearchHandles.delete(a[0] ?? 0);
          this.lastError = closed ? 0 : 6;
          return { eax: closed ? 1 : 0 };
        }
        case 'KERNEL32.DLL!FindResourceA': {
          const resource = this.findPeResource(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
          if (!resource) {
            this.lastError = 1813; // ERROR_RESOURCE_TYPE_NOT_FOUND
            return { eax: 0 };
          }
          this.loadedResources.set(resource.handle, resource);
          this.lastError = 0;
          return { eax: resource.handle };
        }
        case 'KERNEL32.DLL!LoadResource': {
          const handle = a[1] ?? 0;
          if (!this.loadedResources.has(handle)) {
            this.lastError = 1812; // ERROR_RESOURCE_DATA_NOT_FOUND
            return { eax: 0 };
          }
          return { eax: handle };
        }
        case 'KERNEL32.DLL!LockResource':
          return { eax: this.loadedResources.get(a[0] ?? 0)?.data ?? 0 };
        case 'KERNEL32.DLL!ReadFile':
          return { eax: this.readFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) >= 0 ? 1 : 0 };
        case 'KERNEL32.DLL!GetFileSize': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file) return { eax: 0xffff_ffff };
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: file.size >>> 0 };
        }
        case 'KERNEL32.DLL!SetFilePointer':
          return { eax: this.seekFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
        case 'KERNEL32.DLL!SetEndOfFile': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file || !file.writable) return { eax: 0 };
          this.demoteFileMirror(a[0] ?? 0, file);
          file.size = file.position;
          this.storeFile(file.path, file.bytes.subarray(0, file.size));
          file.dirty = true;
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!_lopen':
          return { eax: this.openLegacyFile(a[0] ?? 0, false, a[1] ?? 0) };
        case 'KERNEL32.DLL!_lcreat':
          return { eax: this.openLegacyFile(a[0] ?? 0, true) };
        case 'KERNEL32.DLL!_lread':
          return { eax: this.readFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, 0) };
        case 'KERNEL32.DLL!_lwrite':
          return { eax: this.writeFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, 0) };
        case 'KERNEL32.DLL!_llseek':
          return { eax: this.seekFile(a[0] ?? 0, a[1] ?? 0, 0, a[2] ?? 0) };
        case 'KERNEL32.DLL!_lclose':
          return { eax: this.closeFile(a[0] ?? 0) ? 0 : 0xffff_ffff };
        case 'KERNEL32.DLL!GetModuleHandleA':
          return { eax: 0x0040_0000 };
        case 'KERNEL32.DLL!LoadLibraryA':
          return this.loadLibrary(call, a[0] ?? 0);
        case 'KERNEL32.DLL!FreeLibrary':
          return { eax: 1 };
        case 'KERNEL32.DLL!GetProcAddress':
          return { eax: this.getGuestProcAddress(a[0] ?? 0, a[1] ?? 0) };
        case 'KERNEL32.DLL!GetCommandLineA':
          return { eax: this.commandLine };
        case 'KERNEL32.DLL!GetModuleFileNameA': {
          const max = a[2] ?? 0;
          const bytes = this.readBytes(this.modulePath, 260);
          const length = Math.min(bytes.indexOf(0), Math.max(0, max - 1));
          if (a[1] && max > 0) this.memory.write_memory(bytes.subarray(0, length + 1), a[1]);
          return { eax: length };
        }
        case 'KERNEL32.DLL!GetStartupInfoA':
          if (a[0]) {
            this.zero(a[0], 68);
            this.writeU32(a[0], 68);
          }
          return { eax: 0 };
        case 'KERNEL32.DLL!GetACP':
        case 'KERNEL32.DLL!GetOEMCP':
          return { eax: 950 }; // Big5
        case 'KERNEL32.DLL!GetCPInfo':
          if (a[1]) {
            this.zero(a[1], 20);
            this.writeU32(a[1], 2); // MaxCharSize
            this.memory.write_memory([0x3f, 0x00], a[1] + 4);
            this.memory.write_memory([0x81, 0xfe, 0, 0], a[1] + 6);
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!GetEnvironmentStrings':
          return { eax: this.environmentA };
        case 'KERNEL32.DLL!GetEnvironmentStringsW':
          return { eax: this.environmentW };
        case 'KERNEL32.DLL!GetEnvironmentVariableA': {
          const name = this.readCString(a[0] ?? 0).toLowerCase();
          const values: Record<string, string> = {
            windir: 'C:\\WINDOWS',
            systemroot: 'C:\\WINDOWS',
            temp: 'C:\\WINDOWS\\TEMP',
            tmp: 'C:\\WINDOWS\\TEMP',
          };
          const value = values[name];
          if (value === undefined) {
            this.lastError = 203; // ERROR_ENVVAR_NOT_FOUND
            return { eax: 0 };
          }
          const capacity = a[2] ?? 0;
          if (capacity <= value.length) return { eax: value.length + 1 };
          if (a[1]) this.writeAscii(a[1], value);
          this.lastError = 0;
          return { eax: value.length };
        }
        case 'KERNEL32.DLL!SetErrorMode':
          return { eax: 0 };
        case 'KERNEL32.DLL!GetSystemDirectoryA':
        case 'KERNEL32.DLL!GetWindowsDirectoryA': {
          const value = key.endsWith('GetSystemDirectoryA') ? 'C:\\WINDOWS\\SYSTEM' : 'C:\\WINDOWS';
          const capacity = a[1] ?? 0;
          if (capacity <= value.length) return { eax: value.length + 1 };
          if (a[0]) this.writeAscii(a[0], value);
          return { eax: value.length };
        }
        case 'KERNEL32.DLL!FreeEnvironmentStringsA':
        case 'KERNEL32.DLL!FreeEnvironmentStringsW':
          return { eax: 1 };
        case 'KERNEL32.DLL!GetLastError':
          return { eax: this.lastError };
        case 'KERNEL32.DLL!SetLastError':
          this.lastError = a[0] ?? 0;
          return { eax: 0 };
        case 'KERNEL32.DLL!TlsAlloc': {
          const id = this.nextTls++;
          this.tls.set(id, 0);
          const thread = this.readU32(0x0006_0068);
          if (id < FAST_TLS_ENTRIES) this.writeU32(FAST_TLS_TABLE + thread * 256 + id * 4, 0);
          return { eax: id };
        }
        case 'KERNEL32.DLL!TlsFree':
          return { eax: this.tls.delete(a[0] ?? -1) ? 1 : 0 };
        case 'KERNEL32.DLL!TlsSetValue':
          this.tls.set(a[0] ?? 0, a[1] ?? 0);
          if ((a[0] ?? FAST_TLS_ENTRIES) < FAST_TLS_ENTRIES) {
            const thread = this.readU32(0x0006_0068);
            this.writeU32(FAST_TLS_TABLE + thread * 256 + (a[0] ?? 0) * 4, a[1] ?? 0);
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!TlsGetValue':
          return {
            eax:
              (a[0] ?? FAST_TLS_ENTRIES) < FAST_TLS_ENTRIES
                ? this.readU32(FAST_TLS_TABLE + this.readU32(0x0006_0068) * 256 + (a[0] ?? 0) * 4)
                : (this.tls.get(a[0] ?? 0) ?? 0),
          };
        case 'KERNEL32.DLL!InitializeCriticalSection':
          if (a[0]) this.initializeCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!DeleteCriticalSection':
          if (a[0]) this.deleteCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!EnterCriticalSection':
          if (a[0]) this.enterCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!LeaveCriticalSection':
          if (a[0]) this.leaveCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!InterlockedIncrement': {
          const value = (this.readU32(a[0] ?? 0) + 1) >>> 0;
          this.writeU32(a[0] ?? 0, value);
          return { eax: value };
        }
        case 'KERNEL32.DLL!InterlockedDecrement': {
          const value = (this.readU32(a[0] ?? 0) - 1) >>> 0;
          this.writeU32(a[0] ?? 0, value);
          return { eax: value };
        }
        case 'KERNEL32.DLL!IsBadCodePtr':
        case 'KERNEL32.DLL!IsBadReadPtr':
        case 'KERNEL32.DLL!IsBadWritePtr':
          return { eax: 0 };
        case 'KERNEL32.DLL!SetUnhandledExceptionFilter':
          return { eax: 0 };
        // 默认过滤器：交给最近 __except（EXCEPTION_EXECUTE_HANDLER），与 Win32 默认行为一致。
        case 'KERNEL32.DLL!UnhandledExceptionFilter':
          return { eax: 1 };
        // 客体相对毫秒数，与多媒体定时器、消息时间戳共用同一时钟。
        case 'KERNEL32.DLL!WideCharToMultiByte': {
          const source = this.readWideUnits(a[2] ?? 0, (a[3] ?? 0) | 0);
          const out = new Uint8Array(source.length);
          for (let i = 0; i < source.length; i++) out[i] = source[i]! <= 0xff ? source[i]! : 0x3f;
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) this.memory.write_memory(out.subarray(0, capacity), a[4]);
          if (a[7]) this.memory.write_memory([0], a[7]);
          return { eax: out.length };
        }
        case 'KERNEL32.DLL!MultiByteToWideChar': {
          const source = this.readNarrowBytes(a[2] ?? 0, (a[3] ?? 0) | 0);
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) {
            const count = Math.min(source.length, capacity);
            const out = new Uint8Array(count * 2);
            for (let i = 0; i < count; i++) out[i * 2] = source[i]!;
            this.memory.write_memory(out, a[4]);
          }
          return { eax: source.length };
        }
        case 'KERNEL32.DLL!GetStringTypeW': {
          const source = this.readWideUnits(a[1] ?? 0, (a[2] ?? 0) | 0);
          this.writeCharTypes(a[3] ?? 0, source);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetStringTypeA': {
          const source = this.readNarrowBytes(a[2] ?? 0, (a[3] ?? 0) | 0);
          this.writeCharTypes(a[4] ?? 0, [...source]);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!LCMapStringW': {
          const flags = a[1] ?? 0;
          const source = this.readWideUnits(a[2] ?? 0, (a[3] ?? 0) | 0);
          const mapped = source.map((c) => this.mapAsciiCase(c, flags));
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) {
            const count = Math.min(mapped.length, capacity);
            const out = new Uint8Array(count * 2);
            for (let i = 0; i < count; i++) {
              out[i * 2] = mapped[i]! & 0xff;
              out[i * 2 + 1] = mapped[i]! >>> 8;
            }
            this.memory.write_memory(out, a[4]);
          }
          return { eax: mapped.length };
        }
        case 'KERNEL32.DLL!LCMapStringA': {
          const flags = a[1] ?? 0;
          const source = this.readNarrowBytes(a[2] ?? 0, (a[3] ?? 0) | 0);
          const mapped = Uint8Array.from(source, (c) => this.mapAsciiCase(c, flags));
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) this.memory.write_memory(mapped.subarray(0, capacity), a[4]);
          return { eax: mapped.length };
        }
        case 'KERNEL32.DLL!GetCurrentThreadId':
          return { eax: this.readU32(HYPERCALL_THREAD_CURRENT) + 1 };
        case 'KERNEL32.DLL!GetCurrentThread':
          return { eax: 0xffff_fffe };
        case 'KERNEL32.DLL!GetCurrentProcess':
          return { eax: 0xffff_ffff };
        case 'KERNEL32.DLL!GetCurrentProcessId':
          return { eax: GUEST_PROCESS_ID };
        case 'KERNEL32.DLL!GetUserDefaultLCID':
          return { eax: 0x0404 }; // zh-TW
        case 'KERNEL32.DLL!IsValidCodePage':
        case 'KERNEL32.DLL!IsValidLocale':
        case 'KERNEL32.DLL!SetConsoleCtrlHandler':
        case 'KERNEL32.DLL!SetEnvironmentVariableA':
          return { eax: 1 };
        case 'KERNEL32.DLL!GetStdHandle':
          return { eax: 0x10010 + ((a[0] ?? 0) & 3) };
        case 'KERNEL32.DLL!SetStdHandle':
          return { eax: 1 };
        case 'KERNEL32.DLL!CloseHandle': {
          const handle = a[0] ?? 0;
          if (!this.closeGuestSyncHandle(handle)) this.closeFile(handle);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!FlushFileBuffers': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file) return { eax: 0 };
          this.flushFile(file);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!SetHandleCount':
          return { eax: a[0] ?? 0 };
        case 'KERNEL32.DLL!GetFileType':
          return { eax: this.fileHandles.has(a[0] ?? 0) ? 1 : 2 }; // DISK / CHAR
        case 'KERNEL32.DLL!HeapValidate':
          return { eax: 1 };
        case 'KERNEL32.DLL!DebugBreak':
        case 'KERNEL32.DLL!OutputDebugStringA':
          return { eax: 0 };
        case 'KERNEL32.DLL!CreateMutexA': {
          const name = a[2] ? this.readCString(a[2]) : '';
          const launcher = this.gameProfile.launcher;
          if (launcher && name.toLowerCase() === launcher.mutexName) {
            this.lastError = 183;
            return { eax: launcher.handle };
          }
          return { eax: this.createGuestMutex(!!a[1], name) };
        }
        case 'KERNEL32.DLL!OpenMutexA': {
          const name = a[2] ? this.readCString(a[2]) : '';
          const launcher = this.gameProfile.launcher;
          if (launcher && name.toLowerCase() === launcher.mutexName) {
            this.lastError = 0;
            return { eax: launcher.handle };
          }
          return { eax: this.openGuestMutex(name) };
        }
        case 'KERNEL32.DLL!CreateEventA':
          return { eax: this.createGuestEvent(!!a[1], !!a[2], a[3] ? this.readCString(a[3]) : '') };
        case 'KERNEL32.DLL!OpenEventA': {
          const name = a[2] ? this.readCString(a[2]) : '';
          const launcher = this.gameProfile.launcher;
          if (launcher && name.toLowerCase() === launcher.eventName) {
            const opened = this.openGuestEvent(name);
            if (opened) return { eax: opened };
            const handle = this.createGuestEvent(true, true, name);
            this.lastError = 0;
            return { eax: handle };
          }
          return { eax: this.openGuestEvent(name) };
        }
        case 'KERNEL32.DLL!MapViewOfFileEx': {
          const launcher = this.gameProfile.launcher;
          if (launcher?.protectedData && (a[0] ?? 0) === launcher.handle) {
            return { eax: this.launcherProtectedDataPointer };
          }
          return { eax: 0 };
        }
        case 'KERNEL32.DLL!UnmapViewOfFile':
          return { eax: (a[0] ?? 0) === this.launcherProtectedDataPointer ? 1 : 0 };
        case 'KERNEL32.DLL!CreateThread': {
          return { eax: this.createGuestThread(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0) };
        }
        case 'KERNEL32.DLL!SetThreadPriority':
          return { eax: 1 };
        case 'KERNEL32.DLL!SetEvent':
          return { eax: this.setGuestEvent(a[0] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!ResetEvent':
          return { eax: this.resetGuestEvent(a[0] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!ReleaseMutex':
          return { eax: this.releaseGuestMutex(a[0] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!WaitForSingleObject':
          return { eax: this.waitForGuestObjects([a[0] ?? 0], false, a[1] ?? 0xffff_ffff) };
        case 'KERNEL32.DLL!WaitForMultipleObjects': {
          const count = a[0] ?? 0;
          const pointer = a[1] ?? 0;
          if (!pointer || count < 1 || count > 64) {
            this.lastError = 87; // ERROR_INVALID_PARAMETER
            return { eax: 0xffff_ffff };
          }
          const handles = Array.from({ length: count }, (_, index) => this.readU32(pointer + index * 4));
          return { eax: this.waitForGuestObjects(handles, !!a[2], a[3] ?? 0xffff_ffff) };
        }
        case 'KERNEL32.DLL!WriteFile':
          return { eax: this.writeFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) >= 0 ? 1 : 0 };
        case 'KERNEL32.DLL!lstrlenA':
          // Win32 语义是字节数：GBK 双字节字符解码后字符数会变小，
          // 直接数 NUL 前的原始字节。
          return { eax: this.narrowStringLength(a[0] ?? 0) };
        case 'KERNEL32.DLL!lstrlenW': {
          let length = 0;
          while (a[0] && this.readU16((a[0] ?? 0) + length * 2)) length++;
          return { eax: length };
        }
        case 'KERNEL32.DLL!lstrcpyA': {
          const value = this.readCString(a[1] ?? 0);
          if (a[0]) this.writeAscii(a[0], value);
          return { eax: a[0] ?? 0 };
        }
        case 'KERNEL32.DLL!lstrcatA': {
          const target = a[0] ?? 0;
          if (target) this.writeAscii(target, this.readCString(target) + this.readCString(a[1] ?? 0));
          return { eax: target };
        }
        case 'KERNEL32.DLL!Sleep':
          return { eax: 0, delayMs: this.clock.toHostDelay(a[0] ?? 0) };
        case 'KERNEL32.DLL!ExitThread':
          return { eax: a[0] ?? 0, threadExit: true };
        case 'KERNEL32.DLL!ExitProcess':
        case 'KERNEL32.DLL!TerminateProcess':
          return { eax: a.at(-1) ?? 0, exit: true };
        default:
          void name;
          return null;
      }
    }

    /** 在已加载的 PE 映像内查找 type/name/lang 资源。HRSRC 用数据项地址表示。 */
    protected findPeResource(
      requestedModule: number,
      requestedName: number,
      requestedType: number,
    ): { handle: number; module: number; data: number; size: number } | null {
      const module = requestedModule || 0x0040_0000;
      if (this.readU16(module) !== 0x5a4d) return null;
      const pe = module + this.readU32(module + 0x3c);
      if (this.readU32(pe) !== 0x0000_4550) return null;
      const optional = pe + 24;
      if (this.readU16(optional) !== 0x010b) return null; // PE32
      const resourceRva = this.readU32(optional + 112); // data directory[IMAGE_DIRECTORY_ENTRY_RESOURCE]
      const resourceSize = this.readU32(optional + 116);
      if (!resourceRva || resourceSize < 16) return null;
      const root = module + resourceRva;
      const withinResource = (address: number, bytes: number): boolean =>
        address >= root && address + bytes >= address && address + bytes <= root + resourceSize;
      const resourceName = (value: number): { id?: number; text?: string } =>
        value > 0xffff ? { text: this.readCString(value).toLowerCase() } : { id: value & 0xffff };
      const findEntry = (directory: number, wanted: { id?: number; text?: string }): number => {
        if (!withinResource(directory, 16)) return 0;
        const count = this.readU16(directory + 12) + this.readU16(directory + 14);
        for (let index = 0; index < count; index++) {
          const entry = directory + 16 + index * 8;
          if (!withinResource(entry, 8)) return 0;
          const name = this.readU32(entry);
          let matches = false;
          if ((name & 0x8000_0000) !== 0 && wanted.text !== undefined) {
            const stringAddress = root + (name & 0x7fff_ffff);
            if (!withinResource(stringAddress, 2)) continue;
            const length = this.readU16(stringAddress);
            if (!withinResource(stringAddress + 2, length * 2)) continue;
            let text = '';
            for (let i = 0; i < length; i++) text += String.fromCharCode(this.readU16(stringAddress + 2 + i * 2));
            matches = text.toLowerCase() === wanted.text;
          } else if ((name & 0x8000_0000) === 0 && wanted.id !== undefined) {
            matches = (name & 0xffff) === wanted.id;
          }
          if (matches) return this.readU32(entry + 4);
        }
        return 0;
      };
      const descend = (offset: number): number => {
        if ((offset & 0x8000_0000) === 0) return 0;
        const address = root + (offset & 0x7fff_ffff);
        return withinResource(address, 16) ? address : 0;
      };
      const typeDirectory = descend(findEntry(root, resourceName(requestedType)));
      const nameDirectory = typeDirectory && descend(findEntry(typeDirectory, resourceName(requestedName)));
      if (!nameDirectory || !withinResource(nameDirectory, 16)) return null;
      const languageCount = this.readU16(nameDirectory + 12) + this.readU16(nameDirectory + 14);
      if (!languageCount) return null;
      const languageEntry = nameDirectory + 16;
      if (!withinResource(languageEntry, 8)) return null;
      const dataOffset = this.readU32(languageEntry + 4);
      if ((dataOffset & 0x8000_0000) !== 0) return null;
      const handle = root + dataOffset;
      if (!withinResource(handle, 16)) return null;
      const data = module + this.readU32(handle);
      const size = this.readU32(handle + 4);
      if (data < module || data + size < data) return null;
      return { handle, module, data, size };
    }

    /** LoadCursorA：加载并解码光标资源为 RGBA，返回 HCURSOR 句柄（按 module:id 复用）。 */
    protected loadCursorImage(module: number, cursorId: number): number {
      const key = `${module >>> 0}:${cursorId >>> 0}`;
      const existing = this.cursorHandleById.get(key);
      if (existing) return existing;
      const handle = this.nextCursorHandle++;
      this.cursorHandleById.set(key, handle);
      const decoded = this.decodeCursorResource(module || 0x0040_0000, cursorId >>> 0);
      if (decoded) this.cursorImages.set(handle, decoded);
      if (shimTraceEnabled('VM_TRACE_CURSOR'))
        console.log(
          `[cursor] LoadCursor module=0x${(module >>> 0).toString(16)} id=${cursorId} -> handle=0x${handle.toString(16)} decoded=${decoded ? `${decoded.width}x${decoded.height} hot=${decoded.hotspotX},${decoded.hotspotY}` : 'null'}`,
        );
      return handle;
    }

    /** 解析 RT_GROUP_CURSOR(12) → RT_CURSOR(1)，把 .cur 的 XOR/AND 掩码解码为 RGBA。 */
    private decodeCursorResource(
      module: number,
      cursorId: number,
    ): { width: number; height: number; hotspotX: number; hotspotY: number; rgba: Uint8Array } | null {
      const group = this.findPeResource(module, cursorId, 12); // RT_GROUP_CURSOR
      if (shimTraceEnabled('VM_TRACE_CURSOR'))
        console.log(`[cursor] decode id=${cursorId} group=${group ? `size=${group.size}` : 'null'}`);
      if (!group) return null;
      const g = this.memory.read_memory(group.data, Math.min(group.size, 20));
      const count = g[4]! | (g[5]! << 8);
      if (!count) return null;
      // 取第一张 CURSORDIRENTRY（14 字节，偏移 6）。
      const hotspotX = g[10]! | (g[11]! << 8);
      const hotspotY = g[12]! | (g[13]! << 8);
      const imageId = g[18]! | (g[19]! << 8);
      const image = this.findPeResource(module, imageId, 1); // RT_CURSOR
      if (!image) return null;
      const data = this.memory.read_memory(image.data, image.size);
      // RT_CURSOR 应以 BITMAPINFOHEADER(biSize=40) 开头；RA2 的资源带 4 字节前导，探测真实偏移。
      let hdr = 0;
      if (this.readI32From(data, 0) !== 40) {
        if (this.readI32From(data, 4) === 40) hdr = 4;
        else return null;
      }
      const width = this.readI32From(data, hdr + 4);
      const height = this.readI32From(data, hdr + 8) >> 1; // biHeight 含 XOR+AND 两段
      const bitCount = data[hdr + 14]! | (data[hdr + 15]! << 8);
      if (shimTraceEnabled('VM_TRACE_CURSOR'))
        console.log(
          `[cursor] decode id=${cursorId} imageId=${imageId} imgSize=${image.size} hdr=${hdr} w=${width} h=${height} bits=${bitCount} hot=${hotspotX},${hotspotY}`,
        );
      if (width <= 0 || height <= 0 || width > 256 || height > 256) return null;
      const rgba = new Uint8Array(width * height * 4);
      const colorTableBytes = bitCount <= 8 ? (1 << bitCount) * 4 : 0;
      const xorOffset = hdr + 40 + colorTableBytes;
      const rowBits = width * bitCount;
      const xorStride = ((rowBits + 31) >> 5) << 2;
      const andStride = ((width + 31) >> 5) << 2;
      const andOffset = xorOffset + xorStride * height;
      // 32-bit 光标可能不带 alpha（全 0），此时退回 AND 掩码判透明。
      let hasAlpha = false;
      if (bitCount === 32) {
        for (let i = 0; i < width * height; i++)
          if (data[xorOffset + i * 4 + 3]! !== 0) {
            hasAlpha = true;
            break;
          }
      }
      for (let y = 0; y < height; y++) {
        const row = height - 1 - y; // 位图自底向上
        for (let x = 0; x < width; x++) {
          const di = (y * width + x) * 4;
          let r = 0;
          let gg = 0;
          let b = 0;
          let a = 0;
          if (bitCount === 32) {
            const si = xorOffset + (row * width + x) * 4;
            b = data[si]!;
            gg = data[si + 1]!;
            r = data[si + 2]!;
            a = data[si + 3]!;
            if (!hasAlpha) {
              const andByte = data[andOffset + row * andStride + (x >> 3)]!;
              a = (andByte >> (7 - (x & 7))) & 1 ? 0 : 0xff;
            }
          } else if (bitCount === 8 || bitCount === 4 || bitCount === 1) {
            let index = 0;
            if (bitCount === 8) index = data[xorOffset + row * xorStride + x]!;
            else if (bitCount === 4) {
              const byte = data[xorOffset + row * xorStride + (x >> 1)]!;
              index = x & 1 ? byte & 0x0f : byte >> 4;
            } else {
              const byte = data[xorOffset + row * xorStride + (x >> 3)]!;
              index = (byte >> (7 - (x & 7))) & 1;
            }
            // RT_CURSOR 可能在 BITMAPINFOHEADER 前带 4 字节热点前导；调色板
            // 与 XOR 位图都相对真实 header，不能从资源起点固定偏移 40。
            const ci = hdr + 40 + index * 4;
            b = data[ci]!;
            gg = data[ci + 1]!;
            r = data[ci + 2]!;
            const andByte = data[andOffset + row * andStride + (x >> 3)]!;
            a = (andByte >> (7 - (x & 7))) & 1 ? 0 : 0xff;
          } else {
            return null;
          }
          rgba[di] = r;
          rgba[di + 1] = gg;
          rgba[di + 2] = b;
          rgba[di + 3] = a;
        }
      }
      return { width, height, hotspotX, hotspotY, rgba };
    }

    private readI32From(data: Uint8Array, offset: number): number {
      return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24) | 0;
    }
    protected createGuestThread(
      stackBytes: number,
      start: number,
      parameter: number,
      flags: number,
      tidPtr: number,
    ): number {
      if (!start || this.nextThreadId >= GUEST_THREAD_LIMIT) {
        this.lastError = 8;
        return 0;
      }
      const id = this.nextThreadId++;
      const handle = this.nextThreadHandle++;
      if (shimTraceEnabled('VM_TRACE_THREAD'))
        console.log(`🧵 CreateThread id=${id} 入口=0x${start.toString(16)} 参数=0x${parameter.toString(16)}`);
      const reserve = Math.max(64 * 1024, Math.min(stackBytes || 64 * 1024, 1024 * 1024));
      const base = this.alloc(reserve, true);
      if (!base) return 0;
      if (!this.threadExitStub) {
        this.threadExitStub = this.registerDynamicWin32Import('KERNEL32.DLL', 'ExitThread', 4);
        this.threadReturnTrampoline = this.allocateDynamicCode([
          0x50,
          0xb8,
          this.threadExitStub & 0xff,
          (this.threadExitStub >>> 8) & 0xff,
          (this.threadExitStub >>> 16) & 0xff,
          (this.threadExitStub >>> 24) & 0xff,
          0xff,
          0xd0,
          0xf4,
          0xeb,
          0xfd,
        ]);
      }
      const top = base + reserve;
      const context = top - 48;
      const frame = [0, 0, 0, top, 0, 0, 0, 0, 0x0000_0202, start, this.threadReturnTrampoline, parameter];
      for (let i = 0; i < frame.length; i++) this.writeU32(context + i * 4, frame[i]!);
      this.writeU32(GUEST_THREAD_CONTEXT_ESPS + id * 4, context);
      this.writeU32(GUEST_THREAD_CONTEXT_SEH + id * 4, 0xffff_ffff);
      this.writeU32(GUEST_THREAD_CONTEXT_STACK_TOP + id * 4, top);
      this.writeU32(GUEST_THREAD_CONTEXT_STACK_BOTTOM + id * 4, base);
      this.writeU32(GUEST_THREAD_CONTEXT_LAST_ERROR + id * 4, 0);
      this.zero(FAST_TLS_TABLE + id * FAST_TLS_THREAD_BYTES, FAST_TLS_THREAD_BYTES);
      this.guestThreads.set(id, {
        id,
        handle,
        runnable: (flags & 0x4) === 0,
        terminated: false,
        wakeAt: 0,
      });
      this.writeU32(GUEST_THREAD_RUN_STATES + id * 4, (flags & 0x4) === 0 ? 1 : 0);
      this.writeU32(HYPERCALL_THREAD_COUNT, this.nextThreadId);
      this.guestThreadHandles.set(handle, id);
      if (tidPtr) this.writeU32(tidPtr, id + 1);
      this.lastError = 0;
      return handle;
    }
    protected loadLibrary(call: Win32Call, namePtr: number): Win32Result {
      const name = this.readCString(namePtr);
      const module = this.loadGuestDll(name);
      if (!module) {
        // CRT 对系统 DLL 的可选探测仍沿用主模块哑句柄。
        return { eax: 0x0040_0000 };
      }
      if (!module.initialized && module.entry) {
        module.initialized = true;
        const originalReturn = this.readU32(call.stack);
        const code: number[] = [];
        const emit32 = (value: number) =>
          code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
        const push = (value: number) => {
          code.push(0x68);
          emit32(value);
        };
        push(0); // lpReserved
        push(1); // DLL_PROCESS_ATTACH
        push(module.base);
        code.push(0xb8);
        emit32(module.entry);
        code.push(0xff, 0xd0); // call DllMainCRTStartup
        code.push(0xb8);
        emit32(module.base); // LoadLibraryA 返回 HMODULE
        code.push(0xb9);
        emit32(originalReturn);
        code.push(0xff, 0xe1); // jmp original return
        this.writeU32(call.stack, this.allocateDynamicCode(code));
      }
      return { eax: module.base };
    }

    protected getGuestProcAddress(handle: number, namePtr: number): number {
      const module = this.guestDllByHandle(handle);
      const name = namePtr <= 0xffff ? `ord${namePtr}` : this.readCString(namePtr);
      if (!module) {
        // comctl32 的版本检查由 host 提供一个正常 hypercall 入口；其他 CRT 可选
        // 系统函数保持“不存在”，让调用方采用 Win9x 兼容路径。
        if (name === 'DllGetVersion') {
          this.dllGetVersionStub ||= this.registerDynamicWin32Import('COMCTL32.DLL', name, 4);
          return this.dllGetVersionStub;
        }
        return 0;
      }
      return module.exports.get(name) ?? 0;
    }
    protected openFile(args: number[]): number {
      const rawPath = this.readCString(args[0] ?? 0);
      // 盘根路径（"C:\" / "C:" / "\"）是驱动器存在性探测：Win9x 下 CreateFileA 对
      // 已存在驱动器的根目录会返回有效句柄；给探测请求一个可关闭的哑句柄。
      if (/^[a-z]:[\\/]?$/i.test(rawPath) || rawPath === '\\' || rawPath === '/') {
        const handle = this.allocateFileHandle();
        this.fileHandles.set(handle, {
          path: '',
          bytes: new Uint8Array(),
          size: 0,
          position: 0,
          writable: false,
          dirty: false,
        });
        return handle;
      }
      const path = normalizeGuestPath(rawPath);
      const desiredAccess = args[1] ?? 0;
      const disposition = args[4] ?? 3;
      let bytes = this.files.get(path);
      const sharedMirror = this.sharedFileMirrors.get(path);
      const exists = bytes !== undefined || sharedMirror !== undefined;

      // CREATE_NEW / CREATE_ALWAYS / OPEN_ALWAYS 可以创建；OPEN_EXISTING 必须已挂载。
      if (disposition === 1 && exists) {
        this.lastError = 80; // ERROR_FILE_EXISTS
        return 0xffff_ffff;
      }
      if (!exists && disposition !== 1 && disposition !== 2 && disposition !== 4) {
        this.lastError = 2; // ERROR_FILE_NOT_FOUND
        this.noteFailedOpen(path);
        return 0xffff_ffff;
      }
      if (!exists || disposition === 1 || disposition === 2) {
        bytes = new Uint8Array();
        this.sharedFileMirrors.delete(path);
        this.storeFile(path, bytes);
      }
      if (disposition === 5) {
        // TRUNCATE_EXISTING
        if (!exists) {
          this.lastError = 2;
          this.noteFailedOpen(path);
          return 0xffff_ffff;
        }
        bytes = new Uint8Array();
        this.sharedFileMirrors.delete(path);
        this.storeFile(path, bytes);
      }

      const handle = this.allocateFileHandle();
      const file: FileState = {
        path,
        bytes: bytes ?? new Uint8Array(),
        size: sharedMirror?.size ?? this.fileLogicalSizes.get(path) ?? bytes!.length,
        position: 0,
        writable: (desiredAccess & 0x4000_0000) !== 0 || disposition !== 3,
        dirty: !exists || disposition === 1 || disposition === 2 || disposition === 5,
      };
      this.fileHandles.set(handle, file);
      this.mirrorFile(handle, file);
      this.lastError = disposition === 4 && exists ? 183 : 0; // ERROR_ALREADY_EXISTS
      return handle;
    }
    protected openLegacyFile(pathPtr: number, create: boolean, openFlags = 0): number {
      const path = normalizeGuestPath(this.readCString(pathPtr));
      // _lopen 的 oflag：OF_WRITE(1)/OF_READWRITE(2) 打开可写句柄（原版存档流程用它
      // 原地重写 label.sav/record.sav，写失败会静默丢存档列表/记录更新）。
      const writable = create || (openFlags & 3) !== 0;
      // 真机上对目录名 _lcreat 会失败（访问被拒）；对虚拟目录创建文件同样返回失败。
      if (create && this.isVirtualDirectory(path)) {
        this.lastError = 5; // ERROR_ACCESS_DENIED
        return 0xffff_ffff;
      }
      let bytes = create ? new Uint8Array() : this.files.get(path);
      const sharedMirror = create ? undefined : this.sharedFileMirrors.get(path);
      if (!bytes && !sharedMirror) {
        this.lastError = 2;
        this.noteFailedOpen(path);
        return 0xffff_ffff;
      }
      if (create) {
        this.sharedFileMirrors.delete(path);
        this.storeFile(path, bytes!);
      }
      const handle = this.allocateFileHandle();
      const file: FileState = {
        path,
        bytes: bytes ?? new Uint8Array(),
        size: sharedMirror?.size ?? this.fileLogicalSizes.get(path) ?? bytes!.length,
        position: 0,
        writable,
        dirty: create,
      };
      this.fileHandles.set(handle, file);
      this.mirrorFile(handle, file);
      this.lastError = 0;
      return handle;
    }
    /** 成功返回实际字节数，失败返回 -1。 */
    protected readFile(handle: number, buffer: number, requested: number, bytesReadPtr: number): number {
      const file = this.fileHandles.get(handle);
      if (!file) {
        if (bytesReadPtr) this.writeU32(bytesReadPtr, 0);
        this.lastError = 6; // ERROR_INVALID_HANDLE
        return -1;
      }
      if (!file.mirror) {
        const reads = (this.unmirroredReads.get(handle) ?? 0) + 1;
        this.unmirroredReads.set(handle, reads);
        if (reads === 1000 || reads % 100_000 === 0) {
          console.info(
            `[VM files] 高频 hypercall 读：${file.path}（句柄 0x${handle.toString(16)}，未镜像，第 ${reads} 次）`,
          );
        }
      }
      this.pullFastFilePosition(handle, file);
      const count = Math.min(requested >>> 0, Math.max(0, file.size - file.position));
      if (buffer && count) {
        if (file.sharedMirror && file.mirror) {
          this.memory.write_memory(this.memory.read_memory(file.mirror + file.position, count), buffer);
        } else if (this.rangeBackedFiles.has(file.path)) {
          this.copyFileRange(file.path, file.position, count, buffer);
        } else {
          const available = Math.min(count, Math.max(0, file.bytes.length - file.position));
          if (available) {
            this.memory.write_memory(file.bytes.subarray(file.position, file.position + available), buffer);
          }
          if (available < count) this.zero(buffer + available, count - available);
        }
      }
      file.position += count;
      this.pushFastFilePosition(handle, file);
      if (bytesReadPtr) this.writeU32(bytesReadPtr, count);
      this.lastError = 0;
      return count;
    }
    /** 成功返回实际字节数，失败返回 -1。 */
    protected writeFile(handle: number, buffer: number, requested: number, bytesWrittenPtr: number): number {
      const file = this.fileHandles.get(handle);
      if (!file) {
        // CRT 的 stdout/stderr 无需真正输出到客体设备。
        if (handle >= 0x10010 && handle <= 0x10013) {
          if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, requested >>> 0);
          return requested >>> 0;
        }
        if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, 0);
        this.lastError = 6;
        return -1;
      }
      if (!file.writable) {
        if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, 0);
        this.lastError = 5; // ERROR_ACCESS_DENIED
        return -1;
      }
      this.demoteFileMirror(handle, file);
      const count = requested >>> 0;
      const end = file.position + count;
      if (shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
        console.log(
          `[VM files] WriteFile ${file.path} handle=0x${handle.toString(16)} pos=${file.position} count=${count} end=${end} capacity=${file.bytes.length}`,
        );
      }
      if (end > file.bytes.length) {
        const capacity = Math.max(4096, Math.min(0x7fff_ffff, Math.max(1, file.bytes.length) * 2));
        const grown = new Uint8Array(Math.max(end, capacity));
        grown.set(file.bytes.subarray(0, file.size));
        file.bytes = grown;
      }
      if (file.position > file.size) file.bytes.fill(0, file.size, file.position);
      if (buffer && count) file.bytes.set(this.memory.read_memory(buffer, count), file.position);
      file.position = end;
      file.size = Math.max(file.size, end);
      this.storeFile(file.path, file.bytes.subarray(0, file.size));
      file.dirty = true;
      if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, count);
      this.lastError = 0;
      return count;
    }
    protected seekFile(handle: number, low: number, highPtr: number, origin: number): number {
      const file = this.fileHandles.get(handle);
      if (!file) {
        this.lastError = 6;
        return 0xffff_ffff;
      }
      this.pullFastFilePosition(handle, file);
      const high = highPtr ? this.readU32(highPtr) | 0 : low & 0x8000_0000 ? -1 : 0;
      const distance = high * 0x1_0000_0000 + (low >>> 0);
      const base = origin === 1 ? file.position : origin === 2 ? file.size : origin === 0 ? 0 : -1;
      const position = base + distance;
      if (file.writable && shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
        console.log(
          `[VM files] SetFilePointer ${file.path} handle=0x${handle.toString(16)} origin=${origin} low=0x${(low >>> 0).toString(16)} high=${high} ${file.position}->${position}`,
        );
      }
      if (base < 0 || position < 0 || position > 0xffff_ffff) {
        this.lastError = 87; // ERROR_INVALID_PARAMETER
        return 0xffff_ffff;
      }
      file.position = position;
      this.pushFastFilePosition(handle, file);
      if (highPtr) this.writeU32(highPtr, Math.floor(position / 0x1_0000_0000));
      this.lastError = 0;
      return position >>> 0;
    }
    protected closeFile(handle: number): boolean {
      const file = this.fileHandles.get(handle);
      if (!file) return false;
      this.flushFile(file);
      this.unmirroredReads.delete(handle);
      this.fileHandles.delete(handle);
      this.freeFileHandles.push(handle);
      const entry = this.fastFileEntry(handle);
      if (entry !== null) this.zero(entry, FAST_FILE_ENTRY_BYTES);
      if (file.mirror) {
        if (!file.sharedMirror) {
          this.freeAllocation(file.mirror);
          this.fileMirrorBytes = Math.max(0, this.fileMirrorBytes - file.size);
        }
      }
      return true;
    }
    protected flushFile(file: FileState): void {
      if (!file.writable || !file.dirty) return;
      file.dirty = false;
      this.notifyFileWrite(file.path, file.bytes.subarray(0, file.size));
    }
    protected notifyFileWrite(path: string, bytes: Uint8Array): void {
      this.options.onFileWrite?.(path, bytes.slice());
    }
    /** 打开时建立镜像：可写句柄同样镜像（原版常以读写模式打开、实际只读），
     *  客体首次写入时由 demoteFileMirror 降级回 canonical 路径。 */
    protected mirrorFile(handle: number, file: FileState): void {
      if (!this.options.enableFastFileMirror) return;
      // Bink 1.x 以极小块读取已从 MIX 解出的 .bik；不镜像时 YR 主菜单实测会产生
      // 约 7700 次 ReadFile/500ms。档案 allowlist 仍限制巨型 MIX，但视频叶文件
      // 一律允许进入同一客体快速表，避免每个解码块跨 Worker/COM1 往返。
      if (this.fastFileMirrorFiles && !this.fastFileMirrorFiles.has(file.path) && !file.path.endsWith('.bik')) return;
      const entry = this.fastFileEntry(handle);
      if (entry === null) return;
      if (!file.writable && this.fastFileMirrorBase && this.fastFileMirrorTop > this.fastFileMirrorBase) {
        const cached = this.sharedFileMirrors.get(file.path);
        if (cached && cached.size === file.size) {
          file.mirror = cached.ptr;
          file.sharedMirror = true;
          this.publishFastFileMirror(entry, file, cached.ptr);
          return;
        }
      }
      if (file.size + this.fileMirrorBytes > this.fastFileMirrorLimit) {
        const warningKey = `budget:${file.path}`;
        if (file.size > 1024 * 1024 && !this.warnedFileMirrorSkips.has(warningKey)) {
          this.warnedFileMirrorSkips.add(warningKey);
          console.info(
            `[VM files] 镜像跳过（超预算）${file.path}：${file.size} 字节（已用 ${this.fileMirrorBytes}/${this.fastFileMirrorLimit}）`,
          );
        }
        return;
      }
      // RA2.MIX 单文件约 269MiB。若每个句柄都重新复制进普通游戏堆，不但越过
      // Blowfish.dll 的固定 0x11000000 映射，还会在反复开关 MIX 时重复搬运几百
      // MiB。独立高地址区按规范化路径永久缓存，只读句柄共享内容、各用自己的
      // FAST_FILE_ENTRY 保存 position。
      if (!file.writable && this.fastFileMirrorBase && this.fastFileMirrorTop > this.fastFileMirrorBase) {
        const aligned = (Math.max(1, file.size) + 15) & ~15;
        const mirror = (this.nextFastFileMirror + 15) & ~15;
        if (mirror + aligned <= this.fastFileMirrorTop) {
          if (file.size) this.memory.write_memory(file.bytes.subarray(0, file.size), mirror);
          this.nextFastFileMirror = mirror + aligned;
          this.sharedFileMirrors.set(file.path, { ptr: mirror, size: file.size });
          file.mirror = mirror;
          file.sharedMirror = true;
          // 客体镜像成为只读档案的 canonical 快照；释放 provider 返回的宿主大数组，
          // 否则 RA2.MIX 等文件会同时占用 guest RAM 与 JS heap，打开战役影片包时 OOM。
          this.files.delete(file.path);
          file.bytes = new Uint8Array();
          this.fileMirrorBytes += file.size;
          this.publishFastFileMirror(entry, file, mirror);
          if (file.size > 1024 * 1024) {
            console.info(
              `[VM files] 已缓存大文件 ${file.path}：${file.size} 字节 @0x${mirror.toString(16)}（已用 ${this.fileMirrorBytes}/${this.fastFileMirrorLimit}）`,
            );
          }
          return;
        }
        const warningKey = `region:${file.path}`;
        if (file.size > 1024 * 1024 && !this.warnedFileMirrorSkips.has(warningKey)) {
          this.warnedFileMirrorSkips.add(warningKey);
          console.info(`[VM files] 大文件镜像区不足 ${file.path}：${file.size} 字节`);
        }
        return;
      }
      // 镜像从游戏堆分配：关闭句柄即归还，不永久占用地址空间；
      // alloc 失败（地址空间紧张）时该文件退回 hypercall 读。
      const mirror = this.alloc(Math.max(1, file.size), false);
      if (!mirror) {
        const warningKey = `heap:${file.path}`;
        if (file.size > 1024 * 1024 && !this.warnedFileMirrorSkips.has(warningKey)) {
          this.warnedFileMirrorSkips.add(warningKey);
          console.info(`[VM files] 镜像跳过（堆分配失败）${file.path}：${file.size} 字节`);
        }
        return;
      }
      if (file.size) this.memory.write_memory(file.bytes.subarray(0, file.size), mirror);
      file.mirror = mirror;
      this.fileMirrorBytes += file.size;
      this.publishFastFileMirror(entry, file, mirror);
      if (file.size > 1024 * 1024) {
        console.info(
          `[VM files] 已镜像 ${file.path}：${file.size} 字节（已用 ${this.fileMirrorBytes}/${this.fastFileMirrorLimit}）`,
        );
      }
    }
    /** 镜像句柄被客体写入时降级：先取回客体内最新位置，再归还镜像并清表项，
     *  后续读写走 canonical bytes 的 hypercall 路径。 */
    protected demoteFileMirror(handle: number, file: FileState): void {
      if (!file.mirror) return;
      if (file.size > 1024 * 1024) {
        console.info(`[VM files] 镜像降级 ${file.path}：客体写入，退回 hypercall 路径`);
      }
      this.pullFastFilePosition(handle, file);
      if (file.sharedMirror && file.bytes.length < file.size) {
        file.bytes = this.memory.read_memory(file.mirror, file.size).slice();
        this.sharedFileMirrors.delete(file.path);
        this.storeFile(file.path, file.bytes);
      }
      const entry = this.fastFileEntry(handle);
      if (entry !== null) this.zero(entry, FAST_FILE_ENTRY_BYTES);
      if (!file.sharedMirror) {
        this.freeAllocation(file.mirror);
        this.fileMirrorBytes = Math.max(0, this.fileMirrorBytes - file.size);
      }
      file.mirror = undefined;
      file.sharedMirror = false;
    }
    protected pullFastFilePosition(handle: number, file: FileState): void {
      const entry = file.mirror ? this.fastFileEntry(handle) : null;
      if (entry !== null) file.position = this.readU32(entry + 8);
    }
    protected pushFastFilePosition(handle: number, file: FileState): void {
      const entry = file.mirror ? this.fastFileEntry(handle) : null;
      if (entry !== null) this.writeU32(entry + 8, file.position);
    }
    protected fastFileEntry(handle: number): number | null {
      const index = (handle >>> 0) - FAST_FILE_HANDLE_BASE;
      return index >= 0 && index < FAST_FILE_TABLE_ENTRIES ? FAST_FILE_TABLE + index * FAST_FILE_ENTRY_BYTES : null;
    }
    protected publishFastFileMirror(entry: number, file: FileState, mirror: number): void {
      this.writeU32(entry, mirror);
      this.writeU32(entry + 4, file.size);
      this.writeU32(entry + 8, file.position);
      this.writeU32(entry + 12, 1);
    }
    protected allocateFileHandle(): number {
      return this.freeFileHandles.pop() ?? this.nextFileHandle++;
    }
    protected alloc(size: number, zero: boolean): number {
      if (size <= 0) size = 1;
      const aligned = Math.ceil(size / 16) * 16;
      if (!Number.isSafeInteger(aligned) || aligned <= 0) {
        this.lastError = 8;
        return 0;
      }
      let ptr = 0;
      const freeIndex = this.freeBlocks.findIndex((block) => block.size >= aligned);
      if (freeIndex >= 0) {
        const block = this.freeBlocks[freeIndex]!;
        ptr = block.ptr;
        block.ptr += aligned;
        block.size -= aligned;
        if (!block.size) this.freeBlocks.splice(freeIndex, 1);
      } else {
        // 堆自 0x500000 向上增长；VirtualAlloc 保留区是屏障，必须跳过。
        // 直接遍历 Map，不 spread 成数组（GlobalAlloc 每秒上万次的分配热路径）。
        ptr = this.nextHeap;
        for (let guard = 0; guard < 128; guard++) {
          let blocked = false;
          for (const [base, region] of this.virtualRegions) {
            if (ptr < base + region.size && base < ptr + aligned) {
              ptr = base + region.size;
              blocked = true;
              break;
            }
          }
          if (!blocked) break;
        }
        // MEM_RELEASE 归还的区域位于独立虚拟释放链表、可能高于 nextHeap；前进
        // 路径驶入时堆自取该范围，必须同步剔除，否则会被后续 VirtualAlloc 再次
        // 发出（wemu 靠独立 virtual arena 与堆互斥规避，我们在这里补齐等价物）。
        this.trimVirtualFreeBlocks(ptr, ptr + aligned);
        this.trimFreeBlocks(ptr, ptr + aligned);
        this.nextHeap = ptr + aligned;
        this.peakHeap = Math.max(this.peakHeap, this.nextHeap);
      }
      if (ptr < this.heapBase || ptr + aligned > this.heapTop) {
        this.lastError = 8; // ERROR_NOT_ENOUGH_MEMORY
        return 0;
      }
      this.allocations.set(ptr, aligned);
      if (zero) this.zero(ptr, aligned);
      return ptr;
    }
    protected realloc(oldPtr: number, size: number, zero: boolean): number {
      if (!oldPtr) return this.alloc(size, zero);
      const oldSize = this.allocations.get(oldPtr) ?? 0;
      const aligned = Math.ceil(Math.max(1, size) / 16) * 16;
      if (oldSize && aligned <= oldSize) {
        if (aligned < oldSize) {
          this.allocations.set(oldPtr, aligned);
          this.addFreeBlock(oldPtr + aligned, oldSize - aligned);
        }
        return oldPtr;
      }
      const ptr = this.alloc(size, zero);
      if (!ptr) return 0;
      if (oldSize) this.memory.write_memory(this.memory.read_memory(oldPtr, Math.min(oldSize, size)), ptr);
      this.freeAllocation(oldPtr);
      return ptr;
    }
    protected freeAllocation(ptr: number): boolean {
      const size = this.allocations.get(ptr);
      if (size === undefined) return false;
      this.allocations.delete(ptr);
      this.addFreeBlock(ptr, size);
      return true;
    }
    protected addFreeBlock(ptr: number, size: number): void {
      this.addBlock(this.freeBlocks, ptr, size);
    }
    protected addBlock(blocks: Array<{ ptr: number; size: number }>, ptr: number, size: number): void {
      if (size <= 0) return;
      // 块表按地址有序（不变式）：二分定位插入位、只合并相邻块，不再每次 free
      // 全量 sort + 全表扫描——GlobalAlloc/GlobalFree 每秒上万次的路径上这是热点。
      let low = 0;
      let high = blocks.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (blocks[mid]!.ptr < ptr) low = mid + 1;
        else high = mid;
      }
      let entryPtr = ptr;
      let entrySize = size;
      if (low > 0 && blocks[low - 1]!.ptr + blocks[low - 1]!.size === ptr) {
        const previous = blocks[low - 1]!;
        entryPtr = previous.ptr;
        entrySize = previous.size + size;
        blocks.splice(low - 1, 1);
        low -= 1;
      }
      while (low < blocks.length && blocks[low]!.ptr === entryPtr + entrySize) {
        entrySize += blocks[low]!.size;
        blocks.splice(low, 1);
      }
      blocks.splice(low, 0, { ptr: entryPtr, size: entrySize });
    }
    protected addVirtualFreeBlock(ptr: number, size: number): void {
      this.addBlock(this.virtualFreeBlocks, ptr, size);
    }
    /**
     * VirtualAlloc：独立的虚拟保留区表（wemu 模型，参见 virtualRegions 字段注释）。
     * 原版 VC6 CRT 的 1MB RESERVE + 逐 32KB 块 COMMIT/DECOMMIT 全部落在这里，
     * 与 HeapAlloc/GlobalAlloc/文件镜像共用的堆 arena 严格互斥。
     * 与 wemu hle_base.rs virtual_alloc 同构：忽略 RESERVE/COMMIT 区分——
     * 已在保留区内→零填充后原样返回请求地址；保留区外→在 arena 界内按请求
     * 基址新建区域（retrotick 的 allocVirtual 同样不区分类型），界外或重叠才失败。
     */
    protected virtualAlloc(requested: number, size: number): number {
      const aligned = Math.ceil(Math.max(1, size) / 16) * 16;
      if (requested) {
        const end = requested + aligned;
        // 已在保留区内的提交：零填充后原样返回请求地址。
        for (const [base, region] of this.virtualRegions) {
          if (requested >= base && end <= base + region.size) {
            this.zero(requested, aligned);
            return requested;
          }
        }
        // 保留区外的固定地址：界内新建区域（wemu alloc_at），界外失败。
        if (requested < this.virtualBase || end > this.heapTop) {
          this.warnVirtual(requested, '固定地址超出堆 arena 界，VirtualAlloc 已拒绝');
          this.lastError = 487; // ERROR_INVALID_ADDRESS
          return 0;
        }
        // 与活动堆分配或已有保留区重叠即拒绝，而不是静默别名。
        for (const [ptr, liveSize] of this.allocations) {
          if (requested < ptr + liveSize && ptr < end) {
            this.warnVirtual(requested, '与活动堆分配重叠，VirtualAlloc 已拒绝');
            this.lastError = 487; // ERROR_INVALID_ADDRESS
            return 0;
          }
        }
        for (const [base, region] of this.virtualRegions) {
          if (requested < base + region.size && base < end) {
            this.warnVirtual(requested, '与已有 VirtualAlloc 保留区重叠');
            this.lastError = 487;
            return 0;
          }
        }
        this.trimFreeBlocks(requested, end);
        this.trimVirtualFreeBlocks(requested, end);
        this.virtualRegions.set(requested, { size: aligned });
        this.zero(requested, aligned);
        return requested;
      }
      const base = this.findVirtualBase(aligned);
      if (!base) {
        this.lastError = 8; // ERROR_NOT_ENOUGH_MEMORY
        return 0;
      }
      // 保留区可能落在两条空闲链表内：剔除重叠，防止后续 HeapAlloc 或
      // VirtualAlloc 复用同一地址（此前 NULL 保留漏掉这一步，是双重占用的隐患路径）。
      this.trimFreeBlocks(base, base + aligned);
      this.trimVirtualFreeBlocks(base, base + aligned);
      this.virtualRegions.set(base, { size: aligned });
      this.zero(base, aligned);
      return base;
    }
    /** MEM_RELEASE 释放整个保留区；MEM_DECOMMIT 保留区域、只清零内容。 */
    protected virtualFree(addr: number, size: number, type: number): boolean {
      const entry = [...this.virtualRegions.entries()].find(
        ([base, region]) => addr >= base && addr < base + region.size,
      );
      if (!entry) {
        this.warnVirtual(addr, 'VirtualFree 的地址不在任何保留区内');
        return false;
      }
      const [base, region] = entry;
      if ((type & 0x8000) !== 0) {
        // MEM_RELEASE
        if (addr !== base) {
          this.warnVirtual(addr, 'MEM_RELEASE 地址不是保留区基址');
          return false;
        }
        this.virtualRegions.delete(base);
        // wemu 的 RELEASE 经 try_free 把区域还给 virtual arena，只供后续
        // VirtualAlloc 复用，绝不进入堆空闲链表（retrotick 连 RELEASE 都不回收，
        // 只增不减；此处按 wemu 回收以避免长会话地址耗尽）。
        this.addVirtualFreeBlock(base, region.size);
        return true;
      }
      // wemu 只认 MEM_DECOMMIT 标志：既非 RELEASE 也非 DECOMMIT 的类型失败。
      if ((type & 0x4000) === 0) {
        this.warnVirtual(addr, 'VirtualFree 类型既非 MEM_RELEASE 也非 MEM_DECOMMIT');
        return false;
      }
      const decommitEnd = addr + Math.max(0, size);
      if (decommitEnd > base + region.size) {
        this.warnVirtual(addr, 'MEM_DECOMMIT 范围超出保留区');
        return false;
      }
      // 客体内存无法真正缺页；清零保证游戏不会继续读到已解除提交的旧数据。
      this.zero(addr, Math.max(0, decommitEnd - addr));
      return true;
    }
    /** NULL 保留：先复用 MEM_RELEASE 归还的区域（自高向低，近似 Windows 的
     *  自顶向下地址空间复用），没有再自虚拟区顶端向下扫描空闲位置。 */
    protected findVirtualBase(size: number): number {
      let reuseBase = 0;
      for (const block of this.virtualFreeBlocks) {
        const top = (block.ptr + block.size - size) & ~15;
        if (block.size >= size && top >= block.ptr && top > reuseBase) reuseBase = top;
      }
      if (reuseBase) {
        // 从该块顶端切走 [reuseBase, reuseBase+size)，剩余留在链表。
        // 三种切法都要避免留下零尺寸条目：整块用完→删除；从块头切→前移；
        // 从中间切→只缩到 reuseBase。
        for (let i = this.virtualFreeBlocks.length - 1; i >= 0; i--) {
          const block = this.virtualFreeBlocks[i]!;
          if (reuseBase >= block.ptr && reuseBase + size <= block.ptr + block.size) {
            if (reuseBase === block.ptr) {
              if (size === block.size) this.virtualFreeBlocks.splice(i, 1);
              else {
                block.ptr += size;
                block.size -= size;
              }
            } else {
              block.size = reuseBase - block.ptr;
            }
            break;
          }
        }
        return reuseBase;
      }
      let base = (this.virtualTop - size) & ~15;
      while (base >= this.virtualBase && base + size <= this.virtualTop) {
        let blocked = false;
        for (const [ptr, liveSize] of this.allocations) {
          if (base < ptr + liveSize && ptr < base + size) {
            base = (ptr - size) & ~15;
            blocked = true;
          }
        }
        for (const [regionBase, region] of this.virtualRegions) {
          if (base < regionBase + region.size && regionBase < base + size) {
            base = (regionBase - size) & ~15;
            blocked = true;
          }
        }
        if (!blocked) return base;
      }
      return 0;
    }
    /** 从堆空闲链表剔除 [base, end) 覆盖的范围，防止后续 HeapAlloc 复用。 */
    protected trimFreeBlocks(base: number, end: number): void {
      this.trimBlocks(this.freeBlocks, base, end);
    }
    /** 从 VirtualAlloc 释放链表剔除 [base, end)，防止后续 VirtualAlloc 复用。 */
    protected trimVirtualFreeBlocks(base: number, end: number): void {
      this.trimBlocks(this.virtualFreeBlocks, base, end);
    }
    protected trimBlocks(blocks: Array<{ ptr: number; size: number }>, base: number, end: number): void {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!;
        const blockEnd = block.ptr + block.size;
        if (end <= block.ptr || blockEnd <= base) continue; // 不相交
        if (base <= block.ptr && blockEnd <= end) {
          blocks.splice(i, 1); // 整块被覆盖
        } else if (block.ptr < base && end < blockEnd) {
          blocks.splice(i, 1, { ptr: block.ptr, size: base - block.ptr }, { ptr: end, size: blockEnd - end });
        } else if (base <= block.ptr) {
          block.ptr = end;
          block.size = blockEnd - end;
        } else {
          block.size = base - block.ptr;
        }
      }
    }
    protected warnVirtual(address: number, detail: string): void {
      if (this.warnedVirtual.has(address)) return;
      this.warnedVirtual.add(address);
      console.warn(`[VM memory] 0x${address.toString(16)}：${detail}`);
    }
    protected getDriveType(rootPathPtr: number): number {
      // Win32 允许 NULL 表示当前目录所在卷；本兼容层的当前目录位于 C:。
      if (!rootPathPtr) return this.driveTypes.get('C') ?? DRIVE_NO_ROOT_DIR;
      const root = this.readCString(rootPathPtr).trim();
      const drive = /^([a-z]):(?:[\\/]|$)/i.exec(root)?.[1]?.toUpperCase();
      if (!drive) return DRIVE_NO_ROOT_DIR;
      return this.driveTypes.get(drive) ?? DRIVE_NO_ROOT_DIR;
    }
    protected writeSystemTime(ptr: number, local: boolean): void {
      if (!ptr) return;
      const date = new Date(this.clock.wallNow());
      const values = local
        ? [
            date.getFullYear(),
            date.getMonth() + 1,
            date.getDay(),
            date.getDate(),
            date.getHours(),
            date.getMinutes(),
            date.getSeconds(),
            date.getMilliseconds(),
          ]
        : [
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            date.getUTCDay(),
            date.getUTCDate(),
            date.getUTCHours(),
            date.getUTCMinutes(),
            date.getUTCSeconds(),
            date.getUTCMilliseconds(),
          ];
      const bytes = new Uint8Array(16);
      for (let i = 0; i < values.length; i++) {
        bytes[i * 2] = values[i]! & 0xff;
        bytes[i * 2 + 1] = values[i]! >>> 8;
      }
      this.memory.write_memory(bytes, ptr);
    }
    protected systemTimeToFileTime(systemTime: number, fileTime: number): boolean {
      if (!systemTime || !fileTime) {
        this.lastError = 87; // ERROR_INVALID_PARAMETER
        return false;
      }
      const year = this.readU16(systemTime);
      const month = this.readU16(systemTime + 2);
      const day = this.readU16(systemTime + 6);
      const hour = this.readU16(systemTime + 8);
      const minute = this.readU16(systemTime + 10);
      const second = this.readU16(systemTime + 12);
      const milliseconds = this.readU16(systemTime + 14);
      if (
        year < 1601 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        milliseconds > 999
      ) {
        this.lastError = 87;
        return false;
      }
      const unixMilliseconds = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
      const normalized = new Date(unixMilliseconds);
      if (
        !Number.isFinite(unixMilliseconds) ||
        normalized.getUTCFullYear() !== year ||
        normalized.getUTCMonth() !== month - 1 ||
        normalized.getUTCDate() !== day ||
        normalized.getUTCHours() !== hour ||
        normalized.getUTCMinutes() !== minute ||
        normalized.getUTCSeconds() !== second ||
        normalized.getUTCMilliseconds() !== milliseconds
      ) {
        this.lastError = 87;
        return false;
      }
      const value = BigInt(unixMilliseconds) * 10_000n + 116_444_736_000_000_000n;
      this.writeU32(fileTime, Number(value & 0xffff_ffffn));
      this.writeU32(fileTime + 4, Number((value >> 32n) & 0xffff_ffffn));
      this.lastError = 0;
      return true;
    }
  };
}
