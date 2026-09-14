import { GAME_ARCHIVE_DIRECTORY_RULES } from '../../../games/archivePolicy';
import { SUPPORTED_GAMES, supportedGame, type SupportedGameId } from '../../../games/catalog';
import { HttpGameFileProvider } from '../../../platform/browser/files/http';
import { loadPreferredGame, rememberPreferredGame } from '../../../platform/browser/files/directoryAccess';
import { validateGameDirectory } from '../../../resources/discovery/discoverGameSources';
import { OverlayGameFileProvider } from '../../../resources/providers/overlay';
import { ScopedGameFileProvider } from '../../../resources/providers/scoped';
import { type GameFileProvider } from '../../../resources/contracts';
import { type GameSource } from '../../../games/source';
import { SessionGameFileProvider } from '../../../platform/browser/files/sessionFiles';
import { extractArchiveFiles } from '../../../utils/archive/archiveExtract';
import { openGameArchive } from '../../../adapter/gameArchiveLayers';
import { ProgressiveGameFileProvider, progressiveFilesOf } from '../../../adapter/progressiveFiles';
import { restoreCachedFileProvider, saveCachedGameFiles } from '../../../adapter/cachedGameFiles';
import { loadThirdPartyFiles } from '../../../adapter/thirdPartyFiles';
import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS, type GameManifest } from '../../../games/manifest';
import { createStore } from '../../shared/state/store';

export interface PickerState {
  description: string;
  error: string;
  busy: boolean;
  games: SupportedGameId[];
  manifest: { manifest: GameManifest; present: ReadonlySet<string>; complete: boolean } | null;
}

