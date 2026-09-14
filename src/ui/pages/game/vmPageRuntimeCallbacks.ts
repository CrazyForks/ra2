/**
 * 运行时 VM 回调对象（拆分自 page.ts 的 startVmPage）：
 * 状态、调用与帧回调组合成 GameVmCallbacks，由 guardVmCallbacks 代次过滤。
 * 会随会话重赋值的局部状态一律经 getter/setter 传入，避免捕获过期值。
 */
import type { VmShell } from '../../../adapter/vmShell';
import type { GameVmCallbacks } from '../../../app/session/runtimeEvents';
import type { VmStatus } from '../../../app/session/runtimeEvents';
import type { Win32Call } from '../../../vm86/win32';
import type { SupportedGameId } from '../../../games/catalog';
import type { LiveModelId } from './experiments/modelProbe';
import type { FrameEffectController } from '../../../app/session/frameEffectController';
import type { FramePresenter } from '../../../graphics/framePresenter';
import { measureRa2BattlefieldFrame, sampleVmFrameHash } from './debug/frameProbes';
import { formatNetworkStatus } from './networkStatus';
import { activeCheatGameForPhase } from './cheatGuides';
import { gameRunning, networkStatus } from './state/uiState';
import type { RuntimeToolbar } from './runtimeToolbar';

export interface VmPageRuntimeCallbackDeps {
  canvas: HTMLCanvasElement;
  debugAutoOpen: boolean;
  toolbar: RuntimeToolbar;
  presenter: FramePresenter;
  effects: FrameEffectController<LiveModelId>;
  getVm: () => VmShell | null;
  getSelectedGameId: () => SupportedGameId | null;
  setStatus: (next: VmStatus) => void;
  getCallCount: () => number;
  setCallCount: (next: number) => void;
  getPanelCreated: () => boolean;
  callHistogram: Map<string, number>;
  calls: string[];
  getGameFrameSize: () => { width: number; height: number };
  setGameFrameSize: (width: number, height: number) => void;
  getAdaptInputResolution: () => ((width: number, height: number) => void) | null;
  getRefitActiveCanvas: () => (frameWidth?: number, frameHeight?: number) => void;
  onUpdateBootOverlay: (next: VmStatus) => void;
  onScheduleRender: () => void;
  onHideBootOverlay: () => void;
  onFinishExited: (detail: string) => void;
  onExposeRuntimeCallProbe: () => void;
  onAppendCall: (lines: string[], call: Win32Call, ordinal: number, suffix?: string) => void;
}

export function createVmRuntimeCallbacks(deps: VmPageRuntimeCallbackDeps): GameVmCallbacks {
  const {
    canvas,
    debugAutoOpen,
    toolbar,
    presenter,
    effects,
    getVm,
    getSelectedGameId,
    setStatus,
    getCallCount,
    setCallCount,
    getPanelCreated,
    callHistogram,
    calls,
    getGameFrameSize,
    setGameFrameSize,
    getAdaptInputResolution,
    getRefitActiveCanvas,
    onUpdateBootOverlay,
    onScheduleRender,
    onHideBootOverlay,
    onFinishExited,
    onExposeRuntimeCallProbe,
    onAppendCall,
  } = deps;
  return {
    onNetworkStatus(next) {
      networkStatus.set({
        phase: next.phase,
        text: formatNetworkStatus(next),
        title: `虚拟 LAN：${next.room}。中继连接状态不代表游戏逻辑同步。`,
      });
    },
    onStatus(next) {
      if (next.phase !== 'running') {
        effects.stop();
      }
      setStatus(next);
      if (debugAutoOpen) canvas.dataset.vmStatus = JSON.stringify(next);
      toolbar.setCheatGame(activeCheatGameForPhase(getSelectedGameId(), next.phase));
      toolbar.setMapsAvailable(next.phase === 'running' && getVm() !== null);
      onUpdateBootOverlay(next);
      onScheduleRender();
      // 游戏运行态切换客户端外壳：running 时画面独占整窗，菜单态恢复内容页与导航条。
      gameRunning.set(next.phase === 'running');
      if (next.phase === 'exited') queueMicrotask(() => void onFinishExited(next.detail));
    },
    onShellPage(title) {
      if (title) canvas.dataset.shellPage = title;
      else delete canvas.dataset.shellPage;
    },
    onCall(call, ordinal) {
      setCallCount(ordinal);
      toolbar.recordCall();
      if (!getPanelCreated()) return;
      callHistogram.set(call.imported.key, (callHistogram.get(call.imported.key) ?? 0) + 1);
      onExposeRuntimeCallProbe();
      // 初始化会有 10 万级调用；日志稀疏采样，DOM 更新交给 rAF 合并。
      if (ordinal <= 200 || ordinal % 256 === 0) {
        onAppendCall(calls, call, ordinal);
        onScheduleRender();
      }
    },
    onCallBatch(batch) {
      setCallCount(batch.ordinal);
      toolbar.recordCall(batch.delta);
      toolbar.recordLogicFrame(batch.logicFrames);
      if (debugAutoOpen) {
        canvas.dataset.vmBatch = JSON.stringify({
          calls: batch.delta,
          logicFrames: batch.logicFrames,
          hot: [...batch.histogram].sort((left, right) => right[1] - left[1]).slice(0, 8),
        });
      }
      if (!getPanelCreated()) return;
      for (const [key, count] of batch.histogram) {
        callHistogram.set(key, (callHistogram.get(key) ?? 0) + count);
      }
      onExposeRuntimeCallProbe();
      if (batch.samples.length) {
        for (const sample of batch.samples) onAppendCall(calls, sample.call, sample.ordinal);
        onScheduleRender();
      }
    },
    onBlocked(call) {
      if (getPanelCreated()) onAppendCall(calls, call, getCallCount(), '← 下一个迁移边界');
      onScheduleRender();
    },
    onLogicFrame(count) {
      toolbar.recordLogicFrame(count);
    },
    onFrame(frame) {
      const size = getGameFrameSize();
      if (frame.width !== size.width || frame.height !== size.height) {
        setGameFrameSize(frame.width, frame.height);
        getAdaptInputResolution()?.(frame.width, frame.height);
        getRefitActiveCanvas()(frame.width, frame.height);
      }
      presenter.submit(frame);
      if (debugAutoOpen) {
        canvas.dataset.vmFrame = `${presenter.frameVersion}`;
        canvas.dataset.vmResolution = `${frame.width}x${frame.height}`;
        // 哈希只用于低频 E2E 采样；不必跟 60fps 呈现逐帧计算。每四帧一次既能
        // 捕捉 logo/视频变化，又不让探针本身抢占过场音频和页面响应。
        if ((presenter.frameVersion & 3) === 0) canvas.dataset.vmFrameSample = sampleVmFrameHash(frame);
        const battlefield = measureRa2BattlefieldFrame(frame);
        canvas.dataset.vmBattlefield = `${battlefield.rightEdgeRatio.toFixed(4)},${battlefield.fieldRatio.toFixed(4)}`;
      }
      onHideBootOverlay();
      onScheduleRender();
    },
  };
}
