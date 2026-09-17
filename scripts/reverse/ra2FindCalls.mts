// Find call/jmp [addr] sites targeting IAT entries.
// Usage: tsx ra2FindCalls.mts <exe> <iatVaHex> [...]
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
  const t = parseInt(a, 16);
  const le = Buffer.alloc(4);
  le.writeUInt32LE(t >>> 0);
  const pats = [
    { kind: 'call', bytes: Buffer.concat([Buffer.from([0xff, 0x15]), le]) },
    { kind: 'jmp ', bytes: Buffer.concat([Buffer.from([0xff, 0x25]), le]) },
  ];
  const hits = [];
  for (const p of pats) {
    let idx = 0;
    while ((idx = buf.indexOf(p.bytes, idx)) >= 0) {
      const va = offToVa(idx);
      if (va !== null) hits.push({ va, kind: p.kind });
      idx++;
    }
  }
  hits.sort((x, y) => x.va - y.va);
  console.log(`== [0x${t.toString(16)}] 共 ${hits.length} 处调用 ==`);
  for (const h of hits) console.log(`  ${h.kind} va=0x${h.va.toString(16)}`);
}
