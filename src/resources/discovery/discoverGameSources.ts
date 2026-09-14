import type { GameFileProvider } from '../contracts';
import type { GameSource } from '../../games/source';
import type { GameSourceTransformResult } from '../../games/discovery';
import { DEFAULT_GAME, SUPPORTED_GAMES, type SupportedGame, type SupportedGameId } from '../../games/catalog';
import { peImportKeys } from '../../vm86/pe';
import { ScopedGameFileProvider } from '../providers/scoped';
import { OverlayGameFileProvider } from '../providers/overlay';
/** 与原识别流程一致：这里只做 MZ 候选筛选，完整 PE 校验由装载器负责。 */
function isPortableExecutable(bytes: Uint8Array | null): bytes is Uint8Array {
  return !!bytes && bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
}

/** 不参与自动发现的 EXE 文件名标记（大小写无关子串）：卸载程序、联机客户端等。 */
const EXCLUDED_EXECUTABLE_MARKERS = ['uninst', 'listenclient'];

/** 内存来源递归发现的目录深度/数量上限（防 zip 炸弹式目录树）。 */
const DEEP_DISCOVERY_MAX_DEPTH = 12;
const DEEP_DISCOVERY_MAX_SCOPES = 2000;

/**
 * 自动发现目录中的游戏 EXE：根目录以及各已支持游戏的约定子目录各枚举一次，
 * 取全部 *.exe（大小写无关），排除 EXCLUDED_EXECUTABLE_MARKERS 中的杂项 EXE，
 * 用 MZ 魔数确认是 PE。已知游戏按文件名归类，未知 EXE 也可直接启动（按默认兼容层处理）。
 * 安装器/补丁壳由各游戏的 sourceTransform 自行识别并转换，通用文件层不含游戏名称或哈希。
 */
export async function discoverGameSources(provider: GameFileProvider): Promise<GameSource[]> {
  type Candidate = {
    scope: string;
    executable: string;
    bytes: Uint8Array;
    game: SupportedGame;
    known: boolean;
    /** 游戏转换器生成的文件，覆盖底层目录里的旧版同名文件。 */
    overlay?: ReadonlyMap<string, Uint8Array>;
    overlayLabel?: string;
  };
  const candidates: Candidate[] = [];
  const transformedByScope = new Map<string, { game: SupportedGame; result: GameSourceTransformResult }>();
  // RA2 与 Yuri's Revenge 共用同一安装目录；目录只枚举一次，避免候选项重复。
  const scopes = [...new Set(['', ...SUPPORTED_GAMES.map((game) => game.folder)])];
  if (provider.deepDiscovery) {
    // 内存来源（ZIP/安装包解压）内目录结构不固定：递归枚举子目录作为候选 scope，
    // 由文件名/导入表归类决定哪款游戏在哪一层。上限防 zip 炸弹式目录树。
    const visited = new Set(scopes.map((scope) => scope.toLowerCase()));
    const pending = [...scopes];
    while (pending.length && visited.size < DEEP_DISCOVERY_MAX_SCOPES) {
      const scope = pending.pop()!;
      if (scope.split('/').length >= DEEP_DISCOVERY_MAX_DEPTH) continue;
      for (const name of (await provider.list(scope)) ?? []) {
        const child = scope ? `${scope}/${name}` : name;
        const key = child.toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);
        // 内存后端对文件路径的 list 同样返回名字：用同步判定/读取区分文件与目录，
        // 文件不需要递归枚举。
        const isFile = provider.hasKnownFile?.(child) ?? (await provider.read(child)) !== null;
        if (isFile) continue;
        scopes.push(child);
        pending.push(child);
      }
    }
  }
  for (const scope of scopes) {
    for (const name of (await provider.list(scope)) ?? []) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.exe') || EXCLUDED_EXECUTABLE_MARKERS.some((marker) => lower.includes(marker))) continue;
      const path = scope ? `${scope}/${name}` : name;
      const bytes = await provider.read(path);
      if (!isPortableExecutable(bytes)) continue;
      let transformed = false;
      for (const game of SUPPORTED_GAMES) {
        const result = await game.sourceTransform?.(bytes);
        if (!result) continue;
        transformedByScope.set(scope, { game, result });
        transformed = true;
        break;
      }
      if (transformed) continue;
      const game = gameForExecutable(name, scope, bytes);
      if (game.unsupportedExecutableReason?.(bytes)) continue;
      candidates.push({
        scope,
        executable: name,
        bytes,
        game,
        known: SUPPORTED_GAMES.some((g) => matchesKnownExecutable(g, lower)) || game.abi !== DEFAULT_GAME.abi,
      });
    }
  }
  for (const [scope, transformed] of transformedByScope) {
    const { game, result } = transformed;
    const existing = candidates.find(
      (candidate) => candidate.scope === scope && candidate.executable.toLowerCase() === game.executable.toLowerCase(),
    );
    if (existing) {
      existing.bytes = result.executableBytes;
      existing.overlay = result.overlay;
      existing.overlayLabel = result.label;
      existing.game = game;
    } else {
      candidates.push({
        scope,
        executable: game.executable,
        bytes: result.executableBytes,
        game,
        known: true,
        overlay: result.overlay,
        overlayLabel: result.label,
      });
    }
  }
  // 已知游戏排前；其余按文件名稳定排序。
  // 同一目录同时存在主程序别名时只保留注册表指定的主文件。RA2 轻量包中的
  // game.exe / ra2.exe / Red Alert 2.exe 字节完全相同，不应显示三次。
  const selectedCandidates = candidates.filter(
    (candidate) =>
      candidate.executable.toLowerCase() === candidate.game.executable.toLowerCase() ||
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.scope === candidate.scope &&
          other.game.id === candidate.game.id &&
          other.executable.toLowerCase() === candidate.game.executable.toLowerCase(),
      ),
  );
  selectedCandidates.sort((a, b) => Number(b.known) - Number(a.known) || a.executable.localeCompare(b.executable));
  const sources: GameSource[] = [];
  for (const candidate of selectedCandidates) {
    let files: GameFileProvider = candidate.scope ? new ScopedGameFileProvider(provider, candidate.scope) : provider;
    if (candidate.overlay)
      files = new OverlayGameFileProvider(files, candidate.overlay, `（${candidate.overlayLabel ?? '自动转换'}）`);
    sources.push({
      game: candidate.game,
      files,
      executableBytes: candidate.bytes,
    });
  }
  return sources;
}

