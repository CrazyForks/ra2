import { describe, expect, it } from 'vitest';
import {
  RA2_RUNTIME_HOOKS,
  repairRa2InvalidRepairRate,
  shortenRa2CpuCalibration,
  skipRa2StartupMovies,
  writeRa2GameSpeed,
} from '../../src/games/ra2/runtimeHooks';
import { createGuestMemory, readU32, writeU32, type FakeGuestMemory } from '../helpers/guestMemory';

const RULES_POINTER = 0x0083_9848;
const RULES = 0x0010_0000;
const REPAIR_RATE = RULES + 0x1348;

function writeCpuCalibration(memory: FakeGuestMemory): void {
  memory.write_memory(new Uint8Array([0x55, 0x8b, 0xec, 0x83, 0xec, 0x34, 0x53, 0x56]), 0x005a_bf70);
  memory.write_memory(new Uint8Array([0x3d, 0xe8, 0x03, 0x00, 0x00]), 0x005a_bfee);
  memory.write_memory(new Uint8Array([0x81, 0xfa, 0xe8, 0x03, 0x00, 0x00]), 0x005a_c006);
  memory.write_memory(new Uint8Array([0x83, 0xf8, 0x14]), 0x005a_c0a9);
}

function writeF64(memory: FakeGuestMemory, address: number, value: number): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  memory.write_memory(bytes, address);
}

function readF64(memory: FakeGuestMemory, address: number): number {
  const bytes = memory.read_memory(address, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
}

describe('RA2 运行态护栏', () => {
  it('identifies save reference restoration failures without misdiagnosing missing installation assets', () => {
    expect(RA2_RUNTIME_HOOKS.crashHint!(0, 0x0069_fcbd)).toContain('存档对象引用恢复失败');
    expect(RA2_RUNTIME_HOOKS.crashHint!(13, 0x0069_fcbd)).toBe('');
    expect(RA2_RUNTIME_HOOKS.crashHint!(0, 0x0069_fcbe)).toBe('');
  });
  it('RA2 启动缩短测速时长及轮数，保留函数其余字节且可重复应用', () => {
    const memory = createGuestMemory();
    writeCpuCalibration(memory);
    const original = memory.read_memory(0x005a_bf70, 0x200).slice();

    RA2_RUNTIME_HOOKS.prepareImage!(memory);

    const expected = original.slice();
    new DataView(expected.buffer).setUint32(0x5abfef - 0x5abf70, 100, true);
    new DataView(expected.buffer).setUint32(0x5ac008 - 0x5abf70, 100, true);
    expected[0x5ac0ab - 0x5abf70] = 3;
    expect(memory.read_memory(0x005a_bf70, 0x200)).toEqual(expected);
    expect(shortenRa2CpuCalibration(memory)).toBe(true);
    expect(memory.read_memory(0x005a_bf70, 0x200)).toEqual(expected);
  });

  it.each([0x005a_bf70, 0x005a_bfee, 0x005a_c006, 0x005a_c0a9])('测速签名 0x%s 不匹配时不留下部分补丁', (address) => {
    const memory = createGuestMemory();
    writeCpuCalibration(memory);
    memory.write_memory(new Uint8Array([0x90]), address);
    const original = memory.read_memory(0x005a_bf70, 0x200).slice();

    expect(shortenRa2CpuCalibration(memory)).toBe(false);
    expect(memory.read_memory(0x005a_bf70, 0x200)).toEqual(original);
  });

  it('仅在已验证签名上跳过 WESTLOGO 启动影片块', () => {
    const memory = createGuestMemory();
    const address = 0x0051_263c;
    memory.write_memory(new Uint8Array([0xe8, 0x8f, 0x6c, 0xef, 0xff]), address);

    expect(skipRa2StartupMovies(memory)).toBe(true);
    expect([...memory.read_memory(address, 5)]).toEqual([0xe9, 0xb2, 0x00, 0x00, 0x00]);
    expect(skipRa2StartupMovies(memory)).toBe(true);

    memory.write_memory(new Uint8Array([0x90, 0x90, 0x90, 0x90, 0x90]), address);
    expect(skipRa2StartupMovies(memory)).toBe(false);
    expect([...memory.read_memory(address, 5)]).toEqual([0x90, 0x90, 0x90, 0x90, 0x90]);
  });

  it('鼠标消息进入前把非法 RepairRate 恢复为官方默认值', () => {
    const memory = createGuestMemory();
    writeU32(memory, RULES_POINTER, RULES);
    writeF64(memory, REPAIR_RATE, 0);

    repairRa2InvalidRepairRate(memory, 0x0202);

    expect(readF64(memory, REPAIR_RATE)).toBe(0.016);
  });

  it('保留有效规则值，并忽略非鼠标消息', () => {
    const memory = createGuestMemory();
    writeU32(memory, RULES_POINTER, RULES);
    writeF64(memory, REPAIR_RATE, 0.025);
    repairRa2InvalidRepairRate(memory, 0x0202);
    expect(readF64(memory, REPAIR_RATE)).toBe(0.025);

    writeF64(memory, REPAIR_RATE, 0);
    repairRa2InvalidRepairRate(memory, 0x0100);
    expect(readF64(memory, REPAIR_RATE)).toBe(0);
  });

  it('按 RA2 1.006 的 Settings 单例写回 GameSpeed，不碰 YR 的字段', () => {
    const memory = createGuestMemory(160 * 1024 * 1024);
    const ra2Settings = 0x0012_0000;
    const yrSettings = 0x0014_0000;
    writeU32(memory, 0x0083_9848, ra2Settings);
    writeU32(memory, ra2Settings + 0x1108, 3);
    // Also prepare the YR singleton: RA2 writes must not reach YR through version-independent offsets.
    writeU32(memory, 0x0088_71e0, yrSettings);
    writeU32(memory, yrSettings + 0x14a0, 3);

    expect(writeRa2GameSpeed(memory, 6)).toBe(6);
    expect(readU32(memory, ra2Settings + 0x1108)).toBe(6);
    expect(readU32(memory, yrSettings + 0x14a0)).toBe(3);
    expect(writeRa2GameSpeed(memory, 7)).toBeNull();
  });
});
