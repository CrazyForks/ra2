import type { SessionRuntime } from './runtime';

/** 统一处理启动失败与清理；不依赖页面、React 或具体 VM 工厂。 */
export async function startSessionRuntime<T extends SessionRuntime>(
  start: () => Promise<T | null>,
  onStartupError: (error: unknown, detail: string) => void,
  releaseRuntime: () => Promise<void>,
  onStarted: (vm: T) => void = () => {},
): Promise<T | null> {
  try {
    const vm = await start();
    if (vm) onStarted(vm);
    return vm;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onStartupError(error, detail);
    try {
      await releaseRuntime();
    } catch (cleanupError) {
      console.error('[VM] 启动失败后的清理失败', cleanupError);
    }
    return null;
  }
}
