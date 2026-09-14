import { installVmWorker } from './vmWorkerController';
import type { MainToWorkerMessage, WorkerToMainMessage } from './vmProtocol';

interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
}

// `self` 只在真正运行于 Dedicated Worker 时存在，避免在 Node 测试环境误触。
if (typeof self !== 'undefined') {
  installVmWorker(self as unknown as WorkerScope);
}
