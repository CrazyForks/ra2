import { useLayoutEffect, useRef, useState } from 'react';
import type { VmShell } from '../../../../adapter/runtime';

export function DebugPanel({
  title,
  phase,
  calls,
  performance,
  detail,
  hot,
  trace,
  getVm,
}: {
  title: string;
  phase: string;
  calls: number;
  performance: string;
  detail: string;
  hot: Array<[string, number]>;
  trace: string;
  getVm(): VmShell | null;
}) {
  const [tab, setTab] = useState('state'),
    [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false);
  const [recordStatus, setRecordStatus] = useState('未录制'),
    [result, setResult] = useState('');
  const started = useRef(0),
    log = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [trace]);
  const record = async (stop: boolean) => {
    const vm = getVm();
    if (!vm) {
      setRecordStatus('VM 未启动');
      return;
    }
    setBusy(true);
    try {
      if (!stop) {
        const ok = await vm.startMemRecord();
        setRecording(ok);
        started.current = Date.now();
        setRecordStatus(ok ? '录制中…' : '启动失败');
        setResult('');
      } else {
        const value = await vm.stopMemRecord();
        setRecording(false);
        if (!value) {
          setRecordStatus('未在录制');
          return;
        }
        setRecordStatus(
          `已录制 ${((Date.now() - started.current) / 1000).toFixed(1)}s · 采样 ${value.samples} 次 · 改动 ${value.rangeCount} 段 / ${value.totalBytes.toLocaleString()} 字节${value.truncated ? ' · 计数已截断' : ''}`,
        );
        setResult(
          value.counts
            .slice(0, 200)
            .map(({ address, count }) => `0x${address.toString(16).padStart(8, '0')} ×${count}`)
            .join('\n') || '无改动',
        );
      }
    } catch (error) {
      setRecordStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel mono">
      <h3>{title} · 调试（` 收起）</h3>
      <div className="vm-debug-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'state'} onClick={() => setTab('state')}>
          游戏状态
        </button>
        <button type="button" role="tab" aria-selected={tab === 'trace'} onClick={() => setTab('trace')}>
          Call Trace
        </button>
      </div>
      <div className="vm-debug-summary vm-debug-pane" role="tabpanel" hidden={tab !== 'state'}>
        <section className="vm-debug-section">
          <h4>运行状态</h4>
          <table>
            <tbody>
              {[
                ['阶段', phase],
                ['Hypercall', `${calls.toLocaleString()} 次`],
                ['性能', performance],
                ['详情', detail],
              ].map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="vm-debug-section">
          <h4>内存改动录制</h4>
          <button type="button" disabled={busy || recording} onClick={() => void record(false)}>
            开始录制
          </button>
          <button type="button" disabled={busy || !recording} onClick={() => void record(true)}>
            结束录制
          </button>
          <span>{recordStatus}</span>
          <pre>{result}</pre>
        </section>
      </div>
      <div className="vm-debug-trace vm-debug-pane" role="tabpanel" hidden={tab !== 'trace'}>
        <section className="vm-debug-section">
          <h4>调用热点</h4>
          <table>
            <tbody>
              {hot.length ? (
                hot.map(([key, count]) => (
                  <tr key={key}>
                    <th scope="row" title={key}>
                      {key.split('!')[1] ?? key}
                    </th>
                    <td>{count.toLocaleString()}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2}>暂无采样</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <pre ref={log} className="vm-debug-log">
          {trace || '等待原版主程序进入点…'}
        </pre>
      </div>
    </section>
  );
}
