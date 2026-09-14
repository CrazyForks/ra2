export type KeyboardLockState = 'inactive' | 'pending' | 'active' | 'unavailable' | 'denied';

interface KeyboardLock {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
}

let controllerGeneration = 0;

/** 只在游戏全屏时捕获真实 Esc；解锁事件没有按键来源信息，绝不能据此伪造 Esc。 */
export function installFullscreenKeyboardLock(
  canvas: HTMLCanvasElement,
  report: (state: KeyboardLockState) => void,
): () => void {
  const generation = ++controllerGeneration;
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  let revision = 0;
  let disposed = false;
  const isFullscreen = () => !!document.fullscreenElement?.contains(canvas);
  const changed = () => {
    if (generation !== controllerGeneration) return;
    const request = ++revision;
    if (!isFullscreen()) {
      keyboard?.unlock?.();
      report('inactive');
      return;
    }
    if (!keyboard?.lock || !keyboard.unlock) {
      report('unavailable');
      return;
    }
    report('pending');
    void (async () => {
      try {
        await keyboard.lock(['Escape']);
        // 换游戏后旧 VM 的权限结果不得解除新 VM 的键盘锁。
        if (generation !== controllerGeneration) return;
        // 权限弹窗可能在退出全屏或销毁 VM 后才结束；不得遗留键盘锁。
        // 旧请求也不能 unlock 后来进入全屏的新请求。
        if (disposed || !isFullscreen()) keyboard.unlock();
        else if (revision === request) report('active');
      } catch {
        if (generation === controllerGeneration && !disposed && revision === request && isFullscreen())
          report('denied');
      }
    })();
  };
  document.addEventListener('fullscreenchange', changed);
  changed();
  return () => {
    disposed = true;
    revision++;
    document.removeEventListener('fullscreenchange', changed);
    if (generation === controllerGeneration) keyboard?.unlock?.();
  };
}
