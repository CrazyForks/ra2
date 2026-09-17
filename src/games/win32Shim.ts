import { withRa2Winsock } from './ra2/winsock';
import { Win32ShimBase, type GuestMemory, type Win32ShimOptions } from '../vm86/win32';
import { installYrLanTiming } from './yr/networkTiming';

/** Application-level Win32 composition root for RA2/YR. */
export class Win32Shim extends withRa2Winsock(Win32ShimBase) {
  constructor(memory: GuestMemory, options: Win32ShimOptions = {}) {
    super(memory, options);
    if (options.ra2NetworkEnabled && options.ra2ExeHash) {
      installYrLanTiming(memory, options.ra2ExeHash, (code) => this.allocateDynamicCode(code));
    }
  }
}
