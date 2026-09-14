import type { GuestMemory } from '../../vm86/win32';
import { createFrameCounterReader } from '../shared/frameCounter';
import { RA2_STARTUP_PAGE_HASH } from './startupPage';

/** RA2 1.006：0x540676 读取帧计数，0x540681 INC EDX，0x540684 写回。 */
export function createRa2FrameReader(memory: GuestMemory, hash: string) {
  return createFrameCounterReader(memory, hash, {
    hash: RA2_STARTUP_PAGE_HASH,
    site: 0x540676,
    signature: [
      0x8b, 0x15, 0x2c, 0x0d, 0xa4, 0, 0xa1, 0x74, 0x91, 0xab, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x2c, 0x0d, 0xa4, 0,
    ],
    frame: 0xa40d2c,
    gameSpeed: 0xa40b18,
    sessionSpeed: 0xa3d2c8,
    requestedFps: 0xa3d568,
  });
}
