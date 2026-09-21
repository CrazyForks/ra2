import type { GameShimProfile } from '../../vm86/shim/gameProfile';
import { RA2_SHIM_PROFILE } from '../ra2/profile';

/**
 * Yuri's Revenge shares Westwood shell/DirectX/Winsock semantics with RA2, but gamemd.exe also notifies the outer launcher and awaits WM_BEEF containing a shared-memory verification string. The shim performs that handshake for direct browser startup. Do not inherit XWIS-specific imports or RA2 1.006 registry values.
 */
export const YR_SHIM_PROFILE: GameShimProfile = Object.freeze({
  ...RA2_SHIM_PROFILE,
  // Native persistence is required for object references to survive a cold load.
  skipGuestOleSaveToStream: false,
  launcher: Object.freeze({
    ...RA2_SHIM_PROFILE.launcher!,
    protectedData: 'UIDATA,3DDATA,MAPS',
  }),
  successfulImports: Object.freeze([]),
  registryDefaults: Object.freeze({}),
  registrySessionDefaults: Object.freeze({
    // YR 1.001 reads up to 22 bytes here at 0x5dc170 and compares this identity when joining LAN.
    // Browser VMs without installers all read empty strings, falsely reporting duplicate serials. Supply only a missing session identity;
    // do not alter EXE comparison logic, replace explicitly written guest Serial values, or use this as online activation credentials.
    "hklm\\software\\westwood\\yuri's revenge\\serial": () => ({
      type: 1,
      bytes: [...crypto.getRandomValues(new Uint8Array(22))].map((value) => 48 + (value % 10)).concat(0),
    }),
  }),
});
