/**
 * 归档提取主线程封装：rar / 7z / SFX 自解压 exe（多层）→ 顶层所需文件映射。
 * Worker 内跑 7z-wasm；返回 { name → bytes } 与命中/缺失清单，供清单面板
 * 显示「缺哪些文件 / 加载了哪些文件」。
 */
import type { ArchiveDirectoryRule, ArchiveExtractRequest, ArchiveExtractResponse } from './archiveExtractor';

export interface ArchiveExtractResult {
  /** 提取出的文件映射（顶层文件，大小写保留归档原名）。 */
  files: Map<string, Uint8Array>;
  /** 命中清单（归档实际提供的所需文件）。 */
  found: string[];
  /** 缺失清单（wanted 中归档没有提供的文件）。 */
  missing: string[];
}

export interface ArchiveExtractOptions {
  /** 需要的顶层文件名（任意大小写，逐个比对）。 */
  wanted: string[];
  /** 附加包专用：按后缀发现未知文件名，并探索所有嵌套归档。 */
  extensions?: string[];
  directoryRules?: readonly ArchiveDirectoryRule[];
  /** 阶段文案回调（解压层数等）。 */
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
  /** 游戏本体两层解压；附加地图包不使用。目录不足以确认完整本体时回退整包。 */
  layers?: { required: string[]; startup: string[] };
  onCatalog?: (names: string[]) => void;
  onFile?: (name: string, bytes: Uint8Array) => void;
  onStartupReady?: () => void;
  onPrioritizeReady?: (prioritize: (name: string) => void) => void;
}

export function extractArchiveFiles(
  bytes: Uint8Array | Blob,
  options: ArchiveExtractOptions,
): Promise<ArchiveExtractResult> {
  return new Promise((resolve, reject) => {
    const { wanted, extensions, onStatus, signal } = options;
    const files = new Map<string, Uint8Array>();
    let worker: Worker | undefined;
    let settled = false;
    // 所有出口共用一次清理；已排队的消息和保留的 prioritize 回调在结束后失效。
    const cleanup = () => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException('归档提取已取消', 'AbortError'));
    const send = (
      request: ArchiveExtractRequest | { type: 'prioritize'; name: string },
      transfer: Transferable[] = [],
    ) => {
      if (settled) return;
      try {
        worker!.postMessage(request, transfer);
      } catch (error) {
        fail(error);
      }
    };
    try {
      if (signal?.aborted) {
        abort();
        return;
      }
      worker = new Worker(new URL('./archiveExtractWorker.ts', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = (event: MessageEvent<ArchiveExtractResponse>) => {
        if (settled) return;
        try {
          const message = event.data;
          if (message.type === 'status') {
            onStatus?.(message.message);
          } else if (message.type === 'catalog') {
            options.onCatalog?.(message.names);
          } else if (message.type === 'startup-ready') {
            options.onStartupReady?.();
          } else if (message.type === 'file') {
            files.set(message.name, message.bytes);
            options.onFile?.(message.name, message.bytes);
            if (!settled) onStatus?.(`已提取 ${message.name}（${formatArchiveBytes(message.bytes.length)}）`);
          } else if (message.type === 'done') {
            const found = message.found;
            const lower = new Set(found.map((name) => name.toLowerCase()));
            const missing = wanted.filter((name) => !lower.has(name.toLowerCase()));
            cleanup();
            resolve({ files, found, missing });
          } else {
            fail(new Error(message.message));
          }
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) => fail(new Error(event.message || '归档提取 Worker 异常'));
      worker.onmessageerror = () => fail(new Error('归档提取 Worker 消息解码失败'));
      options.onPrioritizeReady?.((name) => send({ type: 'prioritize', name }));
      if (settled) return;
      const request = {
        type: 'extract' as const,
        wanted,
        extensions,
        directoryRules: options.directoryRules,
        layers: options.layers,
      };
      if (bytes instanceof Blob) {
        // File 由浏览器持有，交给 WORKERFS，避免复制整包。
        send({ ...request, archive: bytes });
      } else {
        // 仅移交独占副本，不能拆走调用方持有的源字节。
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        send({ ...request, buffer }, [buffer]);
      }
    } catch (error) {
      fail(error);
    }
  });
}

function formatArchiveBytes(size: number): string {
  return size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024
      ? `${Math.floor(size / 1024)} KB`
      : `${size} B`;
}
