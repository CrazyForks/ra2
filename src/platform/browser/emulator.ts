import { V86 } from 'v86';

interface CpuScheduler {
  running: boolean;
  worker: { terminate(): void } | null;
  yield(delay: number, tick: number): void;
  yield_callback(tick: number): void;
  unregister_yield(): void;
}

/** v86 0.5.441 的内部调度接口；形状不匹配时保留上游实现。 */
export function installWorkerCpuScheduler(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object' || typeof MessageChannel !== 'function') return false;
  const engine = candidate as CpuScheduler;
  if (
    engine.running !== false ||
    typeof engine.yield !== 'function' ||
    typeof engine.yield_callback !== 'function' ||
    typeof engine.unregister_yield !== 'function' ||
    typeof engine.worker?.terminate !== 'function'
  )
    return false;

  const channel = new MessageChannel();
  const unregister = engine.unregister_yield.bind(engine);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 初始化尚未 run，没有需要迁移的 CPU tick。释放原来的嵌套计时 Worker。
  unregister();
  channel.port1.onmessage = (event: MessageEvent<{ delay: number; tick: number }>) => {
    if (closed) return;
    clearTimeout(timer);
    timer = undefined;
    const { delay, tick } = event.data;
    // 保留上游正等待时长和 yield_callback 的过期 tick 检查。
    if (delay < 1) engine.yield_callback(tick);
    else
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) engine.yield_callback(tick);
      }, delay);
  };
  engine.yield = (delay, tick) => {
    if (!closed) channel.port2.postMessage({ delay, tick });
  };
  engine.unregister_yield = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
    unregister();
  };
  return true;
}

/** 浏览器宿主拥有 CPU 调度端口；V86.destroy 沿原有所有权链释放它们。 */
export function createBrowserEmulator(options: ConstructorParameters<typeof V86>[0]): V86 {
  const emulator = new V86(options);
  // 只替换 Dedicated Worker 内的嵌套 Worker。Window 仍使用上游计时 Worker，
  // 避免把它的正等待迁移到可能被后台标签页限速的 Window.setTimeout。
  if (options.autostart !== false || typeof (globalThis as { importScripts?: unknown }).importScripts !== 'function')
    return emulator;
  let disposed = false;
  const ready = () => {
    emulator.remove_listener('emulator-ready', ready);
    if (!disposed) installWorkerCpuScheduler((emulator as unknown as { v86?: unknown }).v86);
  };
  const destroy = emulator.destroy.bind(emulator);
  emulator.destroy = async () => {
    disposed = true;
    emulator.remove_listener('emulator-ready', ready);
    await destroy();
  };
  emulator.add_listener('emulator-ready', ready);
  return emulator;
}
