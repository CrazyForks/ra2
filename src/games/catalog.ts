import { DRIVE_CDROM, DRIVE_FIXED } from '../vm86/win32';
import { RA2_ABI, ra2Win32ArgBytes } from './ra2/abi';
import { YR_ABI, yrWin32ArgBytes } from './yr/abi';
import type { ImportArgBytes } from '../vm86/pe';
import type { GameShimProfile } from '../vm86/shim/gameProfile';
import type { GameRuntimeHooks } from './runtimeHooks';
import type { GameSourceTransform } from './discovery';
import { RA2_SHIM_PROFILE } from './ra2/profile';
import { RA2_RUNTIME_HOOKS } from './ra2/runtimeHooks';
import { YR_SHIM_PROFILE } from './yr/profile';
import { YR_RUNTIME_HOOKS } from './yr/runtimeHooks';

export type SupportedGameId = 'ra2' | 'yr';

/** 静态游戏定义；不包含浏览器文件句柄或 VM 运行态。 */
export interface SupportedGame {
  id: SupportedGameId;
  title: string;
  executable: string;
  /** 传给客体的命令行参数尾部；原版开关归游戏配置，不写进通用 Win32 层。 */
  commandLineArguments?: string;
  /** 原版 INI 速度档位（0 最快）；只覆盖单机启动默认值。 */
  defaultGameSpeed?: number;
  /** 开发资源根目录下的约定子目录，也用于识别同时包含多款游戏的父目录。 */
  folder: string;
  /** 客体静态导入的 x86 ABI（stdcall `ret n` 清理字节数）。 */
  argBytes: ImportArgBytes;
  abi: Readonly<Record<string, number>>;
  driveTypes?: Readonly<Record<string, number>>;
  smokeEntry?: number;
  smokeImports?: number;
  smokeFirstCall?: string;
  menuReadyGate?: boolean;
  guestMemoryBytes?: number;
  stackTop?: number;
  heapBase?: number;
  arenaTop?: number;
  fastFileMirrorBase?: number;
  fastFileMirrorTop?: number;
  /** 持久镜像区只常驻这些高频档案；其余文件仍由同步 provider 缓存并按需读取。 */
  fastFileMirrorFiles?: readonly string[];
  /** 传给 Win32 层的显式兼容能力；共用 shim 不读取 game id。 */
  shimProfile: GameShimProfile;
  runtimeHooks?: GameRuntimeHooks;
  /** VM 创建前需要同步挂载的文件。initializeBeforeEntry 只提前执行 DLL 入口，
   * linkBeforeEntry 还会把主模块 IAT 直连到 DLL 导出。 */
  preloadFiles?: readonly {
    path: string;
    initializeBeforeEntry?: boolean;
    linkBeforeEntry?: boolean;
  }[];
  /** 超大且只需容器索引的资源包：只挂载此前缀，逻辑文件长度仍保持原值。 */
  sparseFilePrefixes?: Readonly<Record<string, number>>;
  sourceTransform?: GameSourceTransform;
  unsupportedExecutableReason?: (bytes: Uint8Array) => string | undefined;
}

// 游戏包由玩家本地导入；受校验的主程序由 manifest.ts 独立登记。
export const SUPPORTED_GAMES: readonly SupportedGame[] = [
  {
    id: 'ra2',
    title: '红色警戒 2',
    executable: 'game.exe',
    commandLineArguments: '-SPEEDCONTROL',
    defaultGameSpeed: 0,
    folder: 'ra2',
    argBytes: ra2Win32ArgBytes,
    abi: RA2_ABI,
    shimProfile: RA2_SHIM_PROFILE,
    runtimeHooks: RA2_RUNTIME_HOOKS,
    driveTypes: { C: DRIVE_FIXED, D: DRIVE_CDROM },
    stackTop: 0x00d0_0000,
    heapBase: 0x00d0_0000,
    guestMemoryBytes: 640 * 1024 * 1024,
    arenaTop: 0x1000_0000,
    fastFileMirrorBase: 0x1200_0000,
    fastFileMirrorTop: 0x27f0_0000,
    fastFileMirrorFiles: ['ra2.mix', 'language.mix', 'subtitle.txt', 'game.fnt', 'maps01.mix'],
    preloadFiles: [
      { path: 'config.txt' },
      { path: 'Blowfish.dll' },
      { path: 'BINKW32.DLL', initializeBeforeEntry: true },
    ],
    sparseFilePrefixes: { 'movies01.mix': 1024 * 1024, 'movies02.mix': 1024 * 1024 },
    smokeEntry: 0x0078_5aa0,
    smokeImports: 368,
    smokeFirstCall: 'KERNEL32.DLL!GetVersion',
  },
  {
    id: 'yr',
    title: '尤里的復仇',
    executable: 'gamemd.exe',
    commandLineArguments: '-SPEEDCONTROL',
    defaultGameSpeed: 0,
    folder: 'ra2',
    argBytes: yrWin32ArgBytes,
    abi: YR_ABI,
    shimProfile: YR_SHIM_PROFILE,
    runtimeHooks: YR_RUNTIME_HOOKS,
    driveTypes: { C: DRIVE_FIXED, D: DRIVE_CDROM },
    stackTop: 0x00d0_0000,
    heapBase: 0x00d0_0000,
    guestMemoryBytes: 640 * 1024 * 1024,
    arenaTop: 0x1000_0000,
    fastFileMirrorBase: 0x1200_0000,
    fastFileMirrorTop: 0x27f0_0000,
    fastFileMirrorFiles: ['ra2md.mix', 'langmd.mix', 'subtitlemd.txt', 'game.fnt', 'mapsmd03.mix'],
    preloadFiles: [
      { path: 'config.txt' },
      { path: 'Blowfish.dll' },
      { path: 'BINKW32.DLL', initializeBeforeEntry: true },
    ],
    sparseFilePrefixes: {
      'movies01.mix': 1024 * 1024,
      'movies02.mix': 1024 * 1024,
      'movmd03.mix': 1024 * 1024,
    },
  },
];

export const DEFAULT_GAME = SUPPORTED_GAMES[0]!;

export function isSupportedGameId(value: string): value is SupportedGameId {
  return SUPPORTED_GAMES.some((game) => game.id === value);
}

export function supportedGame(id: SupportedGameId): SupportedGame {
  const game = SUPPORTED_GAMES.find((candidate) => candidate.id === id);
  if (!game) throw new Error(`未知游戏: ${id}`);
  return game;
}
