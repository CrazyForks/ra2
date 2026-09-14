import type { SupportedGame } from './catalog';
import type { GameFileProvider } from '../resources/contracts';

export interface GameSource {
  game: SupportedGame;
  files: GameFileProvider;
  /** 检测时已读取的 EXE，避免 File System Access 后端重复读盘。 */
  executableBytes: Uint8Array;
  /** 启动附加文件：游戏根目录作用域，需在 Worker 重新发现游戏后再挂载。 */
  additionalFiles?: ReadonlyMap<string, Uint8Array>;
}
