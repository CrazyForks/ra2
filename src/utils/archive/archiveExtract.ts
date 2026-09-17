/**
 * Main-thread archive-extraction wrapper: nested rar / 7z / self-extracting SFX EXEs to required top-level files. A Worker runs 7z-wasm and returns name-to-bytes mappings plus found/missing lists for the manifest panel.
 */
import type { ArchiveDirectoryRule, ArchiveExtractRequest, ArchiveExtractResponse } from './archiveExtractor';

export interface ArchiveExtractResult {
  /** Extracted top-level files, preserving original archive filename case. */
  files: Map<string, Uint8Array>;
  /** Found list: required files actually supplied by the archive. */
  found: string[];
  /** Missing list: wanted files absent from the archive. */
  missing: string[];
}

export interface ArchiveExtractOptions {
  /** Required top-level filenames, compared individually without case sensitivity. */
  wanted: string[];
  /** Add-on packages only: discover unknown filenames by suffix and explore all nested archives. */
  extensions?: string[];
  directoryRules?: readonly ArchiveDirectoryRule[];
  /** Phase-text callback, such as extraction depth. */
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
  /** Two-stage extraction for base games, not add-on maps; fall back to full extraction if the directory cannot establish a complete base game. */
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
    // All exits share one cleanup; invalidate queued messages and retained prioritize callbacks after completion.
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
        // The browser owns File; pass it to WORKERFS without copying the entire archive.
        send({ ...request, archive: bytes });
      } else {
        // Transfer only an exclusive copy, never detaching source bytes still owned by the caller.
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
