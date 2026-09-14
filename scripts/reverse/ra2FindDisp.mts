// 在 PE32 原始字节中查找指定小端 32 位常量，输出所在 VA 和上下文。
// 用法：pnpm exec tsx scripts/reverse/ra2FindDisp.mts <exe> <displacementHex>

import { readFileSync } from 'node:fs';

const [exePath, displacementText] = process.argv.slice(2);
const displacement = Number.parseInt(displacementText!, 16) >>> 0;
const buffer = readFileSync(exePath!);
const peOffset = buffer.readUInt32LE(0x3c);
const sectionCount = buffer.readUInt16LE(peOffset + 6);
const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
const imageBase = buffer.readUInt32LE(peOffset + 52);
const sectionOffset = peOffset + 24 + optionalHeaderSize;
const sections = Array.from({ length: sectionCount }, (_, index) => {
  const offset = sectionOffset + index * 40;
  return {
    virtualAddress: buffer.readUInt32LE(offset + 12),
    rawSize: buffer.readUInt32LE(offset + 16),
    rawOffset: buffer.readUInt32LE(offset + 20),
  };
});
const needle = Buffer.alloc(4);
needle.writeUInt32LE(displacement);

for (let offset = buffer.indexOf(needle); offset >= 0; offset = buffer.indexOf(needle, offset + 1)) {
  const section = sections.find((entry) => offset >= entry.rawOffset && offset < entry.rawOffset + entry.rawSize);
  if (!section) continue;
  const address = imageBase + section.virtualAddress + offset - section.rawOffset;
  const start = Math.max(0, offset - 8);
  const end = Math.min(buffer.length, offset + 12);
  console.log(`va=0x${address.toString(16)} bytes=${buffer.subarray(start, end).toString('hex')}`);
}
