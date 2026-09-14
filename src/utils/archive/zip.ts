/** 通用 ZIP 读取：原生流解压与 fflate 回退，保留旧编码和重复条目的处理约定。 */
import { Unzip, UnzipInflate } from 'fflate';
import { normalizeWindowsPath } from '../windowsPath';

export interface ZipArchiveEntry {
  /** normalizeWindowsPath 归一化后的客体内路径（小写、无盘符）。 */
  path: string;
  /** 原始条目名末段（保留大小写），用于构造导入计划里的 File。 */
  name: string;
  /** 解压后的文件内容；provider 直接持有，调用方不得再修改。 */
  bytes: Uint8Array<ArrayBuffer>;
}

/** 单批推入 Unzip 的压缩字节数：批间让出主线程，解压几百 MB 也不会卡死 UI。 */
const PUSH_CHUNK_BYTES = 1024 * 1024;
/** 解压进度回读节流（按字节累计，避免逐块刷屏）。 */
const PROGRESS_INTERVAL_MS = 100;

/** 旧 ZIP 未标 UTF-8 时 fflate 返回逐字节字符；从中央目录确认标志后再解码。 */
function legacyZipNames(bytes: Uint8Array): Map<string, string> {
  const names = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== bytes.length)
      continue;
    let offset = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true);
    for (let i = 0; i < count && offset + 46 <= end; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const flags = view.getUint16(offset + 8, true);
      const length = view.getUint16(offset + 28, true);
      if (offset + 46 + length > end) break;
      if (!(flags & 0x800)) {
        const raw = bytes.subarray(offset + 46, offset + 46 + length);
        const original = Array.from(raw, (byte) => String.fromCharCode(byte)).join('');
        for (const encoding of ['utf-8', 'gb18030']) {
          try {
            names.set(original, new TextDecoder(encoding, { fatal: true }).decode(raw));
            break;
          } catch {
            /* 尝试下一种旧归档编码；无法解码时保持原字节映射。 */
          }
        }
      }
      offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    break;
  }
  return names;
}

/** 跳过目录占位、macOS 归档垃圾（__MACOSX）与 AppleDouble 元数据（._*）条目。 */
function isUsableZipEntry(name: string): boolean {
  if (name.endsWith('/')) return false;
  return name.split('/').every((part) => !part.startsWith('._') && part !== '__MACOSX');
}

/** 原生解压的并发条目数：native inflate 异步执行，多条目并行摊薄大包解压时间。 */
const NATIVE_UNZIP_CONCURRENCY = 4;

