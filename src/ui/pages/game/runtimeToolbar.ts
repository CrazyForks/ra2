import type { ReShadeMode } from '../../../graphics/reshadePreset';
import { toolbarState } from './state/uiState';
import type { ToolbarModel } from './components/RuntimeToolbarView';
import type { UpscaleMode } from './vmFrameRenderer';
import type { ProbeImage } from './experiments/modelProbe';
import type { CheatGuideGameId } from './cheatGuides';
import { gameResolutionValue, type GameResolution } from '../../../games/resolution';

export interface RuntimeToolbar {
  setRendererDetail(detail: string): void;
  setGameTitle(title: string): void;
  recordCall(count?: number): void;
  recordLogicFrame(count?: number): void;
  recordPresentedFrame(): void;
  setCheatGame(game: CheatGuideGameId | null): void;
  setResolution(resolution: GameResolution | null): void;
  setReShadeMode(mode: ReShadeMode): void;
  setUpscaleMode(mode: UpscaleMode): void;
  setMapsAvailable(available: boolean): void;
  /** 选中时钟倍率（按钮点击与键盘快捷键 [ ] 共用）：同步 aria-pressed 并回调页面。 */
  pressClockRate(rate: number): void;
  destroy(): void;
}

export interface RuntimeToolbarCallbacks {
  onClockRate(rate: number): void;
  onResolution(value: string): Promise<void>;
  onVolume(linear: number): void;
  onPerformance(summary: string): void;
  onSendCheatText(text: string): void;
  onSendCheatKey(code: string): void;
  onChangeSource(): Promise<void>;
  onCustomMaps?(): Promise<void>;
  onReShadeMode?(mode: ReShadeMode): void;
  onUpscaleMode?(mode: UpscaleMode): void;
  onCaptureProbe?(size: number): ProbeImage;
  onLiveModel?(file: File | null, modelId?: import('./experiments/modelProbe').LiveModelId): Promise<void>;
  onQuickStart?(): Promise<void>;
  onDownloadSave(): Promise<void>;
  /** true 表示导入完成并即将重载；false 表示用户取消。 */
  onUploadSave(file: File): Promise<boolean>;
}

/** 高频计数保留在控制器，500ms 采样后才通知 React；不让组件参与逐帧/逐 hypercall 更新。 */
export function installRuntimeToolbar(
  callbacks: RuntimeToolbarCallbacks,
  canvas: HTMLCanvasElement,
  rendererBackend: 'WebGL2' | 'Canvas 2D',
  rendererDetail: string,
): RuntimeToolbar {
  let disposed = false;
  let hypercalls = 0,
    logicFrames = 0,
    presentedFrames = 0,
    longTaskMs = 0;
  let sampleStarted = performance.now();
  const label = /llvmpipe|swiftshader|software|mesa offscreen/i.test(rendererDetail)
    ? `${rendererBackend}（软件）`
    : rendererBackend;
  const model: ToolbarModel = {
    title: 'RA2 VM',
    fps: `${label} · VM -- · 显示 --`,
    performance: 'HC --/s · 阻塞 --',
    performanceTitle: '',
    rendererDetail,
    cheatGame: null,
    resolution: '',
    rate: 1,
    upscaleMode: 'off',
    reshadeMode: 'off',
    mapsAvailable: false,
  };
  const publish = () => {
    if (disposed) return;
    toolbarState.set({
      model: { ...model },
      callbacks,
      canvas,
      pressRate: pressClockRate,
      setResolution(value) {
        model.resolution = value;
        publish();
      },
    });
  };
  const pressClockRate = (rate: number) => {
    if (![1, 2, 4].includes(rate) || disposed) return;
    model.rate = rate;
    try {
      localStorage.setItem('vm-clock-rate', String(rate));
    } catch {
      /* 隐私模式只影响下次恢复。 */
    }
    callbacks.onClockRate(rate);
    publish();
  };
  try {
    const stored = Number(localStorage.getItem('vm-clock-rate'));
    if ([1, 2, 4].includes(stored)) {
      model.rate = stored;
      callbacks.onClockRate(stored);
    }
  } catch {
    /* 本地存储可选。 */
  }
  const observer =
    typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTaskMs += entry.duration;
        })
      : null;
  observer?.observe({ entryTypes: ['longtask'] });
  publish();
  const timer = window.setInterval(() => {
    const now = performance.now(),
      elapsed = Math.max(1, now - sampleStarted);
    model.fps = `${label} · VM ${((logicFrames * 1000) / elapsed).toFixed(1)} · 显示 ${((presentedFrames * 1000) / elapsed).toFixed(1)}`;
    const calls = ((hypercalls * 1000) / elapsed).toFixed(0);
    const blocked = Math.min(100, (Math.max(longTaskMs, Math.max(0, elapsed - 550)) * 100) / elapsed).toFixed(0);
    model.performance = `HC ${calls}/s · 阻塞 ${blocked}%`;
    const summary = `${calls} HC/s · 主线程阻塞 ${blocked}%`;
    model.performanceTitle = `${summary}；此值表示页面主线程，不是整机 CPU 占用`;
    callbacks.onPerformance(summary);
    hypercalls = logicFrames = presentedFrames = longTaskMs = 0;
    sampleStarted = now;
    publish();
  }, 500);
  return {
    setRendererDetail(detail) {
      model.rendererDetail = detail;
      publish();
    },
    setReShadeMode(mode) {
      model.reshadeMode = mode;
      publish();
    },
    setUpscaleMode(mode) {
      model.upscaleMode = mode;
      publish();
    },
    setMapsAvailable(available) {
      if (model.mapsAvailable !== available) {
        model.mapsAvailable = available;
        publish();
      }
    },
    setGameTitle(title) {
      model.title = title;
      publish();
    },
    recordCall(count = 1) {
      hypercalls += count;
    },
    recordLogicFrame(count = 1) {
      logicFrames += count;
    },
    recordPresentedFrame() {
      presentedFrames++;
    },
    setCheatGame(game) {
      if (model.cheatGame !== game) {
        model.cheatGame = game;
        publish();
      }
    },
    setResolution(resolution) {
      model.resolution = resolution ? gameResolutionValue(resolution) : '';
      publish();
    },
    pressClockRate,
    destroy() {
      if (disposed) return;
      disposed = true;
      window.clearInterval(timer);
      observer?.disconnect();
      if (toolbarState.getSnapshot()?.callbacks === callbacks) toolbarState.set(null);
    },
  };
}
