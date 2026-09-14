/** 浏览器只负责 Worker 消息与 WASM 地址，提取算法与 CI 共用。 */
import wasmUrl from '7z-wasm/7zz.wasm?url';
import { createArchiveExtractor, type ArchiveExtractRequest } from './archiveExtractor';
export type { ArchiveExtractRequest, ArchiveExtractResponse } from './archiveExtractor';

const extract = createArchiveExtractor({
  locateFile: () => wasmUrl,
  post: (message, transfer = []) => (self as unknown as Worker).postMessage(message, transfer),
});
self.onmessage = (event: MessageEvent<ArchiveExtractRequest | { type: 'prioritize'; name: string }>) =>
  extract(event.data);
