import type { GameShimProfile } from '../../vm86/shim/gameProfile';

/** RA2/XWIS 专属兼容能力；未列出的行为不会进入共用 shim。 */
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
    // 标题来自 RA2 的 shell 资源脚本（GUI:CampaignMenu）；1109 是任务模板里
    // 先带 WS_VISIBLE 创建、初始化后再隐藏的存档 ListBox，1770–1772 是三个
    // 徽标按钮。三者都是该页模板的固定值，随资源一起登记在此。
    campaignMenu: Object.freeze({
      titleKeys: Object.freeze(['campaignmenu'] as const),
      hiddenListControlId: 1109,
      badgeControlIdRange: Object.freeze([1770, 1772] as const),
    }),
  }),
  directDraw: Object.freeze({ guestSurfaceFastPath: true }),
  directPlay: Object.freeze({
    // 反汇编 0x447790：枚举回调的 flags bit0 置位时回调直接返回 FALSE。SDK 把
    // bit0 定义为“枚举超时”，语义相反，以客体实际行为为准，因此固定传 0。
    enumSessionsCallbackFlags: 0x0000_0000,
    // 同一处回调的三个早期拒绝检查：0x4c4358=会话列表全局（0=拒绝）、
    // 0x4c4350=会话计数（≥0xa=拒绝）。仅供 DPLAY_VERBOSE_LOG 现场判定。
    enumSessionsProbeAddresses: Object.freeze([0x004c_4358, 0x004c_4350] as const),
  }),
  // MOVIES*.MIX 只有稀疏索引时不能交给原生解码器；LANGUAGE.MIX 等完整
  // 文件可重复走原版 Bink。BinkClose 的延迟解锁保证前一个实例真正退出后
  // 才允许线程切换，因此返回主菜单时重新打开也不会破坏客体上下文。
  skipIncompleteBinkPlayback: true,
  // RA2 1.006 在战役转场会连续序列化数百个客体 IPersistStream。跨回
  // 客体 Save 后，v86 在待处理 PIT 进入 call_interrupt_vector 时递归 #NP，
  // 最终 unreachable/Maximum call stack。结构化存储接口仍保留，禁用这条
  // 不安全的客体回调链，让原版继续从内存中的对象表进入关卡。
  skipGuestOleSaveToStream: true,
  guestDllPatches: Object.freeze({
    'binkw32.dll': Object.freeze([
      // Bink 1.0p 首帧时基偶尔尚未初始化，原指令会在 0x10009d30
      // 以零为除数。固定为约 15fps 的 67ms，后续帧仍由原版完整解码。
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
    // 原版安装器写入的 1.006 标识；缺失时 game.exe 周期性触发 AutoDet。
    'hkcr\\wchat\\sysid\\id': Object.freeze({
      type: 4, // REG_DWORD
      bytes: Object.freeze([0x06, 0x00, 0x01, 0x00]),
    }),
  }),
});
