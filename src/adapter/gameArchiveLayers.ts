import { GAME_ARCHIVE_DIRECTORY_RULES, gameArchiveLayers } from '../games/archivePolicy';
import type { SupportedGameId } from '../games/catalog';
import { extractArchiveFiles } from '../utils/archive/archiveExtract';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { ProgressiveGameFileProvider } from './progressiveFiles';

/** 启动层完成即返回 provider，其余解压继续。无法确认完整目录的嵌套/NSIS
 * 格式沿用完整解压回退；失败不可发布不完整缓存或用空字节冒充未解出的文件。 */
export function openGameArchive(
  bytes: Uint8Array | Blob,
  gameId: SupportedGameId | undefined,
  onStatus: (message: string) => void,
): Promise<SessionGameFileProvider> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    globalThis.addEventListener?.('pagehide', abort, { once: true });
    let provider: ProgressiveGameFileProvider | null = null;
    let prioritize = (_name: string) => {};
    const layers = gameArchiveLayers(gameId);
    const task = extractArchiveFiles(bytes, {
      wanted: layers.wanted,
      directoryRules: GAME_ARCHIVE_DIRECTORY_RULES,
      layers,
      signal: controller.signal,
      onStatus(message) {
        onStatus(message);
        provider?.updateStatus(message);
      },
      onPrioritizeReady(callback) {
        prioritize = callback;
      },
      onCatalog(names) {
        provider = new ProgressiveGameFileProvider('本地归档（两层加载）', new Set(names), abort, (name) =>
          prioritize(name),
        );
      },
      onFile(name, file) {
        provider?.accept(name, file);
      },
      onStartupReady() {
        if (!provider) throw new Error('启动层缺少资源目录');
        resolve(provider);
      },
    });
    void task
      .then(
        (result) => {
          if (provider) {
            provider.finish();
            resolve(provider);
          } else resolve(new SessionGameFileProvider('本地归档', result.files));
        },
        (error) => {
          provider?.finish(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        },
      )
      .finally(() => globalThis.removeEventListener?.('pagehide', abort));
  });
}
