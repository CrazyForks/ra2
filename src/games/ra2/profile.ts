import type { GameShimProfile } from '../../vm86/shim/gameProfile';

/** RA2/XWIS-specific compatibility capabilities; unlisted behavior never enters the shared shim. */
export const RA2_SHIM_PROFILE: GameShimProfile = Object.freeze({
  shell: Object.freeze({
    compositeRgb565Layers: true,
    defaultSourceColorKey: Object.freeze([0, 0] as const),
    titleControlId: 1684,
    initializeComboDropWindow: true,
    siblingScrollbarOwner: true,
    globalModifierKeys: true,
    retargetDialogChrome: true,
    mouseViaMessageQueue: true,
    // The title comes from RA2 shell resource scripts (GUI:CampaignMenu); 1109 is the mission template's save ListBox,
    // created with WS_VISIBLE then hidden after initialization; 1770-1772 are the three
    // logo buttons. These are fixed template values registered here alongside the resources.
    campaignMenu: Object.freeze({
      titleKeys: Object.freeze(['campaignmenu'] as const),
      hiddenListControlId: 1109,
      badgeControlIdRange: Object.freeze([1770, 1772] as const),
    }),
  }),
  directDraw: Object.freeze({ guestSurfaceFastPath: true }),
  directPlay: Object.freeze({
    // Disassembly at 0x447790: the enumeration callback immediately returns FALSE when flags bit0 is set. The SDK defines
    // bit0 as enumeration timeout with opposite semantics; follow actual guest behavior and always pass 0.
    enumSessionsCallbackFlags: 0x0000_0000,
    // Early rejection checks in that callback include 0x4c4358, the global session list (reject if 0),
    // and 0x4c4350, the session count (reject if >=0xa). Used only for DPLAY_VERBOSE_LOG diagnostics.
    enumSessionsProbeAddresses: Object.freeze([0x004c_4358, 0x004c_4350] as const),
  }),
  // Do not pass sparse MOVIES*.MIX indexes to the native decoder; complete files such as LANGUAGE.MIX
  // may repeatedly use native Bink. Deferred unlocking in BinkClose prevents thread switches until the preceding instance has fully exited,
  // so reopening it on return to the main menu cannot corrupt guest context.
  skipIncompleteBinkPlayback: true,
  // RA2 1.006 serializes hundreds of guest IPersistStream objects during campaign transitions. After returning from
  // guest Save, v86 recursively triggers #NP in call_interrupt_vector for a pending PIT,
  // eventually producing unreachable/Maximum call stack. Keep structured-storage interfaces but disable this
  // unsafe guest callback chain, letting the original game enter the mission from its in-memory object table.
  skipGuestOleSaveToStream: true,
  guestDllPatches: Object.freeze({
    'binkw32.dll': Object.freeze([
      // Bink 1.0p sometimes has an uninitialized first-frame time base, making the instruction at 0x10009d30
      // divide by zero. Set it to 67ms, about 15fps; subsequent frames still use full native decoding.
      Object.freeze({
        rva: 0x0000_9d2d,
        expected: Object.freeze([0x8b, 0x4d, 0x08, 0xf7, 0xf1]),
        replacement: Object.freeze([0xb8, 0x43, 0x00, 0x00, 0x00]),
      }),
    ]),
  }),
  virtualWinsockLan: true,
  launcher: Object.freeze({
    handle: 0x0001_0020,
    mutexName: '48bc11bd-c4d7-466b-8a31-c6abbad47b3e',
    eventName: 'd6e7fc97-64f9-4d28-b52c-754edf721c6f',
  }),
  cdromVolumeLabel: 'RA2',
  successfulImports: Object.freeze(['XWIS.DLL!ord1']),
  registryDefaults: Object.freeze({
    // The 1.006 marker written by the original installer; without it, game.exe periodically triggers AutoDet.
    'hkcr\\wchat\\sysid\\id': Object.freeze({
      type: 4, // REG_DWORD
      bytes: Object.freeze([0x06, 0x00, 0x01, 0x00]),
    }),
  }),
});