/** 资源导入服务：只接收 File/版本并发布状态，文件选择器生命周期属于 React hook。 */
export function createGameSourcePicker(resolve: (source: GameSource) => void) {
  let disposed = false;
  const state: PickerState = {
    description: '先选择游戏资源；只包含一个版本时自动启动，包含两个版本时再选择要玩的游戏。',
    error: '',
    busy: false,
    manifest: null,
    games: [],
  };
  const store = createStore({ ...state });
  let pendingSource: GameFileProvider | null = null;
  const publish = () => {
    if (!disposed) store.set({ ...state });
  };
  const setButtonsDisabled = (disabled: boolean): void => {
    state.busy = disabled;
    publish();
  };
  const presentNames = (names: Iterable<string>): Set<string> => new Set([...names].map((name) => name.toLowerCase()));
  const renderManifest = (manifest: GameManifest, present: ReadonlySet<string>, complete: boolean): void => {
    state.manifest = { manifest, present, complete };
    publish();
  };
  const use = async (load: () => Promise<GameFileProvider | null>, gameId?: SupportedGameId) => {
    state.error = '';
    publish();
    setButtonsDisabled(true);
    try {
      const base = await load();
      if (disposed) {
        if (base) progressiveFilesOf(base)?.cancel();
        return;
      }
      // null = 玩家取消选择（如压缩包对话框关闭）：按 AbortError 静默回到面板。
      if (!base) throw new DOMException('已取消', 'AbortError');
      if (gameId) await runImport(base, gameId);
      else {
        const names = presentNames(
          base instanceof ProgressiveGameFileProvider ? base.inventory : ((await base.list('')) ?? []),
        );
        const games = (Object.keys(GAME_MANIFESTS) as SupportedGameId[]).filter((id) =>
          GAME_MANIFESTS[id].playerRequired.every((file) => names.has(file.name.toLowerCase())),
        );
        if (games.length === 1) await runImport(base, games[0]!);
        else if (games.length > 1) {
          pendingSource = base;
          state.games = games;
          state.description = '资源中包含以下游戏，请选择要启动的版本。';
          publish();
        } else {
          progressiveFilesOf(base)?.cancel();
          throw new Error(
            '未找到完整游戏资源。' +
              (Object.keys(GAME_MANIFESTS) as SupportedGameId[])
                .map(
                  (id) =>
                    supportedGame(id).title +
                    ' 缺少：' +
                    GAME_MANIFESTS[id].playerRequired
                      .filter((file) => !names.has(file.name.toLowerCase()))
                      .map((file) => file.name)
                      .join('、'),
                )
                .join('；'),
          );
        }
      }
    } catch (reason) {
      if ((reason as DOMException)?.name !== 'AbortError') {
        state.error = reason instanceof Error ? reason.message : String(reason);
        publish();
      }
    } finally {
      setButtonsDisabled(false);
    }
  };
  /** 清单闸门：按所选版本的清单取主程序（game.exe / gamemd.exe）→
   *  覆盖层 → 渲染清单；缺必需文件返回 null（面板保留清单）。 */
  const manifestGate = async (
    base: GameFileProvider,
    archiveNames: ReadonlySet<string>,
    gameId: SupportedGameId,
  ): Promise<GameFileProvider | null> => {
    const manifest = GAME_MANIFESTS[gameId];
    // 主程序一律用固定兼容版本（版本敏感，shim 固定地址依赖精确字节）。
    const thirdPartyFiles = await loadThirdPartyFiles(manifest, (message) => {
      state.description = message;
      publish();
    });
    if (disposed) return null;
    // 覆盖层优先：主程序盖过归档同名文件。
    const provider = new OverlayGameFileProvider(base, thirdPartyFiles, ' + 第三方', false, false, false);
    const present = new Set(archiveNames);
    for (const thirdParty of manifest.thirdParty) present.add(thirdParty.name.toLowerCase());
    const missing = manifest.playerRequired
      .filter((file) => !present.has(file.name.toLowerCase()))
      .map((file) => file.name);
    const complete = missing.length === 0;
    renderManifest(manifest, present, complete);
    if (!complete) {
      state.description =
        `${supportedGame(gameId).title} 缺少必需文件：${missing.join('、')}。` + '请重新选择包含这些文件的资源。';
      publish();
      return null;
    }
    state.description = '必需文件已集齐，正在启动…';
    publish();
    // 记住本次导入：下次打开页面自动恢复，免重复选择（主程序已由
    // thirdPartyFiles 单独持久化，这里只存玩家侧文件）。
    if (base instanceof SessionGameFileProvider) {
      const persist = () => {
        const playerFiles = new Map<string, Uint8Array>();
        for (const [path, bytes] of base.files) {
          const lower = path.toLowerCase();
          if (lower === 'game.exe' || lower === 'gamemd.exe') continue;
          if (base instanceof ProgressiveGameFileProvider && !base.inventory.has(lower)) continue;
          playerFiles.set(lower, bytes);
        }
        // 分层导入不做“只存必需文件”的配额降级，否则又会丢掉空电影占位或
        // MOD 覆盖。写入失败让原事务回滚，保留上次完整包。
        return saveCachedGameFiles(
          gameId,
          playerFiles,
          base instanceof ProgressiveGameFileProvider ? [] : manifest.playerRequired.map((file) => file.name),
        );
      };
      // 必须等其他层完整成功再原子替换缓存；取消/失败时保留上次完整资源集，
      // 不把“已具备启动层”误标成“可刷新恢复的完整包”。
      if (base instanceof ProgressiveGameFileProvider) {
        void base.completion
          .then(persist)
          .catch((error) => console.warn('[游戏文件] 后台解压未完成，不更新资源缓存', error));
      } else void persist();
    }
    return provider;
  };

  /** 导入尾部：走清单闸门 → 集齐则校验主程序并启动（缺件留在面板）。 */
  const runImport = async (base: GameFileProvider, gameId: SupportedGameId): Promise<void> => {
    try {
      const present =
        base instanceof ProgressiveGameFileProvider
          ? presentNames(base.inventory)
          : base instanceof SessionGameFileProvider
            ? presentNames(base.files.keys())
            : // 开发版是目录 provider，不是内存归档；清单必须来自真实目录，不能
              // 固定为空，否则资源齐全也永远卡在导入面板，浏览器回归无法启动。
              presentNames((await base.list('')) ?? []);
      const provider = await manifestGate(base, present, gameId);
      if (!provider) {
        progressiveFilesOf(base)?.cancel();
        return;
      }
      const source = (await validateGameDirectory(provider, gameId))[0]!;
      if (disposed) {
        progressiveFilesOf(base)?.cancel();
        return;
      }
      rememberPreferredGame(source.game.id);
      disposed = true;
      resolve(source);
    } catch (error) {
      progressiveFilesOf(base)?.cancel();
      throw error;
    }
  };

  // 阶段状态文案（解析/读取进度），写入面板说明行。
  const onStatus = (message: string): void => {
    if (state.games.length < 2) {
      state.description = message;
      publish();
    }
  };
  /** 解析所选归档（迟到 change 复用：挂起项已被取消结算时重新进入完整
   *  use 流程，按钮禁用与错误显示随流程恢复）；清单闸门在 use 里走。 */
  const processArchiveFile = async (file: File): Promise<GameFileProvider | null> => {
    onStatus('正在解析归档目录并准备启动层…');
    return openGameArchive(file, undefined, onStatus);
  };
  /** 读取所选目录内清单所需文件（迟到 change 复用同归档）；清单闸门在 use 里走。 */
  const processFolderFiles = (files: File[]): Promise<GameFileProvider | null> =>
    (async () => {
      // 只读清单所需文件；basename 任意层级匹配。
      const wanted = presentNames(ARCHIVE_WANTED_NAMES);
      const wantedDirs = [...wanted].filter((name) => name.endsWith('/'));
      const extracted = new Map<string, Uint8Array>();
      const archives: File[] = [];
      const readBytes = async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());
      for (const file of files) {
        const name = file.name.toLowerCase();
        // 目录前缀条目（taunts/）按 webkitRelativePath 带目录存储。
        const rel = file.webkitRelativePath.split('/').slice(1).join('/').toLowerCase();
        const storeKey = wanted.has(name) ? name : (wantedDirs.find((dir) => rel.startsWith(dir)) ?? null);
        if (storeKey) {
          extracted.set(storeKey, await readBytes(file));
        } else if (/\.(zip|rar|7z|exe)$/.test(name)) {
          archives.push(file);
        }
      }
      // 目录内若有单个归档（安装包等）也深入解压（同一 7z-wasm Worker，
      // 多层递归）；普通 exe（启动器副本等）非归档，尝试失败即跳过。
      for (const archive of archives.slice(0, 8)) {
        onStatus(`正在解压目录内归档：${archive.name} …`);
        try {
          const result = await extractArchiveFiles(await readBytes(archive), {
            wanted: [...ARCHIVE_WANTED_NAMES],
            directoryRules: GAME_ARCHIVE_DIRECTORY_RULES,
            onStatus,
          });
          for (const [name, entryBytes] of result.files) extracted.set(name, entryBytes);
        } catch (error) {
          console.warn('[游戏文件] 目录内归档无法解析，跳过', archive.name, error);
        }
      }
      onStatus(`目录读取完成：${extracted.size} 个所需文件。`);
      return new SessionGameFileProvider('本地目录', extracted);
    })();
  return {
    ...store,
    beginPick() {
      if (pendingSource) progressiveFilesOf(pendingSource)?.cancel();
      pendingSource = null;
      state.games = [];
      state.manifest = null;
      state.error = '';
      setButtonsDisabled(true);
    },
    chooseGame(gameId: SupportedGameId) {
      if (state.busy || !pendingSource || !state.games.includes(gameId)) return;
      const base = pendingSource;
      pendingSource = null;
      state.games = [];
      return use(async () => base, gameId);
    },
    cancelPick() {
      setButtonsDisabled(false);
    },
    importArchive(file: File) {
      return use(() => processArchiveFile(file));
    },
    importFolder(files: File[]) {
      return use(() => processFolderFiles(files));
    },
    development() {
      // RA2/YR 共用开发资源目录，走与玩家导入相同的版本识别流程。
      return use(() => developmentSourceProvider(new HttpGameFileProvider()));
    },
    dispose() {
      disposed = true;
      if (pendingSource) progressiveFilesOf(pendingSource)?.cancel();
      pendingSource = null;
    },
  };
}

