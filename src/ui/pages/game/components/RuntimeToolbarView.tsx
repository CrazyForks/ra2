import type { ReShadeMode } from '../../../../graphics/reshadePreset';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CHEAT_GUIDES, type CheatGuideGameId } from '../cheatGuides';
import { normalizeCheatText, CHEAT_TEXT_MAX_LENGTH } from '../input';
import { setControlsCollapsed, toggleImmersiveFullscreen } from '../gameInput';
import { openGroupJoinDialog } from '../joinGroupDialog';
import type { RuntimeToolbarCallbacks } from '../runtimeToolbar';
import { Modal } from './Modal';
import { GameSelect } from './GameSelect';
import type { UpscaleMode } from '../vmFrameRenderer';
import { controlsCollapsed } from '../state/uiState';
import { DEFAULT_VOLUME_PERCENT } from '../../../../adapter/audio';
import { useStore } from '../../../shared/state/useStore';

// 在导入边界裁掉实验，生产构建不携带 ONNX/实验 Worker，而不只是隐藏按钮。
const loadModelProbeDialog = import.meta.env.DEV
  ? () => import('./ModelProbeDialog').then((module) => ({ default: module.ModelProbeDialog }))
  : () => Promise.reject(new Error('模型实验仅在开发模式可用'));
let modelProbeDialogPromise: ReturnType<typeof loadModelProbeDialog> | undefined;

const preloadModelProbeDialog = () => {
  modelProbeDialogPromise ??= loadModelProbeDialog();
  return modelProbeDialogPromise;
};

const ModelProbeDialog = import.meta.env.DEV ? lazy(preloadModelProbeDialog) : null;

class ModelProbeDialogLoadBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (this.state.error) {
      return <p role="alert">模型实验加载失败：{this.state.error.message}</p>;
    }
    return this.props.children;
  }
}

