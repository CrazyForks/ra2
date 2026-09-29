import '../helpers/chineseLocale';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import { afterEach, expect, it, vi } from 'vitest';
import { GAME_MANIFESTS } from '../../src/games/manifest';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { ProgressiveGameFileProvider } from '../../src/adapter/progressiveFiles';
import { createGameSourcePicker, restoreCachedGameSource } from '../../src/ui/pages/game/gameSourcePicker';
import type { SupportedGameId } from '../../src/games/catalog';
import type { GameFileProvider } from '../../src/resources/contracts';
const mocks = vi.hoisted(() => ({ load: vi.fn(), validate: vi.fn() }));
vi.mock('../../src/adapter/gameArchiveLayers', () => ({ openGameArchive: mocks.load }));
vi.mock('../../src/resources/discovery/discoverGameSources', () => ({ validateGameDirectory: mocks.validate }));
vi.mock('../../src/adapter/cachedGameFiles', () => ({
  saveCachedGameFiles: vi.fn(),
  restoreCachedFileProvider: vi.fn(),
}));
vi.mock('../../src/platform/browser/files/directoryAccess', () => ({
  rememberPreferredGame: vi.fn(),
  loadPreferredGame: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
it('opens the picker for an absent cache without reporting a read failure', async () => {
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockResolvedValue(null);
  await expect(restoreCachedGameSource()).resolves.toBeNull();
});
it('surfaces the failing file when a required cached Blob cannot be read', async () => {
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockImplementation(async (gameId) =>
    gameId === 'ra2'
      ? ({
          hasKnownFile: () => true,
          readPrefix: vi.fn().mockRejectedValue(new DOMException('unreadable', 'NotReadableError')),
        } as never)
      : null,
  );
  await expect(restoreCachedGameSource()).rejects.toThrow('ra2/game.exe：unreadable');
});
function prepare(ids: SupportedGameId[]) {
  const files = new Map(
    ids.flatMap((id) =>
      GAME_MANIFESTS[id].playerRequired.map((file) => [file.name.toLowerCase(), new Uint8Array([1])] as const),
    ),
  );
  const provider = new SessionGameFileProvider('test', files);
  mocks.load.mockResolvedValue(provider);
  mocks.validate.mockImplementation(async (_provider: GameFileProvider, game: SupportedGameId) => [
    { game: { id: game } },
  ]);
  return provider;
}
it.each(['ra2', 'yr'] as const)('单版本资源自动启动 %s，保留包内主程序', async (game) => {
  const provider = prepare([game]);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  picker.beginPick();
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().games).toEqual([]);
  expect(selected).toHaveBeenCalledWith({ game: { id: game } });
  expect(mocks.validate).toHaveBeenCalledWith(provider, game);
  const { saveCachedGameFiles } = await import('../../src/adapter/cachedGameFiles');
  expect(vi.mocked(saveCachedGameFiles).mock.calls[0]![1].get(game === 'ra2' ? 'game.exe' : 'gamemd.exe')).toEqual(
    new Uint8Array([1]),
  );
});
it('双版本先显示选择，选择后才校验 EXE，重复点击不重复启动', async () => {
  prepare(['ra2', 'yr']);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().games).toEqual(['ra2', 'yr']);
  mocks.load.mock.calls[0]![2]('后台提取中');
  expect(picker.getSnapshot().description).toContain('请选择');
  expect(selected).not.toHaveBeenCalled();
  await picker.chooseGame('yr');
  await picker.chooseGame('ra2');
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
});
it('缺件不启动；销毁取消待选的后台解压', async () => {
  prepare([]);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().error).toContain('缺少');
  expect(selected).not.toHaveBeenCalled();
  const base = prepare(['ra2', 'yr']),
    abort = vi.fn();
  mocks.load.mockResolvedValue(new ProgressiveGameFileProvider('pending', new Set(base.files.keys()), abort));
  await picker.importArchive(new Blob() as File);
  picker.dispose();
  expect(abort).toHaveBeenCalledTimes(1);
  await picker.chooseGame('yr');
  expect(selected).not.toHaveBeenCalled();
});

