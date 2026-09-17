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

/** RA2 1.006 CPU benchmark loop at 0x5abf70; change sample duration and round count together. */
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
 * Native hardware detection busy-waits for at least three rounds of 1000 QPC ticks. With the VM's fixed 1000Hz QPC, CPU benchmarking alone takes over 3 seconds. Shorten samples to 100ms, retaining 50ms warmup per round; after the required three rounds, compute average frequency from accumulated QPC differences. v86 JIT/host scheduling jitter can repeatedly retry short samples, so also cap the count at three rounds. Change only this function's thresholds, preserving global clocks, game speed, and user-selected graphics detail.
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

/** Accept only the original seven settings 0..6; see RA2_SETTINGS_POINTER for the Settings singleton pointer and field offset. */
export function writeRa2GameSpeed(memory: GuestMemory, value: number): number | null {
  return writeGameSpeedFlag(memory, RA2_SETTINGS_POINTER, RA2_GAME_SPEED_OFFSET, value);
}

/**
 * RA2 1.006's [Intro] Play=no controls only the first-run story introduction, not the WESTLOGO branch run on every startup. After verifying instruction signatures, skip the entire startup-movie selection block to its native cleanup. Campaign briefings still request Bink normally, then complete safely through the shim's sparse-movie compatibility policy.
 */
export function skipRa2StartupMovies(memory: GuestMemory): boolean {
  return skipStartupMovieBlock(memory, STARTUP_MOVIE_BLOCK, STARTUP_MOVIE_CONTINUATION, STARTUP_MOVIE_SIGNATURE);
}

/**
 * RA2 uses RulesClass::RepairRate * 900 as an integer divisor at 0x6d6817. The official rule value is .016; captured runtime state contained 0, causing #DE on the next building-repair check. The upstream cause of that zero still needs investigation. Repair only invalid values before mouse-message entry; valid rules and other games remain unaffected.
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
    // Preserve the original flow if RulesClass is not yet created or its address is temporarily unreadable; early mouse movement must not cause errors.
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
