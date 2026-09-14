/**
 * 从原版游戏 PE32 提取图标组资源：
 *  - favicon.ico：GROUP_ICON 目录 + 各 RT_ICON 图片字节原样拼接（零重编码）
 *  - favicon-192.png / apple-touch-icon.png：最大图标解码 DIB 后最近邻放大
 *  - --games 模式另输出每款已支持游戏的选择图标 icons/<id>.png（游戏选择 UI 用）
 *
 * 用法：pnpm exec tsx scripts/assets/extractIcon.mts game/ra2/game.exe [public/]
 *       pnpm exec tsx scripts/assets/extractIcon.mts --games [public/]
 * 零依赖；PNG 由 node:zlib + 手写 chunk/CRC 生成，输出确定可复现。
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const APP_BACKGROUND: [number, number, number] = [0x09, 0x09, 0x14]; // 页面底色 #090914

interface PeSection {
  name: string;
  va: number;
  vsize: number;
  raw: number;
  rawSize: number;
}

interface IconEntry {
  width: number; // 0 表示 256
  height: number; // 0 表示 256
  colors: number;
  planes: number;
  bitCount: number;
  bytes: number;
  id: number;
}

interface ExtractedGroup {
  entries: IconEntry[];
  images: Map<number, Buffer>;
}

/** 游戏选择 UI 的图标来源（id 与 src/games/catalog.ts 的 SUPPORTED_GAMES 对应）。 */
const GAME_ICON_SOURCES = [
  { id: 'ra2', exe: 'game/ra2/game.exe' },
  { id: 'yr', exe: 'game/ra2/gamemd.exe' },
] as const;

/** 游戏选择按钮图标尺寸：原版图标最大 48×48，整数 2× 放大到 96 供 hidpi 显示（CSS 显示 48px）。 */
const GAME_ICON_SIZE = 96;

function main(): void {
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith('--'));
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const check = flags.includes('--check');
  if (flags.includes('--games')) {
    generateGameIcons(resolve(positional[0] ?? 'public'), check);
    return;
  }
  if (!positional[0]) {
    console.error('用法: pnpm exec tsx scripts/assets/extractIcon.mts <exe路径> [输出目录] [--check]');
    console.error('      pnpm exec tsx scripts/assets/extractIcon.mts --games [输出目录] [--check]');
    process.exit(1);
  }
  generateFavicons(positional[0]!, resolve(positional[1] ?? 'public'), check);
}