export interface ToolbarModel {
  fps: string;
  performance: string;
  performanceTitle: string;
  rendererDetail: string;
  title: string;
  cheatGame: CheatGuideGameId | null;
  resolution: string;
  rate: number;
  upscaleMode: UpscaleMode;
  reshadeMode?: ReShadeMode;
  mapsAvailable: boolean;
}
const resolutions = ['', '800x600', '1024x768', '1280x720', '1280x800', '1440x900', '1600x900', '1920x1080'];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function CheatContent({ game, callbacks }: { game: CheatGuideGameId | null; callbacks: RuntimeToolbarCallbacks }) {
  const [status, setStatus] = useState('页面只报告已交给 VM，不代表游戏接受。');
  const guide = game === null ? null : CHEAT_GUIDES[game];
  const send = (raw: string) => {
    const result = normalizeCheatText(raw);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    try {
      callbacks.onSendCheatText(result.text);
      setStatus(`已将「${result.text}」交给 VM。`);
    } catch (error) {
      setStatus(errorText(error));
    }
  };
  return (
    <>
      <div id="vm-cheat-content">
        <p className="cheat-guide-steps">{guide?.steps ?? '当前游戏尚未提供经过验证的指南。'}</p>
        <div className="cheat-entry-list">
          {guide?.entries.map((entry, index) => (
            <article key={index} className="cheat-entry">
              <div className="cheat-entry-top">
                <code className="cheat-code mono" translate="no">
                  {entry.kind === 'text' ? entry.text : entry.label}
                </code>
                <span className="cheat-effect">{entry.effect}</span>
              </div>
              <p className="cheat-hint">{entry.hint}</p>
              <div className="cheat-entry-actions">
                {entry.kind === 'text' && (
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => {
                      if (!navigator.clipboard) {
                        setStatus('当前浏览器不允许复制，请手动复制。');
                        return;
                      }
                      void navigator.clipboard.writeText(entry.text).then(
                        () => setStatus('已复制'),
                        (error) => setStatus(errorText(error)),
                      );
                    }}
                  >
                    复制
                  </button>
                )}
                <button
                  type="button"
                  className="toolbar-button"
                  onClick={() => {
                    if (entry.kind === 'text') send(entry.text);
                    else
                      try {
                        callbacks.onSendCheatKey(entry.keyCode);
                        setStatus(`已将「${entry.label}」交给 VM。`);
                      } catch (error) {
                        setStatus(errorText(error));
                      }
                  }}
                >
                  {entry.kind === 'text' ? '发送到游戏' : '发送按键'}
                </button>
              </div>
            </article>
          ))}
        </div>
        <section className="cheat-custom">
          <h3>自定义秘籍</h3>
          <form
            className="cheat-custom-form"
            onSubmit={(event) => {
              event.preventDefault();
              send(String(new FormData(event.currentTarget).get('cheat') ?? ''));
            }}
          >
            <label htmlFor="vm-cheat-custom-input">手机软键盘输入秘籍</label>
            <input
              id="vm-cheat-custom-input"
              name="cheat"
              type="text"
              maxLength={CHEAT_TEXT_MAX_LENGTH}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="submit" className="toolbar-button">
              发送到游戏
            </button>
          </form>
        </section>
        <ul className="cheat-guide-notes">
          {guide?.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
      <p id="vm-cheat-status" className="cheat-status" role="status">
        {status}
      </p>
    </>
  );
}
export function RuntimeToolbarView({
  model,
  callbacks,
  canvas,
  pressRate,
  setResolution,
}: {
  model: ToolbarModel;
  callbacks: RuntimeToolbarCallbacks;
  canvas: HTMLCanvasElement;
  pressRate(rate: number): void;
  setResolution(value: string): void;
}) {
  const collapsed = useStore(controlsCollapsed);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [changingResolution, setChangingResolution] = useState(false);
  const [cheats, setCheats] = useState(false);
  const [probe, setProbe] = useState(false);
  const [quickStart, setQuickStart] = useState(false);
  const [volume, setVolume] = useState(() => {
    try {
      const raw = localStorage.getItem('vm-master-volume');
      const value = raw === null ? DEFAULT_VOLUME_PERCENT : Number(raw);
      return Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_VOLUME_PERCENT;
    } catch {
      return DEFAULT_VOLUME_PERCENT;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    callbacks.onVolume((volume / 100) ** 2);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
    };
  }, [callbacks]);
  useEffect(() => {
    if (ModelProbeDialog) {
      void preloadModelProbeDialog().catch(() => undefined);
    }
  }, []);
  const chooseResolution = async (value: string) => {
    if (value === model.resolution) return;
    setChangingResolution(true);
    setResolution(value);
    try {
      await callbacks.onResolution(value);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setChangingResolution(false);
    }
  };
  const run = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button
        id="vm-controls-toggle"
        className="toolbar-button"
        type="button"
        aria-label="收起或展开控制栏"
        aria-expanded={!collapsed}
        onClick={() => setControlsCollapsed(!collapsed)}
      >
        {collapsed ? '☰' : '✕'}
      </button>
      <span className="brand">{model.title}</span>
      <output id="vm-fps" title={model.rendererDetail}>
        {model.fps}
      </output>
      <output id="vm-performance" title={message || model.performanceTitle}>
        {message || model.performance}
      </output>
      <div className="resolution-controls">
        <span className="label">超分</span>
        <GameSelect
          id="vm-upscale"
          nativeId="vm-upscale-mode"
          label="实时超分模式"
          value={model.upscaleMode}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'bicubic', label: 'Bicubic（非 AI）' },
            { value: 'fsr', label: 'FSR 1.0（柔和）' },
            { value: 'fsr-rcas-soft', label: 'FSR 1.0+RCAS（轻锐化）' },
            { value: 'fsr-rcas', label: 'FSR 1.0+RCAS（锐化）' },
            { value: 'scalefx', label: 'ScaleFX 3×（像素画）' },
            { value: 'fast', label: 'CNN（快速）' },
            { value: 'gan', label: 'GAN-M（画质）' },
          ]}
          onChange={(value) => callbacks.onUpscaleMode?.(value as UpscaleMode)}
        />
      </div>
      <div className="resolution-controls reshade-controls">
        <span className="label" title="SweetFX 的 Vibrance 与 LumaSharpen 浏览器移植">
          ReShade
        </span>
        <GameSelect
          id="vm-reshade"
          nativeId="vm-reshade-mode"
          label="ReShade 后处理"
          value={model.reshadeMode ?? 'off'}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'enhance', label: '色彩 + 锐化' },
            { value: 'compare', label: '左右对照' },
          ]}
          onChange={(value) => {
            try {
              callbacks.onReShadeMode?.(value as ReShadeMode);
              setMessage('');
            } catch (error) {
              setMessage(errorText(error));
            }
          }}
        />
        <output id="vm-reshade-status" role="status">
          {model.reshadeMode === 'compare'
            ? '左：原图 · 右：增强'
            : model.reshadeMode === 'enhance'
              ? '已开启 · 色彩 + 锐化'
              : '已关闭'}
        </output>
      </div>
      <div className="rate-controls vm-clock-controls" role="group" aria-label="时钟倍率">
        <span>时钟</span>
        {[1, 2, 4].map((rate) => (
          <button
            key={rate}
            className="rate-button"
            type="button"
            data-clock-rate={rate}
            aria-pressed={model.rate === rate}
            onClick={() => pressRate(rate)}
          >
            {rate}×
          </button>
        ))}
      </div>
      <div className="resolution-controls">
        <span className="label">分辨率</span>
        <GameSelect
          id="vm-resolution"
          label="游戏分辨率"
          value={model.resolution}
          disabled={changingResolution}
          options={resolutions.map((value) => ({ value, label: value.replace('x', '×') || '跟随 INI' }))}
          onChange={(value) => void chooseResolution(value)}
        />
      </div>
      <div className="volume-controls slider-item">
        <span className="label">主音量</span>
        <div className="slider-fields">
          <input
            id="vm-volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={volume}
            aria-label="主音量"
            onChange={(event) => {
              const value = Number(event.target.value);
              setVolume(value);
              callbacks.onVolume((value / 100) ** 2);
              try {
                localStorage.setItem('vm-master-volume', String(value));
              } catch {
                /* 隐私模式只保留会话值。 */
              }
            }}
          />
          <input id="vm-volume-value" type="text" disabled readOnly value={`${volume}%`} aria-label="主音量读数" />
        </div>
      </div>
      <button
        id="vm-quick-start"
        className="toolbar-button"
        type="button"
        disabled={!!busy || !model.mapsAvailable || !callbacks.onQuickStart}
        onClick={() => setQuickStart(true)}
      >
        快速开局…
      </button>
      {ModelProbeDialog && (
        <button
          id="vm-model-probe"
          className="toolbar-button"
          type="button"
          disabled={!callbacks.onCaptureProbe}
          onClick={() => setProbe(true)}
        >
          模型实验…
        </button>
      )}
      {import.meta.env.DEV && callbacks.onLiveModel && (
        <button
          id="vm-live-model-stop"
          className="toolbar-button"
          type="button"
          onClick={() => void run('stop-model', () => callbacks.onLiveModel!(null))}
        >
          停止整帧模型
        </button>
      )}
      <button
        id="vm-cheat-guides"
        className="toolbar-button"
        type="button"
        disabled={model.cheatGame === null}
        onClick={() => setCheats(true)}
      >
        作弊码指南
      </button>
      <button
        id="vm-save-download"
        className="toolbar-button"
        type="button"
        disabled={!!busy}
        onClick={() => void run('download', callbacks.onDownloadSave)}
      >
        {busy === 'download' ? '正在打包…' : '下载存档'}
      </button>
      <button
        id="vm-save-upload"
        className="toolbar-button"
        type="button"
        disabled={!!busy}
        onClick={() => file.current?.click()}
      >
        {busy === 'upload' ? '正在校验…' : '上传存档'}
      </button>
      <input
        ref={file}
        id="vm-save-file"
        type="file"
        accept=".json,.ra2-save,application/json"
        hidden
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (selected) void run('upload', () => callbacks.onUploadSave(selected));
        }}
      />
      <button
        id="vm-custom-maps"
        className="toolbar-button"
        type="button"
        disabled={!!busy || !model.mapsAvailable}
        title={model.mapsAvailable ? '建议在开始对局前附加地图包' : '游戏启动后可附加地图包'}
        onClick={() =>
          void run('maps', async () => {
            await callbacks.onCustomMaps?.();
          })
        }
      >
        附加地图包…
      </button>
      <button
        id="vm-change-source"
        className="toolbar-button"
        type="button"
        disabled={!!busy}
        onClick={() => void run('source', callbacks.onChangeSource)}
      >
        {busy === 'source' ? '正在安全停止…' : '更换游戏目录…'}
      </button>
      <button id="vm-join-group" className="toolbar-button" type="button" onClick={openGroupJoinDialog}>
        加入微信群
      </button>
      <button
        id="vm-fullscreen"
        className="toolbar-button"
        type="button"
        onClick={() => void toggleImmersiveFullscreen(canvas).catch((error) => setMessage(errorText(error)))}
      >
        {fullscreen ? '退出全屏' : '全屏'}
      </button>
      {createPortal(
        <Modal
          id="vm-cheat-dialog"
          open={cheats && model.cheatGame !== null}
          title="作弊码指南"
          onClose={() => setCheats(false)}
          className="cheat-dialog"
        >
          <header>
            <h2 id="vm-cheat-dialog-title">作弊码指南</h2>
            <button
              id="vm-cheat-dialog-close"
              className="toolbar-button"
              type="button"
              onClick={() => setCheats(false)}
            >
              关闭
            </button>
          </header>
          <CheatContent game={model.cheatGame} callbacks={callbacks} />
        </Modal>,
        document.body,
      )}
      {ModelProbeDialog &&
        probe &&
        callbacks.onCaptureProbe &&
        createPortal(
          <ModelProbeDialogLoadBoundary>
            <Suspense fallback={<p role="status">正在打开模型实验…</p>}>
              <ModelProbeDialog
                capture={callbacks.onCaptureProbe}
                live={callbacks.onLiveModel}
                close={() => setProbe(false)}
              />
            </Suspense>
          </ModelProbeDialogLoadBoundary>,
          document.body,
        )}
      {quickStart &&
        createPortal(
          <Modal
            open
            title="快速开局"
            onClose={() => setQuickStart(false)}
            busy={busy === 'quick'}
            className="quick-start-dialog"
          >
            <h3>重新启动并进入遭遇战设置？</h3>
            <p>当前游戏会关闭，未保存的对局进度会丢失，联机会断开。资源未缓存时需重新选择游戏文件。</p>
            <p>这会直达设置页，国家、地图和开始战斗仍由你选择。</p>
            <button type="button" className="dialog-button" disabled={!!busy} onClick={() => setQuickStart(false)}>
              取消
            </button>
            <button
              type="button"
              className="dialog-button"
              disabled={!!busy}
              onClick={() =>
                void run('quick', async () => {
                  await callbacks.onQuickStart?.();
                  setQuickStart(false);
                })
              }
            >
              {busy === 'quick' ? '正在安全重启…' : '重启并进入遭遇战'}
            </button>
            {message && <p role="alert">{message}</p>}
          </Modal>,
          document.body,
        )}
    </>
  );
}