function matchesKnownExecutable(game: SupportedGame, lowerName: string): boolean {
  return game.executable.toLowerCase() === lowerName;
}

/** 按文件名归类到已知游戏；无法归类时按导入表覆盖度选择，再退回 RA2。 */
function gameForExecutable(name: string, scope: string, bytes: Uint8Array): SupportedGame {
  const lower = name.toLowerCase();
  const known = SUPPORTED_GAMES.find((game) => matchesKnownExecutable(game, lower));
  if (known) return known.executable.toLowerCase() === lower ? known : { ...known, executable: name };
  const scoped = SUPPORTED_GAMES.find((game) => game.folder.toLowerCase() === scope.toLowerCase());
  if (scoped) return { ...scoped, executable: name };
  // 自定义命名的改版 EXE：用户直接选择游戏目录时 scope 退化为根目录，
  // 文件名与目录都匹配不上时，按 RA2/YR ABI 对该 EXE 的导入覆盖度归类。
  const imports = peImportKeys(bytes);
  const byImports =
    imports.length > 0
      ? SUPPORTED_GAMES.find((game) => game !== DEFAULT_GAME && coversAllImports(game, imports))
      : undefined;
  if (byImports) return { ...byImports, executable: name };
  return {
    id: DEFAULT_GAME.id,
    title: name.replace(/\.exe$/i, ''),
    executable: name,
    folder: scope,
    argBytes: DEFAULT_GAME.argBytes,
    abi: DEFAULT_GAME.abi,
    shimProfile: DEFAULT_GAME.shimProfile,
    runtimeHooks: DEFAULT_GAME.runtimeHooks,
  };
}

/** 兼容层 ABI 表是否覆盖该 EXE 的全部导入键。 */
function coversAllImports(game: SupportedGame, imports: readonly string[]): boolean {
  return imports.every((key) => game.abi[key] !== undefined);
}

export async function validateGameDirectory(
  provider: GameFileProvider,
  preferredGame?: SupportedGameId,
): Promise<GameSource[]> {
  const sources = await discoverGameSources(provider);
  if (preferredGame) {
    const selected = sources.find((source) => source.game.id === preferredGame);
    if (selected) return [selected];
    const game = SUPPORTED_GAMES.find((item) => item.id === preferredGame);
    if (game?.unsupportedExecutableReason) {
      const bytes = await provider.read(game.executable);
      const reason = bytes && game.unsupportedExecutableReason(bytes);
      if (reason) throw new Error(reason);
    }
    throw new Error(`文件夹“${provider.label}”中未找到 ${game?.title ?? preferredGame} 的主程序`);
  }
  if (!sources.length) {
    throw new Error(`文件夹“${provider.label}”中未找到可运行的游戏 EXE（*.exe，卸载/联机客户端除外）`);
  }
  return sources;
}
