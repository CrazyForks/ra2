import { useEffect, useRef, useState } from 'react';
import type { SupportedGameId } from '../../../../games/catalog';
import { loadCustomMapFiles, saveCustomMapFiles } from '../../../../adapter/cachedGameFiles';
import { readCustomMapPackage } from '../../../../adapter/customMapPackage';
import { Modal } from './Modal';

export function CustomMapDialog({
  gameId,
  applyLive,
  finish,
}: {
  gameId: SupportedGameId;
  applyLive?: (files: ReadonlyMap<string, Uint8Array>) => Promise<string>;
  finish(changed: boolean): void;
}) {
  const [files, setFiles] = useState(new Map<string, Uint8Array>());
  const [busy, setBusy] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [status, setStatus] = useState('正在读取已保存的地图…');
  const [applied, setApplied] = useState(false);
  const alive = useRef(true);
  const fail = (error: unknown) => {
    if (alive.current) setStatus(error instanceof Error ? error.message : String(error));
  };
  useEffect(() => {
    alive.current = true;
    void loadCustomMapFiles(gameId)
      .then(
        (value) => {
          if (alive.current) {
            setFiles(value);
            setStatus('');
          }
        },
        (error) => {
          if (alive.current) {
            setReadFailed(true);
            fail(error);
          }
        },
      )
      .finally(() => {
        if (alive.current) setBusy(false);
      });
    return () => {
      alive.current = false;
    };
  }, [gameId]);
  const importFiles = async (archives: File[]) => {
    if (!archives.length || busy) return;
    setBusy(true);
    try {
      const staged = new Map(files);
      const replaced = new Set<string>();
      for (const archive of archives) {
        setStatus(`正在读取 ${archive.name}…`);
        const extracted = await readCustomMapPackage(new Uint8Array(await archive.arrayBuffer()), (message) => {
          if (alive.current) setStatus(message);
        });
        if (!alive.current) return;
        for (const [name, bytes] of extracted) {
          if (staged.has(name)) replaced.add(name);
          staged.set(name, bytes);
        }
      }
      if (replaced.size && !window.confirm(`将覆盖已添加的同名文件：\n${[...replaced].join('\n')}\n是否继续？`)) return;
      setFiles(staged);
      setStatus(`已暂存 ${staged.size} 个文件，点击应用后生效。`);
    } catch (error) {
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (busy || readFailed) return;
    setBusy(true);
    try {
      await saveCustomMapFiles(gameId, files);
      if (!alive.current) return;
      if (!applyLive) {
        finish(true);
        return;
      }
      try {
        setStatus(await applyLive(files));
        setApplied(true);
      } catch (error) {
        throw new Error(`文件已保存，但动态挂载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal open title="自定义地图包" className="custom-map-dialog" busy={busy} onClose={() => finish(false)}>
      <h3>自定义地图包 · {gameId.toUpperCase()}</h3>
      <p>
        探索压缩包及嵌套归档，挂载 .yrm 和 .mpr；.csf
        仅保存，暂不挂载。保留地图扩展名，不转换地图版本。应用后每次启动自动加载。
        {applyLive && '本次仅动态新增文件，不重启 VM、不刷新地图列表；同名替换和移除下次启动生效。'}
      </p>
      <input
        type="file"
        accept=".zip,.7z,.rar"
        multiple
        aria-label="添加自定义地图压缩包"
        disabled={busy || readFailed}
        onChange={(event) => {
          const archives = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          void importFiles(archives);
        }}
      />
      <ul>
        {[...files].map(([name, bytes]) => (
          <li key={name}>
            {name}（{bytes.length} B）{name.endsWith('.csf') ? '〔暂不挂载〕' : ''}{' '}
            <button
              type="button"
              disabled={busy}
              aria-label={`移除 ${name}`}
              onClick={() =>
                setFiles((previous) => {
                  const next = new Map(previous);
                  next.delete(name);
                  return next;
                })
              }
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      <p role="status">{status}</p>
      <button type="button" disabled={busy || readFailed} onClick={() => void apply()}>
        {applyLive ? '应用到运行中的 VM' : '应用'}
      </button>
      <button type="button" disabled={busy} onClick={() => finish(false)}>
        {applied ? '关闭' : '取消'}
      </button>
    </Modal>
  );
}
