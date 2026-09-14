/**
 * VM 运行期间的屏幕常亮（Android Chrome；iOS 仅主屏 PWA）。
 * 标签页切后台时浏览器自动释放，恢复可见时重新请求。
 * 桌面 Chrome 无 wakeLock，直接 no-op。
 */
export function installWakeLock(): () => void {
  if (!('wakeLock' in navigator)) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let released = false;

  const request = (): void => {
    if (released || sentinel || document.visibilityState !== 'visible') return;
    void navigator.wakeLock
      .request('screen')
      .then((lock) => {
        if (released) {
          void lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      })
      .catch(() => {
        // 页面非激活或浏览器策略拒绝；下次 visibilitychange 会重试。
      });
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') request();
  };

  request();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    const lock = sentinel;
    sentinel = null;
    void lock?.release();
  };
}
