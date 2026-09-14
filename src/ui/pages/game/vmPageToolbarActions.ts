import { createReShadePreset } from '../../../graphics/reshadePreset';
/**
 * 工具栏动作回调对象（拆分自 page.ts 的 startVmPage）：
 * 快速开局、分辨率/音量/倍率、弱网、存档导入导出与地图包。
 * 会随会话重赋值的局部状态经 getter/setter 传入，避免捕获过期值。
 */
import type { GameSource } from '../../../games/source';
import type { SupportedGameId } from '../../../games/catalog';
import type { VmShell } from '../../../adapter/vmShell';
import type { VmStatus } from '../../../app/session/runtimeEvents';
import type { GameResolution } from '../../../games/resolution';
import type { LiveModelId } from './experiments/modelProbe';
import { captureProbeImage } from './experiments/modelProbe';
import type { FrameEffectController } from '../../../app/session/frameEffectController';
import type { FramePresenter } from '../../../graphics/framePresenter';
import type { VmFrameRenderer } from './vmFrameRenderer';
import type { RuntimeToolbar, RuntimeToolbarCallbacks } from './runtimeToolbar';
import { parseGameResolution } from '../../../games/resolution';
import { storeResolution } from './vmPageResolution';
import { upscaleStatus } from './state/uiState';
import { sendCheatKey, sendCheatSequence } from './input';
import { editCustomMapPackages } from './customMapDialog';
import {
  createSavePackage,
  hasPlayerSlotSaves,
  importSavePackage,
  listSavePaths,
  readSavePackage,
  summarizeSavePaths,
} from '../../../adapter/saveTransfer';

export interface VmPageToolbarActionDeps {
  canvas: HTMLCanvasElement;
  debugAutoOpen: boolean;
  presenter: FramePresenter;
  effects: FrameEffectController<LiveModelId>;
  frameRenderer: VmFrameRenderer;
  getToolbar: () => RuntimeToolbar;
  getVm: () => VmShell | null;
  getStatus: () => VmStatus;
  getExitHandled: () => boolean;
  getSelectedGameId: () => SupportedGameId | null;
  getGameSource: () => GameSource | null;
  setRequestedClockRate: (rate: number) => void;
  setRequestedResolution: (resolution: GameResolution | null) => void;
  setRequestedVolume: (linear: number) => void;
  setPerformanceLine: (summary: string) => void;
  onRestartForResolution: () => Promise<void>;
  onChangeGameSource: () => Promise<void>;
  onSchedulePerformanceRender: () => void;
}

