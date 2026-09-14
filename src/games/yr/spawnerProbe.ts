import type { GuestMemory } from '../../vm86/win32';
import { le32 } from '../shared/bytes';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/**
 * 实验探针，不是 Spawner 实现，未挂到默认启动路径。
 * 定位依据：CnCNet/yrpp-spawner d65600eeb77dc9401999d90a29f950d1f63f374d
 * src/Spawner/Spawner.Hook.cpp 的 WinMain_SpawnerInit。未复制其 GPL 实现；
 * 以下跳板独立依据虚拟机内运行的 YR 指令编写，仅计数并原样继续，不初始化对局或网络。
 */
export const YR_SPAWNER_PROBE_SITE = 0x006b_d7c5;
/** 探针与页面直达安装器校验同一份 YR EXE；值来自 YR_STARTUP_PAGE_HASH。 */
export const YR_SPAWNER_PROBE_EXE_SHA256 = YR_STARTUP_PAGE_HASH;
const signature = new Uint8Array([
  0x8b,
  0x35,
  0xd0,
  0xc1,
  0x81,
  0x00, // mov esi,[0x81c1d0]：完整六字节，无相对寻址
  0xb9,
  0xfe,
  0xff,
  0xff,
  0xff,
  0xe8,
  0xdb,
  0xb8,
  0xdb,
  0xff,
  0x6a,
  0x28,
  0xe8,
  0x3b,
  0xb6,
  0x10,
  0x00,
  0x83,
]);

/** 只能在首次执行前安装；调用方须提供已校验 EXE 哈希及独占的桩区分配器。 */
export function installYrSpawnerProbe(
  memory: GuestMemory,
  executableSha256: string,
  reserve: (bytes: number) => number,
): { address: number; countAddress: number; stackAddress: number } {
  if (executableSha256 !== YR_SPAWNER_PROBE_EXE_SHA256) throw new Error('YR Spawner 探针：EXE 哈希不匹配');
  const current = memory.read_memory(YR_SPAWNER_PROBE_SITE, signature.length);
  if (current.length !== signature.length || !current.every((byte, index) => byte === signature[index])) {
    throw new Error('YR Spawner 探针：入口字节签名不匹配（或已安装）');
  }
  const address = reserve(96);
  // 仅接受本项目启动桩区；不能找一个看似为零的游戏地址当作可用 code cave。
  if (!Number.isInteger(address) || address < 0x80000 || address + 96 > 0xc0000 || address % 16) {
    throw new Error('YR Spawner 探针：分配地址不在对齐的启动桩区');
  }
  const scratch = memory.read_memory(address, 96);
  if (scratch.length !== 96 || scratch.some((byte) => byte !== 0)) throw new Error('YR Spawner 探针：桩区已占用');
  const countAddress = address + 64,
    stackAddress = address + 68;
  const code = [
    0x9c,
    0x60, // pushfd / pushad：保存原现场
    0xff,
    0x05,
    ...le32(countAddress), // inc dword [count]
    0x8b,
    0x44,
    0x24,
    0x0c, // mov eax,[esp+12]：pushad 保存的 ESP
    0x83,
    0xc0,
    0x04, // 加回 pushfd 的四字节，得到入口 ESP
    0xa3,
    ...le32(stackAddress),
    0x61,
    0x9d, // popad / popfd：探针不改变寄存器或算术标志
    ...signature.subarray(0, 6), // 重放完整原指令（不能通用复制相对 CALL/JMP）
  ];
  code.push(0xe9, ...le32(YR_SPAWNER_PROBE_SITE + 6 - (address + code.length + 5)));
  const storage = new Uint8Array(96);
  storage.set(code);
  memory.write_memory(storage, address);
  // 最后发布入口跳转；原文件和 continuation 字节保持不变。
  memory.write_memory(
    new Uint8Array([0xe9, ...le32(address - (YR_SPAWNER_PROBE_SITE + 5)), 0x90]),
    YR_SPAWNER_PROBE_SITE,
  );
  return { address, countAddress, stackAddress };
}
