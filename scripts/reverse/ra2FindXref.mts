// Find direct calls/jumps to a target VA (E8 rel32 call, E9 rel32 jmp).
// Usage: tsx ra2FindXref.mts <exe> <targetVaHex> [...]
import { readFileSync } from 'node:fs';

const [, , exePath, ...addrs] = process.argv;
const buf = readFileSync(exePath);

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sectOff = peOff + 24 + optSize;
const sections: Array<{ vaddr: number; rawOff: number; rawSize: number }> = [];
for (let i = 0; i < numSections; i++) {
  const o = sectOff + i * 40;
  sections.push({
    vaddr: buf.readUInt32LE(o + 12),
    rawOff: buf.readUInt32LE(o + 20),
    rawSize: buf.readUInt32LE(o + 16),
  });
}
const offToVa = (off: number) => {
  for (const s of sections)
    if (off >= s.rawOff && off < s.rawOff + s.rawSize) return imageBase + s.vaddr + (off - s.rawOff);
  return null;
};

for (const a of addrs) {
  const target = parseInt(a, 16) >>> 0;
  const hits = [];
  for (let i = 0; i < buf.length - 5; i++) {
    const op = buf[i];
    if (op !== 0xe8 && op !== 0xe9) continue;
    const rel = buf.readInt32LE(i + 1);
    const va = offToVa(i);
    if (va === null) continue;
    if ((va + 5 + rel) >>> 0 === target) hits.push({ va, kind: op === 0xe8 ? 'call' : 'jmp ' });
  }
  hits.sort((x, y) => x.va - y.va);
  console.log(`== → 0x${target.toString(16)} 共 ${hits.length} 处 ==`);
  for (const h of hits) console.log(`  ${h.kind} va=0x${h.va.toString(16)}`);
}
