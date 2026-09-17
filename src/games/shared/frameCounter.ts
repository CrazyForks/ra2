import type { GuestMemory } from '../../vm86/win32';
import type { GameFrameReader } from '../performance';

/** Read-only probe: unknown images/signature mismatches are unavailable; never interpret arbitrary memory as FPS. */
export function createFrameCounterReader(
  memory: GuestMemory,
  hash: string,
  profile: {
    hash: string;
    site: number;
    signature: readonly number[];
    frame: number;
    gameSpeed: number;
    sessionSpeed: number;
    requestedFps: number;
  },
): GameFrameReader | null {
  if (hash !== profile.hash) return null;
  try {
    const bytes = memory.read_memory(profile.site, profile.signature.length);
    if (bytes.length !== profile.signature.length || !bytes.every((byte, i) => byte === profile.signature[i]))
      return null;
  } catch {
    return null;
  }
  return () => {
    try {
      const read = (address: number) => {
        const bytes = memory.read_memory(address, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      };
      return {
        frame: read(profile.frame),
        gameSpeed: read(profile.gameSpeed),
        sessionSpeed: read(profile.sessionSpeed),
        requestedFps: read(profile.requestedFps),
      };
    } catch {
      return null;
    }
  };
}
