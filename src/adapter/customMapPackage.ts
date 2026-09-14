import { extractArchiveFiles } from '../utils/archive/archiveExtract';
import { archiveExtensionKey } from '../utils/archive/archiveFileKey';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import type { VmAttachResult } from './vmShell';

/** 只收 CSF / YRM / MPR；不执行安装器，不把包中的 EXE、DLL 或规则文件挂进游戏。 */
export async function readCustomMapPackage(
  bytes: Uint8Array,
  onStatus?: (message: string) => void,
): Promise<Map<string, Uint8Array>> {
  if (bytes.length > 128 * 1024 * 1024) throw new Error('附加压缩包超过 128 MB');
  const result = await extractArchiveFiles(bytes, { wanted: [], extensions: ['.csf', '.yrm', '.mpr'], onStatus });
  return validateCustomMapFiles(result.files);
}

export function validateCustomMapFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const normalized = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    const key = archiveExtensionKey(path, ['.csf', '.yrm', '.mpr']);
    if (!key || !bytes.length) throw new Error(`无效的附加文件：${path}`);
    if (normalized.has(key)) throw new Error(`压缩包存在同名文件：${key}`);
    normalized.set(key, bytes);
  }
  if (!normalized.size) throw new Error('压缩包中没有找到 .csf、.yrm 或 .mpr 文件');
  return normalized;
}

/** 与主线程/Worker 共用同一覆盖语义；客体改写只落会话，不污染原安装目录。 */
export function mountCustomMapFiles(source: GameSource, files: ReadonlyMap<string, Uint8Array>): GameSource {
  if (!files.size) return source;
  const normalized = validateCustomMapFiles(files);
  // 对比地图兼容性时禁用附加 CSF，避免覆盖本体文本表；旧缓存也走此闸门。
  // 仅过滤挂载副本，不删除提取结果，主线程与 Worker 的行为保持一致。
  for (const name of normalized.keys()) if (name.endsWith('.csf')) normalized.delete(name);
  if (!normalized.size) return source;
  return { ...source, files: new OverlayGameFileProvider(source.files, normalized, ' + 自定义地图', true) };
}

/** 首版热挂载只新增地图；已有文件可能被客体打开或缓存，不在运行中覆盖。 */
export async function prepareDynamicMaps(
  base: GameFileProvider,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<{ provider: GameFileProvider; result: VmAttachResult }> {
  const normalized = files.size ? validateCustomMapFiles(files) : new Map<string, Uint8Array>();
  const listing = await base.list('');
  const existing = new Set(listing?.map((name) => name.toLowerCase()));
  const added = new Map<string, Uint8Array>();
  const result: VmAttachResult = { attached: [], existing: [] };
  for (const [name, bytes] of normalized) {
    // 同时在接收端过滤，旧缓存或直接 RPC 传入的 CSF 都不能绕过。
    if (name.endsWith('.csf')) continue;
    const present =
      listing !== null
        ? existing.has(name)
        : !!(base.readPrefix ? await base.readPrefix(name, 1) : await base.read(name));
    if (present) result.existing.push(name);
    else {
      added.set(name, bytes);
      result.attached.push(name);
    }
  }
  return {
    provider: added.size ? new OverlayGameFileProvider(base, added, ' + 动态地图', true) : base,
    result,
  };
}
