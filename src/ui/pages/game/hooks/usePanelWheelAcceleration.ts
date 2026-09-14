import { useEffect } from 'react';
/** 网页主菜单/调试面板的滚轮加速。VM 在 Worker 高负载时浏览器默认的一小格
 *  滚动显得尤其迟缓；这里只接管网页面板，不影响画布内传给游戏的 WM_MOUSEWHEEL。 */
export function usePanelWheelAcceleration(): void {
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const origin = event.target instanceof Element ? event.target : null;
      const panel = origin?.closest<HTMLElement>('#ui .panel, #vm-debug');
      if (!origin || !panel || origin.closest('input[type="range"]')) return;
      let scroller: HTMLElement | null = origin instanceof HTMLElement ? origin : origin.parentElement;
      while (scroller && scroller !== panel.parentElement) {
        const style = getComputedStyle(scroller);
        if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 1) break;
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === panel.parentElement) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 24
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1;
      const accelerated = Math.max(-640, Math.min(640, event.deltaY * unit * 2.5));
      if (!accelerated) return;
      scroller.scrollBy({ top: accelerated, behavior: 'auto' });
      event.preventDefault();
    };
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => document.removeEventListener('wheel', onWheel, { capture: true });
  }, []);
}
