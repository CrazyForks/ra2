import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/**
 * 把一整段启动影片选择跳到它的原生收尾：目标处是影片子系统的共同收尾代码，
 * 战役简报与局内 EVA 走别的调用点，不受影响。
 * 已打过补丁时幂等返回 true；签名不符返回 false，不盲目写入。
 * 覆盖点、收尾地址与原始指令由各游戏模块给出。
 */
export function skipStartupMovieBlock(
  memory: GuestMemory,
  block: number,
  continuation: number,
  signature: readonly number[],
): boolean {
  const current = memory.read_memory(block, signature.length);
  const patch = new Uint8Array([0xe9, ...le32(continuation - (block + 5))]);
  if (current.every((byte, index) => byte === patch[index])) return true;
  if (!current.every((byte, index) => byte === signature[index])) return false;
  memory.write_memory(patch, block);
  return true;
}
