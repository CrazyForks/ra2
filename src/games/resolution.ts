import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import type { SupportedGameId } from './catalog';

export interface GameResolution {
  width: number;
  height: number;
}

export const GAME_RESOLUTIONS: readonly GameResolution[] = [
  { width: 800, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

export function gameResolutionValue(resolution: GameResolution): string {
  return `${resolution.width}x${resolution.height}`;
}

export function parseGameResolution(value: string | null): GameResolution | null {
  if (!value) return null;
  return GAME_RESOLUTIONS.find((resolution) => gameResolutionValue(resolution) === value) ?? null;
}

export function gameResolutionIni(gameId: SupportedGameId): string {
  return gameId === 'yr' ? 'RA2MD.INI' : 'RA2.INI';
}

const bytesToLatin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return text;
};

const latin1ToBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
};

/** 保留原 INI 的字节编码和其余设置，只在 [Video] 内覆盖分辨率相关键。 */
export function patchGameResolutionIni(bytes: Uint8Array, resolution: GameResolution): Uint8Array {
  const text = bytesToLatin1(bytes);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (!text.trim()) {
    // 原稿为空（在线包内没有 ra2.ini）：直接生成格式规范的配置。前导空行/
    // 缺失行尾换行会让游戏的 INI 解析器跳过 [Video] 段——实测退回 640×400
    // 开场并卡死（0 字节 movies01.mix 的过场路径无法退出）。
    return latin1ToBytes(
      `[Video]${newline}AllowHiResModes=yes${newline}` +
        `ScreenWidth=${resolution.width}${newline}ScreenHeight=${resolution.height}${newline}`,
    );
  }
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text.split(/\r\n|\n|\r/);
  if (trailingNewline) lines.pop();

  let videoStart = lines.findIndex((line) => /^\s*\[video\]\s*$/i.test(line));
  if (videoStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('');
    videoStart = lines.length;
    lines.push('[Video]');
  }
  let videoEnd = lines.findIndex((line, index) => index > videoStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (videoEnd < 0) videoEnd = lines.length;

  const values: Readonly<Record<string, string>> = {
    allowhiresmodes: 'yes',
    screenwidth: String(resolution.width),
    screenheight: String(resolution.height),
  };
  for (const [normalizedKey, value] of Object.entries(values)) {
    const lineIndex = lines.findIndex((line, index) => {
      if (index <= videoStart || index >= videoEnd) return false;
      const match = line.match(/^\s*([^=;#]+?)\s*=/);
      return match?.[1]?.trim().toLowerCase() === normalizedKey;
    });
    const canonicalKey =
      normalizedKey === 'allowhiresmodes'
        ? 'AllowHiResModes'
        : normalizedKey === 'screenwidth'
          ? 'ScreenWidth'
          : 'ScreenHeight';
    if (lineIndex >= 0) lines[lineIndex] = `${canonicalKey}=${value}`;
    else {
      lines.splice(videoEnd, 0, `${canonicalKey}=${value}`);
      videoEnd++;
    }
  }
  return latin1ToBytes(lines.join(newline) + (trailingNewline ? newline : ''));
}

/** 在线包内没有 INI 时的默认菜单分辨率（RA2 标准菜单档）。 */
const FALLBACK_RESOLUTION: GameResolution = { width: 800, height: 600 };

/** 从 provider 读取游戏实际使用的 INI，再用只读内存层覆盖；读不到时提供可打开的空配置。 */
export async function withGameResolutionOverride(
  source: GameSource,
  resolution: GameResolution | null | undefined,
): Promise<GameSource> {
  const iniPath = gameResolutionIni(source.game.id);
  const original = await source.files.read(iniPath);
  // 目录里已有 INI 且未请求修改：原样使用（玩家自己的配置，含其分辨率）。
  if (!resolution && original !== null) return source;
  // 在线包没有 INI：无分辨率请求时也要提供格式规范的默认配置——游戏读到
  // 缺失/空/前导空行的 INI 会退回 640×400 开场并卡死（实测）。
  const applied = resolution ?? FALLBACK_RESOLUTION;
  const patched = patchGameResolutionIni(original ?? new Uint8Array(), applied);
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[iniPath, patched]]),
      resolution ? `（内存分辨率 ${applied.width}×${applied.height}）` : '（内存默认配置）',
      true,
    ),
  };
}
