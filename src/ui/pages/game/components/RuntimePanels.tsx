import { useState, type CSSProperties } from 'react';
import { forgetGameDirectory } from '../../../../platform/browser/files/directoryAccess';
import { clearCachedGameFiles } from '../../../../adapter/cachedGameFiles';
import type { BootState, StatusState } from '../state/uiState';

const panelStyle: CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  width: 'min(560px,calc(100vw - 40px))',
  zIndex: 35,
};
const reasonText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
export function ProblemPanel({ phase, detail }: { phase: 'blocked' | 'error'; detail: string }) {
  const [copied, setCopied] = useState('复制错误详情');
  return (
    <section className="panel game-folder-panel bad-page" style={panelStyle}>
      <h3 style={{ color: '#f00', fontSize: 24 }}>{phase === 'blocked' ? '接口待实现（游戏停在此处）' : '运行错误'}</h3>
      <pre
        style={{
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          userSelect: 'text',
        }}
      >
        {detail}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="folder-button"
          onClick={() => {
            if (!navigator.clipboard) {
              setCopied('复制失败');
              return;
            }
            void navigator.clipboard.writeText(`${phase.toUpperCase()}\n${detail}`).then(
              () => setCopied('已复制'),
              () => setCopied('复制失败'),
            );
          }}
        >
          {copied}
        </button>
        <button type="button" className="folder-button" onClick={() => window.location.reload()}>
          重新启动游戏
        </button>
      </div>
    </section>
  );
}
export function ExitPanel({ detail }: { detail: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="panel game-folder-panel" style={panelStyle}>
      <h3>已回到网页</h3>
      <p>{error || `原版游戏已正常退出，音频和鼠标锁定已释放。${detail}`}</p>
      <button className="folder-button" type="button" onClick={() => window.location.reload()}>
        重新启动游戏
      </button>{' '}
      <button
        className="folder-button"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.all([forgetGameDirectory(), clearCachedGameFiles().catch(() => {})]).then(
            () => window.location.reload(),
            (error) => {
              setBusy(false);
              setError(`无法忘记文件夹：${reasonText(error)}`);
            },
          );
        }}
      >
        选择其他游戏文件夹
      </button>
    </section>
  );
}

export function BootView({ game, status, cancel }: BootState) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div id="vm-boot">
      <div className="vm-boot-icon" aria-hidden="true">
        {game.id.toUpperCase()}
      </div>
      <div className="vm-boot-title">{game.title}</div>
      <div className="vm-boot-loading" aria-hidden="true" />
      <div className="vm-boot-phase">
        {status.phase === 'running' ? '加载资源' : status.phase === 'ready' ? '内存就绪' : '启动中'}
      </div>
      <div className="vm-boot-detail">{error || status.detail}</div>
      <button
        type="button"
        className="toolbar-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void cancel().catch((reason) => {
            setBusy(false);
            setError(reasonText(reason));
          });
        }}
      >
        {busy ? '正在停止…' : '取消启动'}
      </button>
    </div>
  );
}
export function StatusView({ value, id, bottom }: { value: StatusState; id: string; bottom: number }) {
  return (
    <div
      id={id}
      role="status"
      data-phase={value.phase}
      title={value.title}
      style={{
        position: 'fixed',
        bottom,
        left: 8,
        zIndex: 50,
        maxWidth: '80vw',
        padding: '5px 8px',
        background: '#111e',
        color: ['error', 'disconnected'].includes(value.phase) ? '#ff8080' : '#ddd',
        fontSize: 12,
        pointerEvents: 'none',
      }}
    >
      {value.text}
    </div>
  );
}
export function ShortcutHelp({ close }: { close(): void }) {
  const rows = [
    ['点击游戏画面', '锁定鼠标；全屏可授权将 Esc 交给游戏'],
    ['Esc', '获键盘锁授权后交给游戏；长按退出锁定'],
    ['Shift + 左键', '连点 ×10（50ms 间隔）'],
    ['F11', '沉浸式全屏'],
    ['[ / ]', '时钟倍率 慢 / 快'],
    ['`', '开发调试面板'],
    ['?', '本帮助'],
  ];
  return (
    <section className="panel" style={panelStyle}>
      <h3>快捷键</h3>
      <ul>
        {rows.map(([key, description]) => (
          <li key={key}>
            <code>{key}</code> — {description}
          </li>
        ))}
      </ul>
      <button className="folder-button" type="button" onClick={close}>
        关闭
      </button>
    </section>
  );
}