export function createVmPageToolbarActions(deps: VmPageToolbarActionDeps): RuntimeToolbarCallbacks {
  const {
    canvas,
    debugAutoOpen,
    presenter,
    effects,
    frameRenderer,
    getToolbar,
    getVm,
    getStatus,
    getExitHandled,
    getSelectedGameId,
    getGameSource,
    setRequestedClockRate,
    setRequestedResolution,
    setRequestedVolume,
    setPerformanceLine,
    onRestartForResolution,
    onChangeGameSource,
    onSchedulePerformanceRender,
  } = deps;
  return {
    onLiveModel: import.meta.env.DEV ? (file, modelId) => effects.set(file, modelId) : undefined,
    async onQuickStart() {
      const vm = getVm();
      if (!vm || getExitHandled() || getStatus().phase !== 'running') throw new Error('游戏尚未运行');
      // 启动 hook 不是任意时刻可跳转的菜单函数；先正常释放 VM，再由下一次启动消费。
      const url = new URL(window.location.href);
      url.searchParams.set('start-page', 'skirmish');
      window.history.replaceState(window.history.state, '', url);
      await onRestartForResolution();
    },
    onCaptureProbe: import.meta.env.DEV
      ? (size) => {
          if (!presenter.frame) throw new Error('尚无游戏画面，请启动游戏后再采样');
          return captureProbeImage(presenter.frame, size);
        }
      : undefined,
    onClockRate(rate) {
      setRequestedClockRate(rate);
      getVm()?.setGameClockRate(rate);
    },
    onReShadeMode(mode) {
      if (getExitHandled()) return;
      frameRenderer.setPostProcess(mode === 'off' ? null : (gl) => createReShadePreset(gl, mode === 'compare'));
      getToolbar().setReShadeMode(mode);
      presenter.invalidate();
    },
    onUpscaleMode(mode) {
      effects.stop(true);
      frameRenderer.setUpscaleMode(mode);
      const toolbar = getToolbar();
      toolbar.setUpscaleMode(mode);
      toolbar.setRendererDetail(frameRenderer.detail);
      upscaleStatus.set(frameRenderer.upscaleStatus);
      presenter.invalidate();
    },
    async onResolution(value) {
      const gameId = getSelectedGameId();
      if (!gameId) return;
      const resolution = parseGameResolution(value);
      if (value && !resolution) throw new Error(`不支持的分辨率：${value}`);
      storeResolution(gameId, resolution);
      setRequestedResolution(resolution);
      await onRestartForResolution();
    },
    onVolume(linear) {
      setRequestedVolume(linear);
      getVm()?.setMasterVolume(linear);
    },
    onPerformance(summary) {
      setPerformanceLine(summary);
      if (debugAutoOpen) canvas.dataset.vmPerformance = summary;
      onSchedulePerformanceRender();
    },
    onSendCheatText(text) {
      const vm = getVm();
      if (!vm || getStatus().phase !== 'running') {
        throw new Error('游戏尚未就绪，请等待游戏进入可操作画面。');
      }
      const result = sendCheatSequence(vm, text);
      if (!result.ok) throw new Error(result.error);
    },
    onSendCheatKey(code) {
      const vm = getVm();
      if (!vm || getStatus().phase !== 'running') {
        throw new Error('游戏尚未就绪，请等待游戏进入可操作画面。');
      }
      sendCheatKey(vm, code);
    },
    onChangeSource() {
      return onChangeGameSource();
    },
    async onCustomMaps() {
      const gameId = getSelectedGameId();
      if (!gameId || getExitHandled() || !getVm() || getStatus().phase !== 'running') return;
      document.exitPointerLock?.();
      await editCustomMapPackages(gameId, async (files) => {
        const vm = getVm();
        if (!vm || getExitHandled()) throw new Error('VM 已退出');
        const result = await vm.attachMapFiles(files);
        return (
          `已动态挂载 ${result.attached.length} 个地图文件` +
          `${result.attached.length ? `：${result.attached.join('、')}` : ''}。` +
          `已有 ${result.existing.length} 个同名文件保持不变；CSF 未挂载。VM 未重启，请自行检查地图列表。`
        );
      });
    },
    async onDownloadSave() {
      const gameSource = getGameSource();
      if (!gameSource) throw new Error('游戏目录尚未就绪');
      await getVm()?.flushFiles();
      // 局内存档缺失时导出的包无法用于继续游戏：
      // 接收端读档会因地图文件缺失触发原版除零崩溃。提前警示而不是导出残包。
      const paths = await listSavePaths(gameSource.files);
      if (!paths.some((path) => path.startsWith('save/'))) {
        window.alert(
          '游戏目录中没有局内存档（Save 目录缺失或为空）：\n' +
            '导出的内容只有进度表文件，无法在其他浏览器继续游戏。\n' +
            '请先在本机游戏内保存一次存档，再导出。',
        );
      }
      const blob = await createSavePackage(gameSource.files, gameSource.game.id);
      // 下载前明示包内容：用户可直接核对实际游玩的槽位是否在列，
      // 避免「导出包缺槽位 → 接收端读档除零崩溃」直到换浏览器才暴露。
      const summary = summarizeSavePaths(paths);
      if (
        !window.confirm(
          `导出包内容（共 ${paths.length} 个文件）：\n\n${summary}\n\n` +
            '请确认包含你实际游玩的槽位。若没有，说明当前浏览器/网址里不存在那些存档' +
            '（存档在各浏览器自己的 IndexedDB 里），应换到实际玩的那个浏览器重新导出。\n\n是否下载？',
        )
      )
        return;
      const date = new Date().toISOString().replace(/[:.]/g, '-');
      const url = URL.createObjectURL(blob);
      // 浏览器下载 API 的兼容适配：不插入页面，不用于构造或更新普通 UI。
      const link = document.createElement('a');
      link.href = url;
      link.download = `${gameSource.game.id}-save-${date}.ra2-save.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    async onUploadSave(file) {
      const gameSource = getGameSource();
      if (!gameSource) throw new Error('游戏目录尚未就绪');
      const archive = await readSavePackage(file, gameSource.game.id);
      const entryPaths = archive.files.map((entry) => entry.path);
      const summary = summarizeSavePaths(entryPaths);
      const warning = hasPlayerSlotSaves(entryPaths)
        ? ''
        : '⚠ 此包没有任何槽位 1–9 的存档（只有默认槽位 0 / 进度表）。\n' +
          '如果你玩过并存过档，这很可能是选错了导出文件（Downloads 里的旧包），' +
          '或是从没有存档的浏览器导出的——建议取消，回到实际玩的浏览器重新导出。\n\n';
      if (
        !window.confirm(
          `${warning}将覆盖 ${archive.files.length} 个存档文件并重新启动游戏：\n\n${summary}\n\n完整清单：\n${entryPaths.join('\n')}\n\n是否继续？`,
        )
      )
        return false;
      await getVm()?.stop();
      await getVm()?.flushFiles();
      await importSavePackage(gameSource.files, archive);
      window.location.reload();
      return true;
    },
  };
}
