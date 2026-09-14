import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import { gameResolutionIni } from './resolution';

/** 原版 0 最快、6 最慢；只设置启动默认值，不改时钟，也不覆盖联机房主的速度。 */
export function patchGameSpeedIni(bytes: Uint8Array, speed: number): Uint8Array {
  if (!Number.isInteger(speed) || speed < 0 || speed > 6) throw new Error('游戏速度必须为 0–6 的整数');
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  const result: string[] = [];
  const found = new Set<string>();
  let section = '',
    written = false;
  const finish = () => {
    if (section && !written) result.push(`GameSpeed=${speed}`);
  };
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      finish();
      const name = match[1]!.toLowerCase();
      section = name === 'options' || name === 'skirmish' ? name : '';
      written = false;
      if (section) found.add(section);
    }
    if (section && /^\s*GameSpeed\s*=/i.test(line)) {
      // 同一节的重复键一并清理，避免原生解析器读到旧默认值。
      if (!written) result.push(`GameSpeed=${speed}`);
      written = true;
    } else result.push(line);
  }
  finish();
  for (const name of ['Options', 'Skirmish']) {
    if (!found.has(name.toLowerCase())) result.push(`[${name}]`, `GameSpeed=${speed}`);
  }
  if (result.at(-1) !== '') result.push('');
  return Uint8Array.from(result.join(newline), (c) => c.charCodeAt(0));
}

/** Worker/主线程在创建客体前共用；与分辨率/名字一样仅覆盖本次启动，不修改导入包。 */
export async function withGameSpeedDefault(source: GameSource): Promise<GameSource> {
  const speed = source.game.defaultGameSpeed;
  if (speed === undefined) return source;
  const path = gameResolutionIni(source.game.id);
  const original = (await source.files.read(path)) ?? new Uint8Array();
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[path, patchGameSpeedIni(original, speed)]]),
      '（内存默认游戏速度）',
      true,
    ),
  };
}
