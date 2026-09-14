/**
 * 同步 Win32 文件层的状态与挂载（mixin 拆分自 state.ts）：
 * 文件字节、稀疏区间、快速文件镜像与时间戳。挂在 ShimState 之后、
 * 所有文件 API 分派（kernel32）之前。
 */
import type { FileState } from '../win32';
import { normalizeGuestPath } from '../paths';
import { FAST_FILE_MIRROR_LIMIT, type Constructor, type ShimState } from './state';

export type ShimFilesChain = InstanceType<ReturnType<typeof withShimFiles>>;

export function withShimFiles<TBase extends Constructor<ShimState>>(Base: TBase) {
  return class extends Base {
    protected readonly files = new Map<string, Uint8Array>();
    /** 稀疏挂载的逻辑长度；bytes 只保存解析索引所需的前缀。 */
    protected readonly fileLogicalSizes = new Map<string, number>();
    /** 可由 provider 按区间补页的稀疏文件，以及已经取得的非前缀区间。 */
    protected readonly rangeBackedFiles = new Set<string>();
    protected readonly sparseFileRanges = new Map<string, Array<{ offset: number; bytes: Uint8Array }>>();
    protected readonly fileHandles = new Map<number, FileState>();
    protected nextFileHandle = 0x4000;
    protected readonly freeFileHandles: number[] = [];
    /** 文件层 per-file FILETIME（100ns 自 1601）：SetFileTime 写入 → FindFirstFileA 读回。 */
    protected readonly fileTimes = new Map<string, { created: bigint; accessed: bigint; written: bigint }>();
    /** PE 资源句柄 → 已映射的数据；LockResource 直接返回模块映像内指针。 */
    protected readonly loadedResources = new Map<number, { module: number; data: number; size: number }>();
    protected fileMirrorBytes = 0;
    protected readonly fastFileMirrorLimit: number;
    protected readonly fastFileMirrorBase: number;
    protected readonly fastFileMirrorTop: number;
    protected readonly fastFileMirrorFiles: ReadonlySet<string> | null;
    protected nextFastFileMirror: number;
    protected readonly sharedFileMirrors = new Map<string, { ptr: number; size: number }>();
    /** 大文件无法镜像时按“原因 + 路径”去重，避免游戏反复探测档案刷屏并拖慢主线程。 */
    protected readonly warnedFileMirrorSkips = new Set<string>();
    /** 未镜像句柄的 hypercall 读计数（诊断高频慢读用，句柄关闭时清除）。 */
    protected readonly unmirroredReads = new Map<number, number>();

    constructor(...args: any[]) {
      super(...args);
      this.fastFileMirrorLimit = this.options.fastFileMirrorLimit ?? FAST_FILE_MIRROR_LIMIT;
      this.fastFileMirrorBase = this.options.fastFileMirrorBase ?? 0;
      this.fastFileMirrorTop = this.options.fastFileMirrorTop ?? 0;
      this.fastFileMirrorFiles = this.options.fastFileMirrorFiles
        ? new Set(this.options.fastFileMirrorFiles.map(normalizeGuestPath))
        : null;
      this.nextFastFileMirror = this.fastFileMirrorBase;
      for (const [path, bytes] of this.options.files ?? []) this.mountFile(path, bytes);
    }

    protected noteFailedOpen(path: string): void {
      if (this.failedOpens.at(-1) === path) return;
      this.failedOpens.push(path);
      if (this.failedOpens.length > 16) this.failedOpens.shift();
    }

    /** 读取当前文件层中某挂载路径的字节（含客体写入后的状态）。 */
    getMountedFileBytes(path: string): Uint8Array | undefined {
      const normalized = normalizeGuestPath(path);
      if (!normalized) return undefined;
      const bytes = this.files.get(normalized);
      if (bytes) return bytes.slice();
      const mirror = this.sharedFileMirrors.get(normalized);
      return mirror ? this.memory.read_memory(mirror.ptr, mirror.size).slice() : undefined;
    }

    /** 路径是否已有 canonical 快照；大只读档案可据此避免反复 fetch/复制。 */
    hasMountedFile(path: string): boolean {
      const normalized = normalizeGuestPath(path);
      return normalized ? this.files.has(normalized) || this.sharedFileMirrors.has(normalized) : false;
    }

    /** VM 执行期间可由 host 按需把原版资源挂载进同步 Win32 文件层。 */
    mountFile(path: string, bytes: Uint8Array, takeOwnership = false, logicalSize = bytes.length): void {
      const normalized = normalizeGuestPath(path);
      // Provider/read buffers may be reused by the browser or modified by the
      // caller after this synchronous mount.  The Win32 layer owns its snapshot;
      // otherwise a later fetch/decode can silently corrupt an already-open map.
      if (normalized) {
        this.storeFile(normalized, takeOwnership ? bytes : bytes.slice());
        if (logicalSize > bytes.length) this.fileLogicalSizes.set(normalized, logicalSize);
      }
    }

    /** 标记稀疏文件可在 ReadFile 边界由 host 按需取得真实区间。 */
    markFileRangeBacked(path: string): void {
      const normalized = normalizeGuestPath(path);
      if (normalized && this.fileLogicalSizes.has(normalized)) this.rangeBackedFiles.add(normalized);
    }

    /** 把 provider 取得的区间补进稀疏文件，不分配完整 300+MiB 容器。 */
    mountFileRange(path: string, offset: number, bytes: Uint8Array): void {
      const normalized = normalizeGuestPath(path);
      if (!normalized || !bytes.length || !this.fileLogicalSizes.has(normalized)) return;
      const ranges = this.sparseFileRanges.get(normalized) ?? [];
      ranges.push({ offset: offset >>> 0, bytes });
      ranges.sort((left, right) => left.offset - right.offset);
      this.sparseFileRanges.set(normalized, ranges);
      this.rangeBackedFiles.add(normalized);
    }

    /** 下一次同步 ReadFile 是否落在尚未补页的稀疏区；VmCore 据此暂停客体做 Range fetch。 */
    inspectFileReadRequest(
      handle: number,
      requested: number,
    ): {
      path: string;
      offset: number;
      length: number;
      totalSize: number;
    } | null {
      const file = this.fileHandles.get(handle >>> 0);
      if (!file || !this.rangeBackedFiles.has(file.path) || !requested) return null;
      const end = Math.min(file.size, file.position + (requested >>> 0));
      if (end <= file.position || this.hasFileRange(file.path, file.position, end - file.position)) return null;
      const chunk = 2 * 1024 * 1024;
      const offset = Math.floor(file.position / chunk) * chunk;
      const rangeEnd = Math.min(file.size, Math.ceil(end / chunk) * chunk);
      return { path: file.path, offset, length: rangeEnd - offset, totalSize: file.size };
    }

    protected hasFileRange(path: string, offset: number, length: number): boolean {
      const prefix = this.files.get(path);
      let cursor = offset;
      const end = offset + length;
      if (prefix && cursor < prefix.length) cursor = Math.min(end, prefix.length);
      const ranges = this.sparseFileRanges.get(path) ?? [];
      while (cursor < end) {
        const hit = ranges.find((range) => range.offset <= cursor && range.offset + range.bytes.length > cursor);
        if (!hit) return false;
        cursor = Math.min(end, hit.offset + hit.bytes.length);
      }
      return true;
    }

    protected copyFileRange(path: string, offset: number, length: number, target: number): number {
      const prefix = this.files.get(path);
      const ranges = this.sparseFileRanges.get(path) ?? [];
      let cursor = offset;
      const end = offset + length;
      let written = 0;
      while (cursor < end) {
        if (prefix && cursor < prefix.length) {
          const count = Math.min(end - cursor, prefix.length - cursor);
          this.memory.write_memory(prefix.subarray(cursor, cursor + count), target + written);
          cursor += count;
          written += count;
          continue;
        }
        const hit = ranges.find((range) => range.offset <= cursor && range.offset + range.bytes.length > cursor);
        if (!hit) {
          const next = ranges
            .filter((range) => range.offset > cursor)
            .reduce((value, range) => Math.min(value, range.offset), end);
          const count = Math.max(1, Math.min(end, next) - cursor);
          this.zero(target + written, count);
          cursor += count;
          written += count;
          continue;
        }
        const sourceOffset = cursor - hit.offset;
        const count = Math.min(end - cursor, hit.bytes.length - sourceOffset);
        this.memory.write_memory(hit.bytes.subarray(sourceOffset, sourceOffset + count), target + written);
        cursor += count;
        written += count;
      }
      return written;
    }

    /** 写入/更新文件层内容并同步时间戳（created 首次建立，written/accessed 随写入刷新）。 */
    protected storeFile(path: string, bytes: Uint8Array): void {
      this.files.set(path, bytes);
      this.fileLogicalSizes.delete(path);
      this.rangeBackedFiles.delete(path);
      this.sparseFileRanges.delete(path);
      const now = this.guestNowFileTime();
      const times = this.fileTimes.get(path);
      if (!times) this.fileTimes.set(path, { created: now, accessed: now, written: now });
      else {
        times.accessed = now;
        times.written = now;
      }
    }

    /** 当前客体时间（毫秒）→ FILETIME（1601-01-01 起 100ns，BigInt 保精度）。 */
    protected guestNowFileTime(): bigint {
      return BigInt(Math.round(this.clock.wallNow())) * 10_000n + 116_444_736_000_000_000n;
    }

    /** 已知的虚拟目录，或任何已挂载文件的父目录，视为“存在目录”。 */
    protected isVirtualDirectory(path: string): boolean {
      if (path === 'windows' || path === 'windows/system' || path === 'windows/temp' || path === 'game') {
        return true;
      }
      const prefix = `${path}/`;
      for (const existing of this.files.keys()) {
        if (existing.startsWith(prefix)) return true;
      }
      return false;
    }
  };
}
