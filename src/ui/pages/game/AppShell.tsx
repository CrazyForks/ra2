import { useEffect, useRef } from 'react';
import { BootRegion, DebugRegion, Dialogs, MainRegion, ScreenStatus, Toolbar } from './components/AppRegions';
import { gameRunning, mainPanel, sourceRequest } from './state/uiState';
import { useStore } from '../../shared/state/useStore';
import { usePanelWheelAcceleration } from './hooks/usePanelWheelAcceleration';

/** 唯一 React 树拥有全部网页 UI；ref 仅作为 VM 图形/输入适配器的边界。 */
export function AppShell() {
  usePanelWheelAcceleration();
  const running = useStore(gameRunning);
  const choosingSource = useStore(sourceRequest) !== null;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import('./page')
      .then((runtime) => {
        if (cancelled) return;
        stop = runtime.stopVmPage;
        return runtime.startVmPage(canvas.current!);
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortError') {
          stop?.();
          mainPanel.set({ phase: 'error', detail: String(error) });
        }
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return (
    <div className={choosingSource ? 'game-home' : running ? 'game-running' : undefined}>
      <Toolbar />
      <div id="app-layout">
        <div id="stage">
          <div id="screen-frame">
            <canvas ref={canvas} id="screen" width="800" height="600"></canvas>
            <ScreenStatus />
            <span className="lock-corner lock-corner-tl" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-tr" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-bl" aria-hidden="true"></span>
            <span className="lock-corner lock-corner-br" aria-hidden="true"></span>
            <div id="client-page" aria-hidden="true"></div>
          </div>
          <BootRegion />
        </div>
        <DebugRegion />
      </div>
      <div id="vm-touch-controls" hidden aria-label="触屏虚拟按键">
        <button className="touch-key touch-collapse" type="button" data-role="collapse" aria-label="折叠虚拟按键">
          ⌨
        </button>
        <button className="touch-key" type="button" data-code="Escape" aria-label="Esc 键">
          Esc
        </button>
        <button className="touch-key" type="button" data-code="Enter" aria-label="Enter 键">
          Enter
        </button>
        <button className="touch-key" type="button" data-code="Space" aria-label="空格键">
          空格
        </button>
        <div className="touch-dpad" aria-label="方向键">
          <button className="touch-key" type="button" data-code="ArrowUp" aria-label="上方向键">
            ▲
          </button>
          <button className="touch-key" type="button" data-code="ArrowLeft" aria-label="左方向键">
            ◀
          </button>
          <button className="touch-key" type="button" data-code="ArrowRight" aria-label="右方向键">
            ▶
          </button>
          <button className="touch-key" type="button" data-code="ArrowDown" aria-label="下方向键">
            ▼
          </button>
        </div>
      </div>
      <button
        id="vm-touch-joystick"
        type="button"
        data-role="joystick"
        hidden
        aria-label="摇杆：拖动摇杆向上下左右卷动地图"
      >
        <span className="joystick-knob"></span>
      </button>
      <MainRegion />
      <Dialogs />
    </div>
  );
}
