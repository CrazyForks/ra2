/**
 * Extract icon-group resources from the original game's PE32:
 * - favicon.ico: concatenate the GROUP_ICON directory and original RT_ICON image bytes without re-encoding.
 * - favicon-192.png / apple-touch-icon.png: decode the largest icon's DIB and upscale with nearest-neighbor sampling.
 * - --games also emits icons/<id>.png for each supported game's selection UI.
 *
 * Usage: pnpm exec tsx scripts/assets/extractIcon.mts game/ra2/game.exe [public/]
 *        pnpm exec tsx scripts/assets/extractIcon.mts --games [public/]
 * No dependencies; PNG uses node:zlib and handwritten chunks/CRC for deterministic, reproducible output.
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const APP_BACKGROUND: [number, number, number] = [0x09, 0x09, 0x14]; // Page background #090914.

interface PeSection {
  name: string;
  va: number;
  vsize: number;
  raw: number;
  rawSize: number;
}

interface IconEntry {
  width: number; // 0 means 256.
  height: number; // 0 means 256.
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

/** Icon sources for the game selection UI; IDs match SUPPORTED_GAMES in src/games/catalog.ts. */
const GAME_ICON_SOURCES = [
  { id: 'ra2', exe: 'game/ra2/game.exe' },
  { id: 'yr', exe: 'game/ra2/gamemd.exe' },
] as const;

/** Game selection icons: original icons are at most 48x48; upscale exactly 2x to 96 for HiDPI display (48px in CSS). */
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

/** Three favicon assets: ICO directory plus two PNGs made by decoding the largest icon's DIB and upscaling with nearest-neighbor sampling. */
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

  // PNG: choose the largest icon by area, breaking ties by higher color depth.
  const best = [...group.entries].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount,
  )[0]!;
  const rgba = decodeIconImage(group.images.get(best.id)!, best);
  console.log(`favicon-192/apple-touch-icon 源：${best.width}×${best.height} @ ${best.bitCount}bpp`);
  // Keep favicon-192 transparent for Chrome UI backgrounds; flatten apple-touch-icon because iOS renders alpha as black.
  const transparent = upscale(rgba, best.width, best.height, 192, 192);
  const flattened = flattenBackground(transparent, APP_BACKGROUND);
  emit(resolve(outDir, 'favicon-192.png'), encodePng(transparent, 192, 192), check, 'favicon-192.png：192×192');
  const apple = upscale(flattened, 192, 192, 180, 180);
  emit(resolve(outDir, 'apple-touch-icon.png'), encodePng(apple, 180, 180), check, 'apple-touch-icon.png：180×180');
}

/** --games mode: the three favicon assets plus each supported game's selection icon at <outDir>/icons/<id>.png. */
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

/** In --check mode, compare disk files byte for byte and exit 1 on mismatch; otherwise write only changed content. */
function emit(path: string, bytes: Buffer, check: boolean, log: string): void {
  let onDisk: Buffer | null = null;
  try {
    onDisk = readFileSync(path);
  } catch {
    // Initial generation.
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

/** Traverse the resource tree; map child-directory/data offsets as actual RVAs first, falling back to .rsrc raw base + offset for this EXE's linker. */
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
  // Quirk fallback: this EXE's resource-tree pointers are file offsets relative to the .rsrc section's raw base.
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
      // RT_GROUP_ICON: types=[14, name, lang]; name is already a numeric ID.
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

/** Concatenate the ICO header, directory entries, and original image bytes; each RT_ICON resource is already a complete ICO image entry. */
function buildIco(group: ExtractedGroup): Buffer {
  const entries = group.entries.filter((e) => group.images.has(e.id));
  // ICONDIRENTRY is 16 bytes: GRPICONDIRENTRY (14 bytes) plus dwImageOffset (4).
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

/** Decode one icon image (BITMAPINFOHEADER + palette + XOR + AND mask) to RGBA. */
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
    // Bottom-up DIB: output row y corresponds to bitmap data row (height-1-y).
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

/** Nearest-neighbor upscaling copies RGBA pixel by pixel; preserve alpha and leave flattening to flattenBackground. */
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

/** Fill transparent pixels with the background color and set alpha to 255 for apple-touch-icon. */
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

// ---- Minimal PNG encoder (RGBA8, filter 0, one IDAT) ----

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
