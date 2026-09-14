import type { GameFileProvider } from '../../../resources/contracts';
import { ScopedGameFileProvider } from '../../../resources/providers/scoped';
import { OverlayGameFileProvider } from '../../../resources/providers/overlay';
import { isSupportedGameId, type SupportedGameId } from '../../../games/catalog';
import { DirectoryGameFileProvider } from './directory';

/** 穿透 Scoped/Overlay 包装取目录后端的 FileSystemDirectoryHandle；
 *  非目录后端（dev http / 内存）返回 null。worker 模式下由主线程据此构造 init 消息。 */
export function directoryHandleOf(provider: GameFileProvider): FileSystemDirectoryHandle | null {
  if (provider instanceof DirectoryGameFileProvider) return provider.handle;
  if (provider instanceof ScopedGameFileProvider || provider instanceof OverlayGameFileProvider) {
    return directoryHandleOf(provider.parent);
  }
  return null;
}

/** 收集目录后端之上的内存叠加层（在线包文件），返回顺序为最内层→最外层
 *  （后层覆盖前层，与 Overlay 链的读取优先级一致）；链条不含目录后端时返回
 *  null（纯会话 provider 由调用方整体序列化，不走叠加层）。 */
export function collectDirectoryOverlays(provider: GameFileProvider): ReadonlyMap<string, Uint8Array>[] | null {
  if (provider instanceof OverlayGameFileProvider) {
    const inner = collectDirectoryOverlays(provider.parent);
    if (!inner) return null;
    inner.push(provider.overlays);
    return inner;
  }
  if (provider instanceof ScopedGameFileProvider) return collectDirectoryOverlays(provider.parent);
  if (provider instanceof DirectoryGameFileProvider) return [];
  return null;
}

/** 返回当前 Provider 链相对于授权根目录的实际目录作用域。 */
export function directoryScopeOf(provider: GameFileProvider): string {
  if (provider instanceof ScopedGameFileProvider) {
    const parentScope = directoryScopeOf(provider.parent);
    return parentScope && provider.scope ? `${parentScope}/${provider.scope}` : provider.scope || parentScope;
  }
  if (provider instanceof OverlayGameFileProvider) return directoryScopeOf(provider.parent);
  return '';
}

/** 忘记上次目录，供原版“退出游戏”后改选文件夹。 */
export async function forgetGameDirectory(): Promise<void> {
  window.localStorage.removeItem(PREFERRED_GAME_KEY);
}

export function rememberPreferredGame(game: SupportedGameId): void {
  window.localStorage.setItem(PREFERRED_GAME_KEY, game);
}

export function loadPreferredGame(): SupportedGameId | null {
  const value = window.localStorage.getItem(PREFERRED_GAME_KEY);
  return value !== null && isSupportedGameId(value) ? value : null;
}

const PREFERRED_GAME_KEY = 'ra2-vm-preferred-game';
