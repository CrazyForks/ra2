// Write a byte window from a PE32 virtual address to stdout: tsx ra2Dis.mts <exe> <vaStartHex> <lenHex> | ndisasm -b 32 -o 0x<vaStart> -
import { readFileSync } from 'node:fs';

const [, , exePath, vaHex, lenHex] = process.argv;
const vaStart = parseInt(vaHex, 16);
const len = parseInt(lenHex, 16);
const buf = readFileSync(exePath);

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sectOff = peOff + 24 + optSize;
for (let i = 0; i < numSections; i++) {
  const o = sectOff + i * 40;
  const vaddr = buf.readUInt32LE(o + 12);
  const vsize = buf.readUInt32LE(o + 8);
  const rawSize = buf.readUInt32LE(o + 16);
  const rawOff = buf.readUInt32LE(o + 20);
  const rva = vaStart - imageBase;
  if (rva >= vaddr && rva < vaddr + Math.max(vsize, rawSize)) {
    const off = rawOff + (rva - vaddr);
    process.stdout.write(buf.subarray(off, off + len));
    process.exit(0);
  }
}
console.error(`VA 0x${vaStart.toString(16)} 不在任何节内`);
process.exit(1);
