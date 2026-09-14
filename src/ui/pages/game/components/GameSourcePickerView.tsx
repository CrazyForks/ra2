import { useState } from 'react';
import { parseRa2RelayUrl } from '../../../../games/ra2/networkTransport';
import type { GameSource } from '../../../../games/source';
import { useGameSourcePicker } from '../hooks/useGameSourcePicker';
import { Modal } from './Modal';
import { openGroupJoinDialog } from '../joinGroupDialog';
import './GameSourcePicker.css';
import type { DownloadLanguageFilter } from '../../../../games/downloadCatalog';
import {
  downloadLanguageLabels,
  downloadLanguageOptions,
  gameDownloadCatalog,
  isDownloadLanguageFilter,
} from '../../../../games/downloadCatalog';

export function GameSourcePickerView({ onSelected }: { onSelected(source: GameSource): void }) {
  const props = useGameSourcePicker(onSelected);
  const [relay, setRelay] = useState(() => new URLSearchParams(window.location.search).get('relay') ?? '');
  const [networkEnabled, setNetworkEnabled] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get('network') !== '0' && (query.get('network') === '1' || query.has('relay'));
  });
  let relayError = '';
  try {
    if (networkEnabled) parseRa2RelayUrl(relay);
  } catch (error) {
    relayError = (error as Error).message;
  }
  const updateRelay = (value: string) => {
    setRelay(value);
    try {
      const address = parseRa2RelayUrl(value);
      const url = new URL(window.location.href);
      url.searchParams.set('network', '1');
      if (address) url.searchParams.set('relay', value.trim());
      else url.searchParams.delete('relay');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* 无效草稿保留在输入框，禁止启动，修正后再更新配置。 */
    }
  };
  const toggleNetwork = (enabled: boolean) => {
    setNetworkEnabled(enabled);
    const url = new URL(window.location.href);
    url.searchParams.set('network', enabled ? '1' : '0');
    if (!enabled) url.searchParams.delete('relay');
    else {
      try {
        const value = parseRa2RelayUrl(relay);
        if (value) url.searchParams.set('relay', relay.trim());
      } catch {
        /* 输入框保留草稿，显示校验错误。 */
      }
    }
    window.history.replaceState(window.history.state, '', url);
  };
  const [downloads, setDownloads] = useState(false);
  const [downloadLanguage, setDownloadLanguage] = useState<DownloadLanguageFilter>('all');
  const state = props.manifest;
  const entries = state
    ? [
        ...state.manifest.thirdParty.map((file) => ({
          name: file.name,
          note: '第三方分享（版本固定）',
          optional: false,
          ok: state.present.has(file.name.toLowerCase()),
        })),
        ...state.manifest.playerRequired.map((file) => ({
          ...file,
          optional: false,
          ok: state.present.has(file.name.toLowerCase()),
        })),
        ...state.manifest.playerOptional.map((file) => ({
          ...file,
          optional: true,
          ok:
            state.present.has(file.name.toLowerCase()) ||
            (file.directory !== undefined && [...state.present].some((name) => name.startsWith(file.directory!))),
        })),
      ]
    : [];
  const visibleGames = gameDownloadCatalog.map((game) => ({
    ...game,
    links: game.links.filter((link) => downloadLanguage === 'all' || link.language === downloadLanguage),
  }));
  const hasVisibleDownloads = visibleGames.some((game) => game.links.length > 0);
  const emptyDownloadMessage =
    downloadLanguage === 'all'
      ? '当前没有已核验的下载入口。'
      : `当前没有已核验的 ${downloadLanguageLabels[downloadLanguage]} 下载入口。`;
  const emptyDownloadGlobalMessage =
    downloadLanguage === 'all'
      ? '当前没有已核验的下载地址，请稍后查看。'
      : `当前没有已核验的 ${downloadLanguageLabels[downloadLanguage]} 下载地址，请选择其他语言或稍后查看。`;
  return (
    <section className="panel game-folder-panel message-box game-source-picker" aria-labelledby="source-picker-title">
      <input ref={props.archiveRef} type="file" accept=".zip,.exe,.rar,.7z" hidden onChange={props.archiveChanged} />
      <input ref={props.folderRef} type="file" {...{ webkitdirectory: '' }} hidden onChange={props.folderChanged} />
      <header className="source-picker-heading">
        <span className="source-picker-brand">RA2 VM · 红色警戒</span>
        <h3 id="source-picker-title">{props.games.length > 1 ? '选择要启动的游戏' : '选择游戏资源'}</h3>
        <p className="source-picker-description" role="status">
          {props.description}
        </p>
      </header>
      <div className="network-settings">
        <label className="network-toggle">
          <input
            type="checkbox"
            checked={networkEnabled}
            disabled={props.busy}
            onChange={(event) => toggleNetwork(event.currentTarget.checked)}
          />
          联机
        </label>
        {networkEnabled && (
          <div className="relay-settings">
            <label htmlFor="relay-address">联机 relay 地址（可选）</label>
            <input
              id="relay-address"
              type="text"
              value={relay}
              disabled={props.busy}
              placeholder="127.0.0.1:15176"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={!!relayError}
              aria-describedby="relay-address-help"
              onChange={(event) => updateRelay(event.currentTarget.value)}
            />
            <small id="relay-address-help">
              留空使用默认服务；只需填写主机和端口，默认房间 /ra2；内网 IP 使用 WS，其他地址使用
              WSS。联机玩家填写相同地址；刷新保留设置。
            </small>
            {relayError && <p role="alert">{relayError}</p>}
          </div>
        )}
      </div>
      <div className="manifest-checklist" hidden={!state}>
        {entries.map((entry) => (
          <div
            key={entry.name}
            className={`manifest-line ${entry.ok ? 'ok' : 'missing'}${entry.optional ? ' optional' : ''}`}
          >
            {entry.ok ? '✓' : '✗'} {entry.name} — {entry.note}
            {entry.optional && !entry.ok ? '（可选，不影响启动）' : ''}
          </div>
        ))}
        {state?.complete && <div className="manifest-line ok">✓ 必需文件已集齐，正在启动…</div>}
      </div>
      <p className="source-picker-error" role="alert" hidden={!props.error}>
        {props.error}
      </p>
      <div className="resource-actions">
        <button className="dialog-button" disabled={props.busy || !!relayError} onClick={() => props.pick('archive')}>
          选择文件…
        </button>
        <button className="dialog-button" disabled={props.busy || !!relayError} onClick={() => props.pick('folder')}>
          选择文件夹…
        </button>
        <button
          className="dialog-button game-download-entry"
          aria-haspopup="dialog"
          disabled={props.busy}
          onClick={() => setDownloads(true)}
        >
          ↓ 没有游戏文件？点击下载
        </button>
      </div>
      {props.games.length > 1 && (
        <div className="detected-games" aria-label="选择检测到的游戏">
          {gameDownloadCatalog
            .filter((game) => props.games.includes(game.id))
            .map((game) => (
              <button
                key={game.id}
                className="dialog-button"
                disabled={props.busy || !!relayError}
                onClick={() => void props.chooseGame(game.id)}
              >
                <span className="game-icon" aria-hidden="true">
                  {game.id.toUpperCase()}
                </span>
                {game.title}
              </button>
            ))}
        </div>
      )}
      {import.meta.env.DEV && (
        <div className="development-sources">
          <button
            className="dialog-button development-source"
            disabled={props.busy || !!relayError}
            onClick={() => props.pick('development')}
          >
            开发测试
          </button>
        </div>
      )}
      <Modal
        open={downloads}
        onClose={() => setDownloads(false)}
        title="下载游戏资源"
        className="game-download-dialog message-box"
      >
        <div className="game-download-dialog-header">
          <h3>下载游戏资源</h3>
          <button type="button" className="dialog-button" onClick={() => setDownloads(false)}>
            关闭
          </button>
        </div>
        <div className="download-links-note">
          下载入口在新窗口打开第三方来源。语言筛选只筛选已核验的下载包；“全部”会保留所有目录入口，待核验入口会标注“语言待核验”。这里不修改已导入游戏的文字，也不是网页字体选择。下载完成后回到这里，点击「选择文件…」导入启动。
        </div>
        <label className="download-language-filter" htmlFor="download-language">
          <span>游戏文字语言</span>
          <select
            id="download-language"
            value={downloadLanguage}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isDownloadLanguageFilter(value)) setDownloadLanguage(value);
            }}
          >
            {downloadLanguageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="picker-games">
          {visibleGames.map((game) => (
            <section key={game.id} className="game-package-block">
              <h4 className="game-package-header">{game.title}</h4>
              <div className="download-links-lines">
                {game.links.length > 0 ? (
                  game.links.map((link) => {
                    const languageLabel = downloadLanguageLabels[link.language];
                    return (
                      <a
                        key={link.href}
                        className="game-download-link"
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`下载游戏资源：${link.label}（游戏文字语言：${languageLabel}；第三方来源，新窗口打开）`}
                      >
                        <span className="game-download-link-copy">
                          <span>↓ 下载 · {link.label}</span>
                          <span className="game-download-language">{languageLabel}</span>
                        </span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    );
                  })
                ) : (
                  <p className="download-links-empty" role="status">
                    {emptyDownloadMessage}
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
        {!hasVisibleDownloads && (
          <p className="download-links-empty-global" role="status">
            {emptyDownloadGlobalMessage}
          </p>
        )}
      </Modal>
      <p className="disclaimer">免责声明：本页面不提供游戏文件。游戏版权归原权利人所有，请只下载你合法拥有的内容。</p>
      <p className="join-group-hook">
        欢迎加入我们的微信交流群，
        <button type="button" className="join-group-link" disabled={props.busy} onClick={openGroupJoinDialog}>
          点此扫码入群
        </button>
      </p>
    </section>
  );
}
