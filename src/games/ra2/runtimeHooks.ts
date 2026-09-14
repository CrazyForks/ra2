import type { GuestMemory } from '../../vm86/win32';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { readF64, readU32, writeF64 } from '../shared/guestMemoryIO';
import { writeGameSpeedFlag } from '../shared/gameSpeedFlag';
import { skipStartupMovieBlock } from '../shared/startupMovieSkip';
import { createRa2FrameReader } from './performance';
import { patchRa2ShortGame } from './shortGame';
import { installRa2BattleStartup } from './battleStartup';
import { installRa2LanStartup, installRa2SkirmishStartup } from './startupPage';

const RULES_INSTANCE_POINTER = 0x0083_9848;
const RULES_REPAIR_RATE_OFFSET = 0x1348;
const DEFAULT_REPAIR_RATE = 0.016;
const STARTUP_MOVIE_BLOCK = 0x0051_263c;
const STARTUP_MOVIE_CONTINUATION = 0x0051_26f3;
const STARTUP_MOVIE_SIGNATURE = [0xe8, 0x8f, 0x6c, 0xef, 0xff] as const;
const RA2_SETTINGS_POINTER = 0x0083_9848;
const RA2_GAME_SPEED_OFFSET = 0x1108;

/** RA2 1.006 的 CPU 测速循环（0x5abf70），采样时长与轮数必须一起修改。 */
const CPU_CALIBRATION_ENTRY = 0x005a_bf70;
const CPU_CALIBRATION_SIGNATURE = [0x55, 0x8b, 0xec, 0x83, 0xec, 0x34, 0x53, 0x56] as const;
const CPU_CALIBRATION_CHECKS = [
  {
    address: 0x005a_bfee,
    expected: [0x3d, 0xe8, 0x03, 0x00, 0x00],
    replacement: [0x3d, 0x64, 0x00, 0x00, 0x00],
  },
  {
    address: 0x005a_c006,
    expected: [0x81, 0xfa, 0xe8, 0x03, 0x00, 0x00],
    replacement: [0x81, 0xfa, 0x64, 0x00, 0x00, 0x00],
  },
  {
    address: 0x005a_c0a9,
    expected: [0x83, 0xf8, 0x14],
    replacement: [0x83, 0xf8, 0x03],
  },
] as const;

/**
 * 原版硬件自动检测至少忙等三轮，每轮采样 1000 个 QPC tick；VM 的 QPC
 * 频率固定为 1000Hz，因此仅 CPU 测速就占 3 秒以上。缩短为 100ms 采样，
 * 每轮仍预热 50ms，完成原版最低要求的三轮后按累计 QPC 差值计算平均频率。
 * v86 的 JIT/宿主调度抖动会使短采样反复触发重试，因此同时把上限收敛到三轮。
 * 只改该检测函数的阈值，不改变全局时钟、游戏速度或用户选择的画面细节。
 */
export function shortenRa2CpuCalibration(memory: GuestMemory): boolean {
  const matches = (bytes: Uint8Array, expected: readonly number[]): boolean =>
    bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
  if (!matches(memory.read_memory(CPU_CALIBRATION_ENTRY, CPU_CALIBRATION_SIGNATURE.length), CPU_CALIBRATION_SIGNATURE))
    return false;
  const current = CPU_CALIBRATION_CHECKS.map((check) => memory.read_memory(check.address, check.expected.length));
  if (
    !CPU_CALIBRATION_CHECKS.every(
      (check, index) => matches(current[index]!, check.expected) || matches(current[index]!, check.replacement),
    )
  )
    return false;
  for (const check of CPU_CALIBRATION_CHECKS) memory.write_memory(new Uint8Array(check.replacement), check.address);
  return true;
}

/** 只接受原版七档 0..6；Settings 单例指针与字段偏移见 RA2_SETTINGS_POINTER。 */
export function writeRa2GameSpeed(memory: GuestMemory, value: number): number | null {
  return writeGameSpeedFlag(memory, RA2_SETTINGS_POINTER, RA2_GAME_SPEED_OFFSET, value);
}

/**
 * RA2 1.006 的 `[Intro] Play=no` 只控制首次运行的剧情介绍，不会跳过每次
 * 启动都会走的 WESTLOGO 分支。这里在已验证的指令签名上把整段启动影片选择
 * 跳到其原生收尾；后续战役简报仍按正常流程发起 Bink 请求，再由 shim 的
 * 稀疏影片兼容策略安全完成。
 */
export function skipRa2StartupMovies(memory: GuestMemory): boolean {
  return skipStartupMovieBlock(memory, STARTUP_MOVIE_BLOCK, STARTUP_MOVIE_CONTINUATION, STARTUP_MOVIE_SIGNATURE);
}

/**
 * RA2 的 `0x6d6817` 用 `RulesClass::RepairRate * 900` 作为整数除数。
 * 官方规则值为 .016；已捕获到运行现场留下 0，下一次建筑修理判定便触发 #DE，
 * 但该字段变零的更上游来源仍需继续观察。
 * 只在鼠标消息进入前修复非法值，正常规则和其他游戏均不受影响。
 */
export function repairRa2InvalidRepairRate(memory: GuestMemory, message: number): void {
  if (message < 0x0200 || message > 0x020e) return;
  try {
    const rules = readU32(memory, RULES_INSTANCE_POINTER);
    if (!rules) return;
    const address = rules + RULES_REPAIR_RATE_OFFSET;
    const repairRate = readF64(memory, address);
    if (Number.isFinite(repairRate) && repairRate > 0) return;
    writeF64(memory, address, DEFAULT_REPAIR_RATE);
  } catch {
    // RulesClass 尚未建立或地址暂不可读时保持原流程；启动早期鼠标移动不应成为错误。
  }
}

export const RA2_RUNTIME_HOOKS: GameRuntimeHooks = Object.freeze({
  createFrameReader: createRa2FrameReader,
  prepareStartupPage(memory: GuestMemory, page: string, hash: string, reserve: (size: number) => number): void {
    if (page === 'battle') {
      installRa2BattleStartup(memory, reserve, hash);
      return;
    }
    if (page === 'lan') {
      installRa2LanStartup(memory, reserve, hash);
      return;
    }
    if (page !== 'skirmish') throw new Error(`RA2 尚不支持直达页面：${page}`);
    installRa2SkirmishStartup(memory, reserve, hash);
  },
  prepareImage(memory: GuestMemory): void {
    skipRa2StartupMovies(memory);
    shortenRa2CpuCalibration(memory);
    patchRa2ShortGame(memory);
  },
  beforeHostMessage: repairRa2InvalidRepairRate,
  writeGameSpeedFlag: writeRa2GameSpeed,
  crashHint(vector: number, eip: number): string {
    if (vector !== 0 || eip !== 0x006d_6817) return '';
    return '；已知签名：RA2 RulesClass::RepairRate 为 0，建筑修理节拍在 0x6d6817 除零';
  },
});
