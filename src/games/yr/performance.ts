import type { GuestMemory } from '../../vm86/win32';
import { createFrameCounterReader } from '../shared/frameCounter';
import { YR_STARTUP_PAGE_HASH } from './startupPage';

/** YR 1.001：0x55de73 读取帧计数，0x55de7e INC EDX，0x55de81 写回。 */
export function createYrFrameReader(memory: GuestMemory, hash: string) {
  return createFrameCounterReader(memory, hash, {
    hash: YR_STARTUP_PAGE_HASH,
    site: 0x55de73,
    signature: [
      0x8b, 0x15, 0x84, 0xed, 0xa8, 0, 0xa1, 0x84, 0x77, 0xb0, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x84, 0xed, 0xa8, 0,
    ],
    frame: 0xa8ed84,
    gameSpeed: 0xa8eb60,
    sessionSpeed: 0xa8b268,
    requestedFps: 0xa8b558,
  });
}