/** favicon 三件套：ico 目录 + 最大图标解码 DIB 后最近邻放大的两个 PNG。 */
function generateFavicons(exePath: string, outDir: string, check: boolean): void {
  const exe = readFileSync(resolve(exePath));
  const group = extractIconGroup(exe);
  if (!group || group.entries.length === 0) {
    console.error(`未在 ${exePath} 中找到图标组资源`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const ico = buildIco(group);
  emit(resolve(outDir, 'favicon.ico'), ico, check, `favicon.ico：${group.entries.length} 个图标（${ico.length} 字节）`);

  // PNG：取面积最大的图标，同面积取色深更高者。
  const best = [...group.entries].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount,
  )[0]!;
  const rgba = decodeIconImage(group.images.get(best.id)!, best);
  console.log(`favicon-192/apple-touch-icon 源：${best.width}×${best.height} @ ${best.bitCount}bpp`);
  // favicon-192 保留透明（Chrome 各 UI 背景兼容）；apple-touch-icon 必须填平（iOS 把 alpha 渲成黑色）。
  const transparent = upscale(rgba, best.width, best.height, 192, 192);
  const flattened = flattenBackground(transparent, APP_BACKGROUND);
  emit(resolve(outDir, 'favicon-192.png'), encodePng(transparent, 192, 192), check, 'favicon-192.png：192×192');
  const apple = upscale(flattened, 192, 192, 180, 180);
  emit(resolve(outDir, 'apple-touch-icon.png'), encodePng(apple, 180, 180), check, 'apple-touch-icon.png：180×180');
}

/** --games 模式：favicon 三件套 + 每款已支持游戏的选择图标 → <outDir>/icons/<id>.png。 */
function generateGameIcons(outDir: string, check: boolean): void {
  const faviconSource = resolve(GAME_ICON_SOURCES[0]!.exe);
  if (existsSync(faviconSource)) generateFavicons(faviconSource, outDir, check);
  const iconsDir = resolve(outDir, 'icons');
  mkdirSync(iconsDir, { recursive: true });
  let failed = 0;
  for (const { id, exe: exePath } of GAME_ICON_SOURCES) {
    if (!existsSync(resolve(exePath))) {
      console.warn(`${id} 图标跳过：游戏文件尚未放入 workspace`);
      continue;
    }
    try {
      const group = extractIconGroup(readFileSync(resolve(exePath)));
      if (!group || group.entries.length === 0) throw new Error('未找到图标组资源');
      const best = [...group.entries].sort(
        (a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount,
      )[0]!;
      const rgba = decodeIconImage(group.images.get(best.id)!, best);
      const scaled = upscale(rgba, best.width, best.height, GAME_ICON_SIZE, GAME_ICON_SIZE);
      emit(
        resolve(iconsDir, `${id}.png`),
        encodePng(scaled, GAME_ICON_SIZE, GAME_ICON_SIZE),
        check,
        `icons/${id}.png：${GAME_ICON_SIZE}×${GAME_ICON_SIZE}（源 ${best.width}×${best.height} @ ${best.bitCount}bpp）`,
      );
    } catch (error) {
      failed++;
      console.error(`${id} 图标提取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

/** --check 模式下与磁盘文件逐字节比对，不一致退出 1；否则仅在内容变化时写入。 */
function emit(path: string, bytes: Buffer, check: boolean, log: string): void {
  let onDisk: Buffer | null = null;
  try {
    onDisk = readFileSync(path);
  } catch {
    // 首次生成
  }
  if (check) {
    if (!onDisk || !onDisk.equals(bytes)) {
      console.error(`不一致：${path}`);
      process.exitCode = 1;
      return;
    }
  } else if (!onDisk || !onDisk.equals(bytes)) {
    writeFileSync(path, bytes);
  }
  console.log(log);
}

/** 遍历资源树；子目录/数据偏移优先按真 RVA 映射，失败则按 .rsrc 节 raw base + offset（本 exe 链接器的行为）。 */
function extractIconGroup(exe: Buffer): ExtractedGroup | null {
  const pe = exe.readUInt32LE(0x3c);
  if (exe.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('不是 PE 文件');
  const sectionCount = exe.readUInt16LE(pe + 6);
  const optSize = exe.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = exe.readUInt16LE(opt);
  const dataDir = opt + (magic === 0x20b ? 112 : 96);
  const rsrcRva = exe.readUInt32LE(dataDir + 2 * 8);
  const rsrcSize = exe.readUInt32LE(dataDir + 2 * 8 + 4);
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = opt + optSize + i * 40;
    sections.push({
      name: exe.toString('ascii', s, s + 8).replace(/\0.*/, ''),
      vsize: exe.readUInt32LE(s + 8),
      va: exe.readUInt32LE(s + 12),
      rawSize: exe.readUInt32LE(s + 16),
      raw: exe.readUInt32LE(s + 20),
    });
  }
  const rsrcSection = sections.find((s) => s.va === rsrcRva);
  if (!rsrcSection) return null;
  const rvaToOff = (rva: number): number | null => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    }
    return null;
  };
  // 怪癖兜底：本 exe 的资源树指针是相对 .rsrc 节 raw base 的文件偏移。
  const resolveTreeOffset = (value: number): number | null => {
    const direct = rvaToOff(value);
    if (direct !== null && direct >= rsrcSection.raw && direct < rsrcSection.raw + rsrcSize) return direct;
    const relative = rsrcSection.raw + value;
    if (relative < exe.length) return relative;
    return null;
  };

  interface DataEntry {
    rva: number;
    size: number;
  }
  const walk = (
    dirOff: number,
    depth: number,
    types: number[],
    names: number[],
    collect: (types: number[], names: number[], data: DataEntry) => void,
  ): void => {
    const count = exe.readUInt16LE(dirOff + 12) + exe.readUInt16LE(dirOff + 14);
    for (let i = 0; i < count; i++) {
      const entry = dirOff + 16 + i * 8;
      const name = exe.readUInt32LE(entry);
      const offset = exe.readUInt32LE(entry + 4);
      if (offset & 0x8000_0000) {
        const child = resolveTreeOffset(offset & 0x7fff_ffff);
        if (child === null) continue;
        walk(child, depth + 1, [...types, name & 0xffff], [...names], collect);
      } else {
        const dataOff = resolveTreeOffset(offset);
        if (dataOff === null) continue;
        const rva = exe.readUInt32LE(dataOff);
        const size = exe.readUInt32LE(dataOff + 4);
        if (rvaToOff(rva) !== null) collect([...types, name & 0xffff], [...names], { rva, size });
      }
    }
  };

  const icons = new Map<number, DataEntry>();
  const groups: Array<{ entries: IconEntry[]; images: Map<number, Buffer> }> = [];
  const root = rvaToOff(rsrcRva);
  if (root === null) return null;
  walk(root, 0, [], [], (types, names, data) => {
    const off = rvaToOff(data.rva)!;
    if (types[0] === 3) {
      // RT_ICON：types=[3, id, lang]
      icons.set(names[0] ?? types[1], data);
    } else if (types[0] === 14 && !groups.length) {
      // RT_GROUP_ICON：types=[14, name, lang]，name 已是数字 id
      const count = exe.readUInt16LE(off + 4);
      const entries: IconEntry[] = [];
      for (let i = 0; i < count; i++) {
        const e = off + 6 + i * 14;
        entries.push({
          width: exe[e] || 256,
          height: exe[e + 1] || 256,
          colors: exe[e + 2],
          planes: exe.readUInt16LE(e + 4),
          bitCount: exe.readUInt16LE(e + 6),
          bytes: exe.readUInt32LE(e + 8),
          id: exe.readUInt16LE(e + 12),
        });
      }
      groups.push({ entries, images: new Map() });
    }
  });
  if (!groups.length) return null;
  const group = groups[0]!;
  for (const entry of group.entries) {
    const data = icons.get(entry.id);
    if (!data) continue;
    const off = rvaToOff(data.rva)!;
    const bytes = exe.subarray(off, off + data.size);
    if (bytes.length !== entry.bytes)
      throw new Error(`图标 id ${entry.id} 大小不符：${bytes.length} != ${entry.bytes}`);
    group.images.set(entry.id, Buffer.from(bytes));
  }
  return group.entries.length && group.images.size ? group : null;
}

/** ICO 头 + 目录项 + 图片字节原样拼接（RT_ICON 资源本身即完整 ICO 图片条目）。 */
function buildIco(group: ExtractedGroup): Buffer {
  const entries = group.entries.filter((e) => group.images.has(e.id));
  // ICONDIRENTRY 16 字节 = GRPICONDIRENTRY 14 字节 + dwImageOffset(4)。
  const header = 6 + entries.length * 16;
  const parts: Buffer[] = [Buffer.alloc(header)];
  parts[0].writeUInt16LE(0, 0);
  parts[0].writeUInt16LE(1, 2);
  parts[0].writeUInt16LE(entries.length, 4);
  let offset = header;
  entries.forEach((e, i) => {
    const entry = 6 + i * 16;
    parts[0][entry] = e.width & 0xff;
    parts[0][entry + 1] = e.height & 0xff;
    parts[0][entry + 2] = e.colors & 0xff;
    parts[0][entry + 4] = e.planes & 0xff;
    parts[0][entry + 5] = (e.planes >>> 8) & 0xff;
    parts[0].writeUInt16LE(e.bitCount, entry + 6);
    parts[0].writeUInt32LE(e.bytes, entry + 8);
    parts[0].writeUInt32LE(offset, entry + 12);
    offset += e.bytes;
    parts.push(group.images.get(e.id)!);
  });
  return Buffer.concat(parts);
}

/** 解码单个图标图片（BITMAPINFOHEADER + 调色板 + XOR + AND 掩码）为 RGBA。 */
function decodeIconImage(bytes: Buffer, entry: IconEntry): Uint8Array {
  const { width, height } = entry;
  const bpp = entry.bitCount;
  if (bytes.readUInt32LE(0) < 40) throw new Error('不支持的 DIB 头');
  const clrUsed = bytes.readUInt32LE(32);
  const paletteEntries = bpp <= 8 ? clrUsed || 1 << bpp : 0;
  const xorStride = Math.ceil((width * bpp) / 32) * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const palette: number[][] = [];
  for (let i = 0; i < paletteEntries; i++) {
    const p = 40 + i * 4;
    palette.push([bytes[p + 2], bytes[p + 1], bytes[p]]); // BGRA → RGB
  }
  const xorStart = 40 + paletteEntries * 4;
  const andStart = xorStart + xorStride * height;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    // DIB 自底向上：第 y 个输出行对应位图数据第 (height-1-y) 行。
    const srcY = height - 1 - y;
    const xorRow = xorStart + srcY * xorStride;
    const andRow = andStart + srcY * andStride;
    for (let x = 0; x < width; x++) {
      let index: number;
      if (bpp === 8) {
        index = bytes[xorRow + x];
      } else if (bpp === 4) {
        const byte = bytes[xorRow + (x >>> 1)];
        index = (x & 1) === 0 ? (byte >>> 4) & 0xf : byte & 0xf;
      } else if (bpp === 24) {
        const p = xorRow + x * 3;
        palette.push([bytes[p + 2], bytes[p + 1], bytes[p]]);
        index = palette.length - 1;
      } else if (bpp === 32) {
        const p = xorRow + x * 4;
        palette.push([bytes[p + 2], bytes[p + 1], bytes[p]]);
        index = palette.length - 1;
      } else {
        throw new Error(`不支持的图标位深：${bpp}bpp`);
      }
      const mask = bytes[andRow + (x >>> 3)] & (0x80 >>> (x & 7));
      const [r, g, b] = palette[index] ?? [0, 0, 0];
      const out = (y * width + x) * 4;
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = mask ? 0 : 255;
    }
  }
  return rgba;
}

/** 最近邻放大，逐像素拷贝 RGBA（保留 alpha，填平交给 flattenBackground）。 */
function upscale(rgba: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const s = (srcY * srcW + srcX) * 4;
      const d = (y * dstW + x) * 4;
      out[d] = rgba[s]!;
      out[d + 1] = rgba[s + 1]!;
      out[d + 2] = rgba[s + 2]!;
      out[d + 3] = rgba[s + 3]!;
    }
  }
  return out;
}

/** 透明像素填背景色，alpha 归 255（apple-touch-icon 用）。 */
function flattenBackground(rgba: Buffer, background: readonly number[]): Buffer {
  const out = Buffer.from(rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) {
      out[i] = background[0]!;
      out[i + 1] = background[1]!;
      out[i + 2] = background[2]!;
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---- 极简 PNG 编码器（RGBA8，filter 0，单 IDAT）----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  chunk.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return chunk;
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

main();
