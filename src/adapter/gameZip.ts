/**
 * 游戏包解析：ZIP 与 NSIS 安装包统一入口（本地压缩包导入）。浏览器内解包为
 * 会话级 provider，进入与文件夹选择相同的发现流程（discoverGameSources →
 * validateGameDirectory）。解压产物由 provider 直接持有（免复制），存档写回
 * 浏览器 IndexedDB。
 */
import { readZipArchive, formatZipBytes } from '../utils/archive/zip';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { decodeLzmaStream } from '../utils/archive/lzmaDecode';
import { findNsisArchive, parseNsisFiles } from '../utils/archive/nsis';

export interface RemotePackageOptions {
  /** 阶段状态文案（解压进度），供页面进度显示。 */
  onStatus?: (message: string) => void;
}

/**
 * 解析内存中的游戏包字节：ZIP 或 NSIS 安装包（solid LZMA）。
 * 本地压缩包导入（file input）专用；NSIS 解码在 Worker 中进行，不阻塞主线程。
 */
export async function loadRemoteGamePackageBytes(
  bytes: Uint8Array,
  options: RemotePackageOptions = {},
): Promise<SessionGameFileProvider> {
  const { onStatus } = options;
  // ZIP 与 NSIS 都从魔数识别；NSIS 是 MZ 壳 + 签名，ZIP 是 PK 头。
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = await readZipArchive(bytes, (files, extractedBytes) => {
      onStatus?.(`正在解压游戏包：已 ${files} 个文件 / ${formatZipBytes(extractedBytes)}`);
    });
    return new SessionGameFileProvider('ZIP 压缩包', new Map(entries.map((entry) => [entry.path, entry.bytes])));
  }
  const nsis = findNsisArchive(bytes);
  if (nsis) {
    onStatus?.('正在解压安装包（LZMA 解码，约需一分钟）…');
    const stream = bytes.subarray(nsis.streamStart);
    // 整流解码时总长未知，SDK 只有 0/100 两端进度；心跳（-1）期间显示已用时长。
    let decodeStartedAt: number | null = null;
    const decoded = await decodeLzmaStream({
      stream,
      onProgress: (percent) => {
        if (percent < 0) {
          decodeStartedAt ??= Date.now();
          onStatus?.(`正在解压安装包… 已用时 ${Math.floor((Date.now() - decodeStartedAt) / 1000)}s`);
        } else {
          onStatus?.(`正在解压安装包：${Math.floor(percent * 100)}%`);
        }
      },
    });
    const entries = parseNsisFiles(decoded);
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
      files.set(entry.path, decoded.subarray(entry.offset + 4, entry.offset + 4 + entry.size));
    }
    onStatus?.(`解压完成：${entries.length} 个文件`);
    return new SessionGameFileProvider('本地安装包', files);
  }
  throw new Error('无法识别的游戏包格式（需要 ZIP 或 NSIS 安装包）');
}
