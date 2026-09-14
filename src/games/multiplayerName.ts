import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import { gameResolutionIni } from './resolution';
import { gbkBytesOf } from './gbk';

/** 每次创建 VM 重新生成，不从共享缓存/存储复用，避免两个 tab 默认同名。
 * 前缀标识 ra2.games 玩家；总长与原版 15 字节限制一致（前缀 10 字节 + 5 位 base36）。 */
export function randomMultiplayerName(): string {
  let suffix = '';
  while (suffix.length < 5) {
    // 252 = 36 × 7，拒绝采样消除取模偏差。
    const value = crypto.getRandomValues(new Uint8Array(1))[0]!;
    if (value < 252) suffix += (value % 36).toString(36);
  }
  return `ra2.games-${suffix}`;
}

/** 原版 Handle 缓冲只有 15 字节（结尾 NUL 共 16）；长度按 GBK 编码后的字节数计。
 * 中文每字 2 字节，故上限约 7 个汉字；环境不支持 gbk 时中文名被拒绝、英文不受影响。 */
export function validateMultiplayerName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('联机用户名不能为空');
  const bytes: number[] = [];
  for (const ch of name) {
    const encoded = gbkBytesOf(ch);
    if (!encoded) throw new Error('联机用户名含不支持的字符（支持英文、数字、英文符号与中文）');
    bytes.push(...encoded);
  }
  if (bytes.length > 15) throw new Error('联机用户名过长：英文最多 15 个字符，中文最多 7 个');
  return name;
}

export function patchMultiplayerNameIni(bytes: Uint8Array, value: string): Uint8Array {
  const name = validateMultiplayerName(value);
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  // Handle 使用逗号分隔的十六进制字节（GBK 代码页）：中文按 2 字节写入，不能误写 UTF-8。
  const encoded =
    [...name]
      .map((c) => gbkBytesOf(c)!)
      .flat()
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(',') + ',';
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  let inSection = false,
    sectionFound = false,
    written = false;
  const result: string[] = [];
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      if (inSection && !written) {
        result.push(`Handle=${encoded}`);
        written = true;
      }
      inSection = /^\s*\[multiplayer\]\s*$/i.test(line);
      sectionFound ||= inSection;
    }
    if (inSection && /^\s*Handle\s*=/i.test(line)) {
      // 清理重复 Handle，避免读取旧值；其余字段和字节保持原样。
      if (!written) {
        result.push(`Handle=${encoded}`);
        written = true;
      }
    } else result.push(line);
  }
  if (!sectionFound) result.push('[MultiPlayer]');
  if (!written) result.push(`Handle=${encoded}`);
  if (result.at(-1) !== '') result.push('');
  return Uint8Array.from(result.join(newline), (c) => c.charCodeAt(0));
}

/** 分辨率覆盖之后叠加；不写磁盘，也不把本标签页名字写进共享资源缓存。 */
export async function withMultiplayerNameOverride(source: GameSource, name?: string): Promise<GameSource> {
  if (name === undefined) return source;
  const path = gameResolutionIni(source.game.id);
  const bytes = (await source.files.read(path)) ?? new Uint8Array();
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[path, patchMultiplayerNameIni(bytes, name)]]),
      '（内存联机用户名）',
      true,
    ),
  };
}