interface ZipCdEntry {
  /** 中央目录原始条目名（可能未按 UTF-8 解码）。 */
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** 解析 ZIP 中央目录（EOCD 定位 + 条目元数据），原生解压路径用。 */
function readCentralDirectory(bytes: Uint8Array): ZipCdEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    if (end + 22 + view.getUint16(end + 20, true) !== bytes.length) continue;
    eocd = end;
    break;
  }
  if (eocd < 0) throw new Error('ZIP 中央目录未找到');
  const count = view.getUint16(eocd + 10, true);
  const entries: ZipCdEntry[] = [];
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录条目损坏');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    // UTF-8 标志置位时按规范直接解码；否则 latin1 原样保留，交给 legacyZipNames 猜旧编码。
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = flags & 0x800 ? new TextDecoder('utf-8').decode(rawName) : new TextDecoder('latin1').decode(rawName);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 用原生 DecompressionStream 解单个条目（ZIP raw deflate）；stored 条目直接切片。 */
async function inflateZipEntry(bytes: Uint8Array, entry: ZipCdEntry): Promise<Uint8Array<ArrayBuffer>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed.slice();
  if (entry.method !== 8) throw new Error(`不支持的压缩方式：${entry.method}`);
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const write = (async () => {
    // fetch/文件读入的 zip 缓冲一定是 ArrayBuffer 承载；此处仅为满足 BufferSource 类型。
    await writer.write(compressed as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  await write;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** 原生 DecompressionStream 解压：native inflate 比 JS 快数倍，且异步不卡主线程。 */
async function readZipArchiveNative(
  bytes: Uint8Array,
  onProgress?: (extractedFiles: number, extractedBytes: number) => void,
): Promise<ZipArchiveEntry[]> {
  const legacyNames = legacyZipNames(bytes);
  const directory = readCentralDirectory(bytes);
  const known = new Set<string>();
  const chosen: { entry: ZipCdEntry; name: string; normalized: string }[] = [];
  for (const entry of directory) {
    const name = legacyNames.get(entry.name) ?? entry.name;
    const normalized = normalizeWindowsPath(name);
    if (!isUsableZipEntry(name) || !normalized || known.has(normalized)) continue;
    known.add(normalized);
    chosen.push({ entry, name, normalized });
  }
  const entries: ZipArchiveEntry[] = new Array(chosen.length);
  let extractedFiles = 0;
  let extractedBytes = 0;
  let lastReportAt = 0;
  const report = (): void => {
    if (!onProgress) return;
    const now = performance.now();
    if (now - lastReportAt < PROGRESS_INTERVAL_MS) return;
    lastReportAt = now;
    onProgress(extractedFiles, extractedBytes);
  };
  let next = 0;
  const process = async (): Promise<void> => {
    while (next < chosen.length) {
      const index = next++;
      const item = chosen[index]!;
      const output = await inflateZipEntry(bytes, item.entry);
      entries[index] = {
        path: item.normalized,
        name: item.name.split('/').filter(Boolean).pop() ?? item.name,
        bytes: output,
      };
      extractedFiles++;
      extractedBytes += output.length;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(NATIVE_UNZIP_CONCURRENCY, chosen.length) }, () => process()));
  onProgress?.(extractedFiles, extractedBytes);
  return entries;
}

/**
 * 异步流式解压 zip 为条目列表。大小写归一化后同路径的条目保留第一个（ZIP 里
 * 同名大小写变体通常只是同一文件），其余跳过。返回顺序为归档内出现顺序。
 */
export async function readZipArchive(
  bytes: Uint8Array,
  onProgress?: (extractedFiles: number, extractedBytes: number) => void,
): Promise<ZipArchiveEntry[]> {
  // 原生解压优先（Chromium/FF/Safari/Node 均提供）；异常或不可用时回退 fflate。
  if (typeof DecompressionStream === 'function') {
    try {
      return await readZipArchiveNative(bytes, onProgress);
    } catch (error) {
      console.warn('[ZIP] 原生解压失败，回退 fflate：', error);
    }
  }
  const entries: ZipArchiveEntry[] = [];
  const legacyNames = legacyZipNames(bytes);
  const known = new Set<string>();
  let extractedFiles = 0;
  let extractedBytes = 0;
  let lastReportAt = 0;
  let streamError: unknown = null;
  const report = (): void => {
    if (!onProgress) return;
    const now = performance.now();
    if (now - lastReportAt < PROGRESS_INTERVAL_MS) return;
    lastReportAt = now;
    onProgress(extractedFiles, extractedBytes);
  };
  const unz = new Unzip((file) => {
    const name = legacyNames.get(file.name) ?? file.name;
    const normalized = normalizeWindowsPath(name);
    if (!isUsableZipEntry(name) || !normalized) return;
    if (known.has(normalized)) return;
    known.add(normalized);
    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (err, data, final) => {
      if (err) {
        streamError = streamError ?? err;
        return;
      }
      if (data && data.length) {
        chunks.push(data);
        total += data.length;
        extractedBytes += data.length;
        report();
      }
      if (final) {
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        entries.push({
          path: normalized,
          name: name.split('/').filter(Boolean).pop() ?? name,
          bytes: combined,
        });
        extractedFiles++;
        report();
      }
    };
    file.start();
  });
  unz.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += PUSH_CHUNK_BYTES) {
      unz.push(
        bytes.subarray(offset, Math.min(offset + PUSH_CHUNK_BYTES, bytes.length)),
        offset + PUSH_CHUNK_BYTES >= bytes.length,
      );
      if (streamError) break;
      // 解压是同步 CPU 密集循环：批间让出事件循环，进度文字与取消状态才能更新。
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  } catch (error) {
    streamError = streamError ?? error;
  }
  if (streamError) {
    throw new Error(`ZIP 解压失败：${streamError instanceof Error ? streamError.message : String(streamError)}`);
  }
  onProgress?.(extractedFiles, extractedBytes);
  return entries;
}

export function formatZipBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