export async function developmentSourceProvider(provider: HttpGameFileProvider): Promise<GameFileProvider> {
  return new ScopedGameFileProvider(provider, supportedGame('ra2').folder);
}

/** 从上次导入的 IndexedDB 文件集恢复游戏源：必需文件齐全则直接可用，
 *  页面跳过选择面板自动启动；不齐或无缓存返回 null（走选择面板）。 */
export async function restoreCachedGameSource(): Promise<GameSource | null> {
  const preferred = loadPreferredGame();
  const order = [preferred, ...SUPPORTED_GAMES.map((game) => game.id).filter((id) => id !== preferred)];
  for (const gameId of order) {
    if (!gameId) continue;
    const manifest = GAME_MANIFESTS[gameId];
    const cached = await restoreCachedFileProvider(gameId).catch(() => null);
    if (!cached) continue;
    const missing = manifest.playerRequired.filter((file) => cached.hasKnownFile(file.name.toLowerCase()) !== true);
    if (missing.length) continue;
    const thirdParty = await loadThirdPartyFiles(manifest).catch(() => null);
    if (!thirdParty) continue;
    const provider = new OverlayGameFileProvider(cached, thirdParty, ' + 第三方', false, false, false);
    const sources = await validateGameDirectory(provider, gameId).catch(() => []);
    if (sources[0]) return sources[0];
  }
  return null;
}
