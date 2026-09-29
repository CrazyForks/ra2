import { t, localizeLabel, localizeText } from '../../../shared/i18n/translate';
import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_GAMES } from '../../../../games/catalog';
import { parseRa2RelayUrl } from '../../../../games/ra2/networkTransport';
import type { GameSource } from '../../../../games/source';
import { useGameSourcePicker } from '../hooks/useGameSourcePicker';
import { openGroupJoinDialog } from '../joinGroupDialog';
import { Ra2Screen } from './ra2menu/Ra2Screen';
import { Ra2MenuPanel } from './ra2menu/Ra2MenuPanel';
import { Ra2MenuHeader } from './ra2menu/Ra2MenuHeader';
import { Ra2MenuNav } from './ra2menu/Ra2MenuNav';
import { Ra2MenuButton } from './ra2menu/Ra2MenuButton';
import './GameSourcePicker.css';
import { Ra2LoadingView, Ra2MenuFooter } from './ra2menu/Ra2LoadingView';

/** First screen styled after redalert2.com's launcher: the site's menu art, right-side command column, and footer. */
export function GameSourcePickerView({ onSelected }: { onSelected(source: GameSource): void }) {
  const props = useGameSourcePicker(onSelected);
  const [relay, setRelay] = useState(() => new URLSearchParams(window.location.search).get('relay') ?? '');
  const [networkEnabled, setNetworkEnabled] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return query.get('network') !== '0' && (query.get('network') === '1' || query.has('relay'));
  });
  const networkSettings = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!networkEnabled) return;
    // Wait for the expanded layout; reveal settings without focusing the input or opening a mobile keyboard.
    const frame = requestAnimationFrame(() =>
      networkSettings.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [networkEnabled]);
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
      /* Keep invalid drafts in the input and disable startup; update configuration only after correction. */
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
        /* Retain the input draft and show the validation error. */
      }
    }
    window.history.replaceState(window.history.state, '', url);
  };
  const state = props.manifest;
  const entries = state
    ? [
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
  const systemStatus = props.awaitingSelection
    ? 'AWAITING INPUT'
    : props.busy
      ? 'SCANNING'
      : props.error
        ? 'RESOURCE ERROR'
        : props.games.length > 1
          ? 'SELECT VERSION'
          : 'STANDBY';
  const actionsDisabled = props.busy || !!relayError;
  return (
    <section className="game-folder-panel game-source-picker" aria-labelledby="source-picker-title">
      <input ref={props.archiveRef} type="file" accept=".zip,.exe,.rar,.7z" hidden onChange={props.archiveChanged} />
      <input ref={props.folderRef} type="file" {...{ webkitdirectory: '' }} hidden onChange={props.folderChanged} />
      {props.busy && !props.awaitingSelection ? (
        <Ra2LoadingView
          title={t('选择游戏资源')}
          phase={t('加载资源')}
          detail={localizeText(props.description)}
          progressLabel={
            props.progress
              ? props.progress.totalFiles === null
                ? t('已解压 {0} 个文件', props.progress.completedFiles)
                : t('已解压 {0}/{1} 个文件', props.progress.completedFiles, props.progress.totalFiles)
              : localizeText(props.description)
          }
          progress={
            props.progress?.totalFiles ? (props.progress.completedFiles / props.progress.totalFiles) * 100 : undefined
          }
        />
      ) : (
        <Ra2Screen>
          <Ra2MenuPanel>
            <Ra2MenuHeader>
              <span className="status-terminal-label">SYSTEM STATUS</span>
              <span
                className={`status-terminal-readout ${props.error ? 'error' : props.busy && !props.awaitingSelection ? 'scanning' : ''}`}
                role="status"
              >
                <i aria-hidden="true" />
                {systemStatus}
              </span>
              <span className="status-terminal-divider" aria-hidden="true" />
              <span className="status-terminal-detail">
                {props.awaitingSelection
                  ? 'SELECT LOCAL RESOURCE'
                  : props.busy
                    ? localizeText(props.description)
                    : 'COMMAND LINK: LOCAL'}
              </span>
            </Ra2MenuHeader>
            <Ra2MenuNav label={t('游戏菜单')}>
              {props.games.length > 1 && (
                <div className="detected-games" aria-label={t('选择检测到的游戏')}>
                  {SUPPORTED_GAMES.filter((game) => props.games.includes(game.id)).map((game) => (
                    <Ra2MenuButton
                      key={game.id}
                      className="dialog-button"
                      disabled={actionsDisabled}
                      onClick={() => void props.chooseGame(game.id)}
                    >
                      <img className="game-icon" src={`/icons/${game.id}.png`} alt="" aria-hidden="true" />
                      {localizeLabel(game.title)}
                    </Ra2MenuButton>
                  ))}
                </div>
              )}
              {props.games.length > 1 && <span className="ra2-menu-blank" aria-hidden="true" />}
              <Ra2MenuButton disabled={actionsDisabled} onClick={() => props.pick('archive')}>
                {t('选择文件…')}
              </Ra2MenuButton>
              <Ra2MenuButton disabled={actionsDisabled} onClick={() => props.pick('folder')}>
                {t('选择文件夹…')}
              </Ra2MenuButton>
              {import.meta.env.DEV && (
                <Ra2MenuButton
                  className="development-source"
                  disabled={actionsDisabled}
                  onClick={() => props.pick('development')}
                >
                  {t('开发测试')}
                </Ra2MenuButton>
              )}
              <span className="ra2-spacer" aria-hidden="true" />
              <Ra2MenuButton onClick={openGroupJoinDialog}>{t('点此扫码入群')}</Ra2MenuButton>
              <a
                className="ra2-menu-btn"
                href="https://github.com/ra2-games/ra2"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="ra2-menu-btn-label">GitHub</span>
              </a>
            </Ra2MenuNav>
            <div className="ra2-content">
              <p className="portrait-orientation-hint">{t('横屏获取更好的游戏体验')}</p>
              <h3 id="source-picker-title">{props.games.length > 1 ? t('选择要启动的游戏') : t('选择游戏资源')}</h3>
              <section className="game-guide" aria-label={t('游戏指南')}>
                <h4>{t('游戏指南')}</h4>
                <ul>
                  <li>{t('导入 ZIP / EXE 压缩包或完整游戏目录。')}</li>
                  <li>{t('资源识别后，按提示选择 RA2 或 YR。')}</li>
                  <li>{t('联机参数可在启动前设置。')}</li>
                </ul>
              </section>
              <p className="source-picker-description" role="status" hidden={props.busy}>
                {localizeText(props.description)}
              </p>
              <div className="network-toggle-row">
                <label className="network-toggle">
                  <input
                    type="checkbox"
                    checked={networkEnabled}
                    disabled={props.busy}
                    onChange={(event) => toggleNetwork(event.currentTarget.checked)}
                  />
                  <span className="network-toggle-led" aria-hidden="true"></span>
                  {t('联机')}
                </label>
                <span className="network-toggle-hint">{t('与好友同房对战')}</span>
              </div>
              <div className="manifest-checklist" hidden={!state}>
                {entries.map((entry) => (
                  <div
                    key={entry.name}
                    className={`manifest-line ${entry.ok ? 'ok' : 'missing'}${entry.optional ? ' optional' : ''}`}
                  >
                    {entry.ok ? '✓' : '✗'} {entry.name} — {localizeLabel(entry.note)}
                    {entry.optional && !entry.ok ? t('（可选，不影响启动）') : ''}
                  </div>
                ))}
                {state?.complete && <div className="manifest-line ok">{t('✓ 必需文件已集齐，正在启动…')}</div>}
              </div>
              {networkEnabled && (
                <div className="network-settings" ref={networkSettings}>
                  <div className="relay-settings">
                    <label htmlFor="relay-address">{t('联机 relay 地址（可选）')}</label>
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
                    <small id="relay-address-help">{t('留空使用默认服务器；所有玩家填写同一地址即可同房。')}</small>
                    <small className="relay-tech-note">
                      {t('只需主机与端口，默认房间 /ra2；内网 IP 使用 WS，其他地址使用 WSS。')}
                    </small>
                    {relayError && <p role="alert">{localizeText(relayError)}</p>}
                  </div>
                </div>
              )}
              <p className="source-picker-error" role="alert" hidden={!props.error}>
                {localizeText(props.error)}
              </p>
            </div>
          </Ra2MenuPanel>
          <Ra2MenuFooter />
        </Ra2Screen>
      )}
    </section>
  );
}
