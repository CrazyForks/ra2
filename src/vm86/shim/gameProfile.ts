/**
 * Game compatibility policies describe only differences between guest behavior and Win32 semantics.
 *
 * The shared shim must not identify game IDs, EXE names, or resource directories; it consumes declared capabilities only. New games start from EMPTY_GAME_SHIM_PROFILE and explicitly select compatibility behavior, preventing fixed addresses, registry patches, or fast stubs from leaking between games.
 */

/**
 * Campaign shell compensation: identify page titles and register that page's fixed control IDs. Values come from each game's resource scripts/dialog templates; the generic layer consumes registrations without literal title comparisons or hardcoded IDs.
 */
export interface CampaignMenuCompatibility {
  /** Treat a page as Campaign if its lowercase title contains any registered item. */
  readonly titleKeys: readonly string[];
  /** Save ListBox control ID created with WS_VISIBLE and hidden after initialization. */
  readonly hiddenListControlId: number;
  /** Inclusive logo-button control-ID range for hover-dispatch diagnostics. */
  readonly badgeControlIdRange: readonly [number, number];
}

export interface ShellCompatibility {
  readonly compositeRgb565Layers?: boolean;
  readonly defaultSourceColorKey?: readonly [number, number];
  readonly titleControlId?: number;
  readonly initializeComboDropWindow?: boolean;
  /** Shell pages create independent scrollbars beside their lists as sibling windows; route notifications to the adjacent list. */
  readonly siblingScrollbarOwner?: boolean;
  readonly globalModifierKeys?: boolean;
  readonly retargetDialogChrome?: boolean;
  readonly mouseViaMessageQueue?: boolean;
  /** Without registration, the generic layer applies no Campaign-specific compensation. */
  readonly campaignMenu?: CampaignMenuCompatibility;
}

export interface DirectDrawCompatibility {
  /**
   * Cache DDSURFACEDESC in guest memory and use dedicated Lock/Unlock fast stubs.
   * This enlarges guest COM surface objects and must never apply to games without explicit opt-in.
   */
  readonly guestSurfaceFastPath?: boolean;
}

export interface DirectPlayCompatibility {
  /**
   * dwFlags passed to EnumSessions callbacks. The SDK defines bit0 as enumeration timeout, but this layer replays cached online sessions without timing out, so default to 0. Game modules register actual expectations when guests interpret the bit differently.
   */
  readonly enumSessionsCallbackFlags?: number;
  /**
   * Absolute guest addresses read for enumeration diagnostics: [session-list global, session count].
   * Affects verbose logs only; without registration the generic layer reads no game-global layout.
   */
  readonly enumSessionsProbeAddresses?: readonly [number, number];
}

export interface RegistryDefaultValue {
  readonly type: number;
  readonly bytes: readonly number[];
}

export interface GuestDllPatch {
  readonly rva: number;
  readonly expected: readonly number[];
  readonly replacement: readonly number[];
}

export interface GameShimProfile {
  readonly shell?: ShellCompatibility;
  readonly directDraw?: DirectDrawCompatibility;
  readonly directPlay?: DirectPlayCompatibility;
  /** For Bink sources containing only sparse indexes, skip native decoding and advance through a playback-complete compatibility handle. */
  readonly skipIncompleteBinkPlayback?: boolean;
  /** Maximum original Bink instances per VM session; games with unstable old-DLL reentry may limit this to 1. */
  readonly nativeBinkPlaybackLimit?: number;
  /**
   * When a guest IPersistStream::Save bridge is unsafe in v86, handle OleSaveToStream as a successful compatibility stub. Structured-storage wrappers remain active, but guest object serialization does not run.
   */
  readonly skipGuestOleSaveToStream?: boolean;
  /** Signature-guarded patches for bundled game DLLs, keyed by normalized DLL path; reject loading on mismatch. */
  readonly guestDllPatches?: Readonly<Record<string, readonly GuestDllPatch[]>>;
  /** Permit this project's virtual Winsock LAN; disabled by default. */
  readonly virtualWinsockLan?: boolean;
  /** Outer-launcher synchronization objects to substitute when starting the executable directly in the browser. */
  readonly launcher?: {
    readonly handle: number;
    readonly mutexName: string;
    readonly eventName: string;
    /** Shared-memory verification string delivered by the launcher through the WM_USER protocol. */
    readonly protectedData?: string;
  };
  /** CD volume label; the shared layer reports neutral CDROM when unregistered. */
  readonly cdromVolumeLabel?: string;
  /** Only game-specific imports registered here may be short-circuited by the facade. */
  readonly successfulImports?: readonly string[];
  /** Lowercase key in registry-path\\value-name form. */
  readonly registryDefaults?: Readonly<Record<string, RegistryDefaultValue>>;
  /** Defaults generated lazily and cached per VM; explicit registry writes take precedence. Never cache them in the shared profile. */
  readonly registrySessionDefaults?: Readonly<Record<string, () => RegistryDefaultValue>>;
}

export const EMPTY_GAME_SHIM_PROFILE: GameShimProfile = Object.freeze({});
