import type { GuestMemory } from '../../vm86/win32';
import { readU32, writeU32 } from './guestMemoryIO';

/**
 * RA2/YR 把 Options/GameSpeed 保存在各自的 Rules/Settings 单例中，活动战场的
 * 节拍上限直接读取该字段。只接受原版七档 0..6，并且仅在单例指针及旧值都
 * 合理时写入，避免启动早期或对象已释放后误写任意客体内存。
 * 单例指针与字段偏移按版本不同，由各游戏模块传入。
 */
export function writeGameSpeedFlag(
  memory: GuestMemory,
  settingsPointerAddress: number,
  gameSpeedOffset: number,
  value: number,
): number | null {
  const speed = value | 0;
  if (speed !== value || speed < 0 || speed > 6) return null;
  try {
    const settings = readU32(memory, settingsPointerAddress);
    if (settings < 0x0010_0000 || settings >= 0x1000_0000) return null;
    const address = settings + gameSpeedOffset;
    const previous = readU32(memory, address);
    if (previous > 6) return null;
    writeU32(memory, address, speed);
    return readU32(memory, address) === speed ? speed : null;
  } catch {
    return null;
  }
}
