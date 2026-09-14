// 扫描 PE32 中对指定 VA 的写指令（mov/inc/dec/add/or/and/xor [addr], ...），
// 输出文件偏移 → VA 映射，供 ndisasm 窗口反汇编。
import { readFileSync } from 'node:fs';

const exePath = process.argv[2];
const targets = process.argv.slice(3).map((s) => parseInt(s, 16));
const buf = readFileSync(exePath);

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sectOff = peOff + 24 + optSize;
const sections: Array<{ name: string; vaddr: number; vsize: number; rawOff: number; rawSize: number }> = [];
for (let i = 0; i < numSections; i++) {
  const o = sectOff + i * 40;
  const name = buf.toString('ascii', o, o + 8).replace(/\0.*$/, '');
  const vsize = buf.readUInt32LE(o + 8);
  const vaddr = buf.readUInt32LE(o + 12);
  const rawSize = buf.readUInt32LE(o + 16);
  const rawOff = buf.readUInt32LE(o + 20);
  sections.push({ name, vaddr, vsize, rawOff, rawSize });
}
console.log(`imageBase=0x${imageBase.toString(16)}`);
for (const s of sections) {
  console.log(
    `  ${s.name} va=0x${(imageBase + s.vaddr).toString(16)} raw=0x${s.rawOff.toString(16)} size=0x${s.rawSize.toString(16)}`,
  );
}

function offToVa(off: number) {
  for (const s of sections) {
    if (off >= s.rawOff && off < s.rawOff + s.rawSize) return imageBase + s.vaddr + (off - s.rawOff);
  }
  return null;
}

// 生成写指令模式：opcode 前缀 + ModRM(mod=00,reg=opcodeExt,rm=101 disp32)
const regNames = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const grp1Names = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const patterns = [];
for (const t of targets) {
  const le = Buffer.alloc(4);
  le.writeUInt32LE(t >>> 0);
  const hex = le.toString('hex');
  // mov dword [t], imm32
  patterns.push({
    desc: `mov dword [0x${t.toString(16)}], imm32`,
    bytes: Buffer.concat([Buffer.from([0xc7, 0x05]), le]),
  });
  // mov byte [t], imm8
  patterns.push({
    desc: `mov byte [0x${t.toString(16)}], imm8`,
    bytes: Buffer.concat([Buffer.from([0xc6, 0x05]), le]),
  });
  // mov word [t], imm16
  patterns.push({
    desc: `mov word [0x${t.toString(16)}], imm16`,
    bytes: Buffer.concat([Buffer.from([0x66, 0xc7, 0x05]), le]),
  });
  // mov [t], eax (A3)
  patterns.push({ desc: `mov [0x${t.toString(16)}], eax`, bytes: Buffer.concat([Buffer.from([0xa3]), le]) });
  // mov [t], reg (89 /r)
  for (let r = 0; r < 8; r++) {
    if (r === 4) continue; // esp 需要 SIB
    patterns.push({
      desc: `mov [0x${t.toString(16)}], ${regNames[r]}`,
      bytes: Buffer.concat([Buffer.from([0x89, 0x05 + r * 8]), le]),
    });
  }
  // mov byte [t], reg8 (88 /r)
  for (let r = 0; r < 8; r++) {
    if (r === 4) continue;
    patterns.push({
      desc: `mov byte [0x${t.toString(16)}], ${regNames[r][0]}l`,
      bytes: Buffer.concat([Buffer.from([0x88, 0x05 + r * 8]), le]),
    });
  }
  // inc/dec dword [t]
  patterns.push({ desc: `inc dword [0x${t.toString(16)}]`, bytes: Buffer.concat([Buffer.from([0xff, 0x05]), le]) });
  patterns.push({ desc: `dec dword [0x${t.toString(16)}]`, bytes: Buffer.concat([Buffer.from([0xff, 0x0d]), le]) });
  // grp1 dword [t], imm8 / imm32
  for (let g = 0; g < 8; g++) {
    patterns.push({
      desc: `${grp1Names[g]} dword [0x${t.toString(16)}], imm8`,
      bytes: Buffer.concat([Buffer.from([0x83, 0x05 + g * 8]), le]),
    });
    patterns.push({
      desc: `${grp1Names[g]} dword [0x${t.toString(16)}], imm32`,
      bytes: Buffer.concat([Buffer.from([0x81, 0x05 + g * 8]), le]),
    });
  }
  // add/or/... [t], reg (01/09/11/19/21/29/31 /r)
  const op2 = { add: 0x01, or: 0x09, adc: 0x11, sbb: 0x19, and: 0x21, sub: 0x29, xor: 0x31 };
  for (const [name, op] of Object.entries(op2)) {
    for (let r = 0; r < 8; r++) {
      if (r === 4) continue;
      patterns.push({
        desc: `${name} [0x${t.toString(16)}], ${regNames[r]}`,
        bytes: Buffer.concat([Buffer.from([op, 0x05 + r * 8]), le]),
      });
    }
  }
  // xchg [t], eax (87 05)
  patterns.push({ desc: `xchg [0x${t.toString(16)}], eax`, bytes: Buffer.concat([Buffer.from([0x87, 0x05]), le]) });
  void hex;
}

const hits = [];
for (const p of patterns) {
  let idx = 0;
  while (true) {
    idx = buf.indexOf(p.bytes, idx);
    if (idx < 0) break;
    const va = offToVa(idx);
    if (va !== null) hits.push({ va, off: idx, desc: p.desc });
    idx += 1;
  }
}
hits.sort((a, b) => a.va - b.va);
for (const h of hits) {
  console.log(`va=0x${h.va.toString(16)} off=0x${h.off.toString(16)}  ${h.desc}`);
}
console.log(`共 ${hits.length} 处写指令`);
