import type { GameFrameReader } from './performance';
import type { GuestMemory } from '../vm86/win32';

/**
 * Game runtime extensions callable by the VM core.
 * Keep fixed addresses and game semantics in each game's directory; the adapter sees only these optional capabilities.
 */
export interface GameRuntimeHooks {
  /** Create a read-only native frame counter for explicit performance sampling; null for unsupported versions. */
  createFrameReader?(memory: GuestMemory, hash: string): GameFrameReader | null;
  /** Apply narrow version-specific compatibility patches after copying the PE image into guest memory and before executing its entry point. */
  prepareImage?(memory: GuestMemory): void;
  /** Explicit startup navigation; the game verifies the target/EXE, and the allocator exclusively owns the static-import-stub tail. */
  prepareStartupPage?(memory: GuestMemory, page: string, hash: string, reserve: (size: number) => number): void;
  writeGameSpeedFlag?(memory: GuestMemory, value: number): number | null;
  /** Repair confirmed vulnerable game state before host input enters the guest message queue. */
  beforeHostMessage?(memory: GuestMemory, message: number): void;
  crashHint?(vector: number, eip: number): string;
}
