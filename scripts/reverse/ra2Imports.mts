// 解析 PE32 导入表，把 IAT VA 映射为 DLL!函数名。
// 用法：tsx ra2Imports.mts <exe> [vaHex1 vaHex2 ...]  — 不带地址则全量列出
import { readFileSync } from 'node:fs';

const [, , exePath, ...queryHex] = process.argv;
const buf = readFileSync(exePath);

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const magic = buf.readUInt16LE(peOff + 24);
const impDirRva = buf.readUInt32LE(peOff + 24 + (magic === 0x20b ? 112 : 96) + 8);
const sectOff = peOff + 24 + optSize;
const sections: Array<{ name: string; vaddr: number; vsize: number; rawOff: number; rawSize: number }> = [];
for (let i = 0; i < numSections; i++) {
  const o = sectOff + i * 40;
  sections.push({
    name: buf.toString('ascii', o, o + 8).replace(/\0.*$/, ''),
    vaddr: buf.readUInt32LE(o + 12),
    vsize: buf.readUInt32LE(o + 8),
    rawOff: buf.readUInt32LE(o + 20),
    rawSize: buf.readUInt32LE(o + 16),
  });
}
function rvaToOff(rva: number): number {
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return s.rawOff + (rva - s.vaddr);
  }
  throw new Error(`RVA 0x${rva.toString(16)} 不属于任何 PE 节`);
}
function cstr(off: number) {
  let end = off;
  while (buf[end] !== 0) end++;
  return buf.toString('ascii', off, end);
}

const iat = new Map<number, string>(); // iatVa -> "DLL!name"
let descOff = rvaToOff(impDirRva);
for (let d = 0; ; d++) {
  const o = descOff + d * 20;
  const iltRva = buf.readUInt32LE(o);
  const nameRva = buf.readUInt32LE(o + 12);
  const iatRva = buf.readUInt32LE(o + 16);
  if (iltRva === 0 && iatRva === 0) break;
  const dll = cstr(rvaToOff(nameRva));
  const iltOff = rvaToOff(iltRva);
  for (let i = 0; ; i++) {
    const ent = buf.readUInt32LE(iltOff + i * 4);
    if (ent === 0) break;
    let name;
    if (ent & 0x80000000) {
      name = `#${ent & 0xffff}`;
    } else {
      name = cstr(rvaToOff(ent) + 2);
    }
    iat.set(imageBase + iatRva + i * 4, `${dll}!${name}`);
  }
}

if (queryHex.length > 0) {
  for (const q of queryHex) {
    const va = parseInt(q, 16);
    console.log(`0x${va.toString(16)} -> ${iat.get(va) ?? '(未知)'}`);
  }
} else {
  const entries = [...iat.entries()].sort((a, b) => a[0] - b[0]);
  for (const [va, name] of entries) console.log(`0x${va.toString(16)} ${name}`);
  console.error(`共 ${entries.length} 个导入`);
}