it('目录文件也先识别资源，大小写不影响单版本自动启动', async () => {
  prepare(['yr']);
  const files = GAME_MANIFESTS.yr.playerRequired.map((entry) => {
    const file = new File([new Uint8Array([1])], entry.name.toUpperCase());
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/' + entry.name });
    return file;
  });
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importFolder(files);
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
  expect(mocks.load).not.toHaveBeenCalled();
});

it.each([['ra2'], ['yr'], ['ra2', 'yr']] as SupportedGameId[][])('统一开发入口按资源清单识别 %j', async (...ids) => {
  const provider = prepare(ids);
  const listing = vi.spyOn(HttpGameFileProvider.prototype, 'list').mockResolvedValue([...provider.files.keys()]);
  try {
    const selected = vi.fn(),
      picker = createGameSourcePicker(selected);
    await picker.development();
    expect(listing).toHaveBeenCalledWith('ra2');
    if (ids.length === 1) expect(selected).toHaveBeenCalledWith({ game: { id: ids[0] } });
    else {
      expect(picker.getSnapshot().games).toEqual(ids);
      expect(selected).not.toHaveBeenCalled();
    }
  } finally {
    listing.mockRestore();
  }
});

it('rejects a bundle without its executable and does not restore legacy resource-only caches', async () => {
  const base = prepare(['ra2']);
  base.files.delete('game.exe');
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().error).toContain('game.exe');
  expect(selected).not.toHaveBeenCalled();
  expect(mocks.validate).not.toHaveBeenCalled();
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockResolvedValue(base as never);
  await expect(restoreCachedGameSource()).resolves.toBeNull();
  expect(mocks.validate).not.toHaveBeenCalled();
});

it('restores the exact cached bundle provider, including its executable', async () => {
  const base = prepare(['ra2']);
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockImplementation(async (id) => (id === 'ra2' ? (base as never) : null));
  await expect(restoreCachedGameSource()).resolves.toEqual({ game: { id: 'ra2' } });
  expect(mocks.validate).toHaveBeenCalledWith(base, 'ra2');
});

it('does not replace the last cached bundle when the supplied executable fails validation', async () => {
  prepare(['ra2']);
  mocks.validate.mockRejectedValue(new Error('Invalid package executable'));
  const { saveCachedGameFiles } = await import('../../src/adapter/cachedGameFiles');
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().error).toContain('Invalid package executable');
  expect(selected).not.toHaveBeenCalled();
  expect(saveCachedGameFiles).not.toHaveBeenCalled();
});

it.each(['ra2', 'yr'] as const)(
  'persists %s installation settings unchanged alongside the executable',
  async (game) => {
    const base = prepare([game]);
    const name = game === 'ra2' ? 'ra2.ini' : 'ra2md.ini';
    const bytes = new TextEncoder().encode('[Intro]\r\nPlay=no\r\n');
    base.files.set(name, bytes);
    const selected = vi.fn();
    await createGameSourcePicker(selected).importArchive(new Blob() as File);
    const { saveCachedGameFiles } = await import('../../src/adapter/cachedGameFiles');
    expect(vi.mocked(saveCachedGameFiles).mock.calls[0]![1].get(name)).toEqual(bytes);
    expect(selected).toHaveBeenCalledTimes(1);
  },
);

it('clears import progress on failure and ignores reports after disposal', async () => {
  const picker = createGameSourcePicker(vi.fn());
  let report!: (value: { completedFiles: number; totalFiles: number | null }) => void;
  let reject!: (error: Error) => void;
  mocks.load.mockImplementation((_file, _game, _status, progress) => {
    report = progress;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const pending = picker.importArchive(new Blob() as File);
  report({ completedFiles: 1, totalFiles: 3 });
  expect(picker.getSnapshot().progress).toEqual({ completedFiles: 1, totalFiles: 3 });
  reject(new Error('broken archive'));
  await pending;
  expect(picker.getSnapshot()).toMatchObject({ progress: null, busy: false, error: 'broken archive' });
  picker.dispose();
  report({ completedFiles: 3, totalFiles: 3 });
  expect(picker.getSnapshot().progress).toBeNull();
});
