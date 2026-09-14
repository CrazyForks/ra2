/**
 * 游戏兼容策略只描述客体与 Win32 语义之间的差异。
 *
 * 共用 shim 不应识别游戏 id、EXE 名或资源目录；它只消费这里声明的能力。
 * 新游戏默认从 EMPTY_GAME_SHIM_PROFILE 开始，必须显式选择需要的兼容行为，
 * 避免某款游戏的固定地址、注册表补丁或快速桩意外进入其他游戏。
 */

/**
 * Campaign 页的壳层补偿：页标题识别加上该页固定的控件号。
 * 键值来自各游戏自己的资源脚本与对话框模板，通用层只按登记结果判断，
 * 不逐字比较页面标题、也不写死控件号。
 */
export interface CampaignMenuCompatibility {
  /** 页面标题转小写后包含其中任一项即视为 Campaign 页。 */
  readonly titleKeys: readonly string[];
  /** 创建时带 WS_VISIBLE、初始化后又被隐藏的存档 ListBox 控件号。 */
  readonly hiddenListControlId: number;
  /** 徽标按钮的控件号闭区间，用于 hover 分派诊断计数。 */
  readonly badgeControlIdRange: readonly [number, number];
}

export interface ShellCompatibility {
  readonly compositeRgb565Layers?: boolean;
  readonly defaultSourceColorKey?: readonly [number, number];
  readonly titleControlId?: number;
  readonly initializeComboDropWindow?: boolean;
  /** 壳页把独立滚动条与所属列表作为兄弟窗口创建，通知交给相邻列表处理。 */
  readonly siblingScrollbarOwner?: boolean;
  readonly globalModifierKeys?: boolean;
  readonly retargetDialogChrome?: boolean;
  readonly mouseViaMessageQueue?: boolean;
  /** 未登记时通用层不做任何 Campaign 页专属补偿。 */
  readonly campaignMenu?: CampaignMenuCompatibility;
}

export interface DirectDrawCompatibility {
  /**
   * 客体内缓存 DDSURFACEDESC，并为 Lock/Unlock 使用专用快速桩。
   * 该能力会扩大 COM surface 客体对象，未显式启用的游戏绝不能使用。
   */
  readonly guestSurfaceFastPath?: boolean;
}

export interface DirectPlayCompatibility {
  /**
   * EnumSessions 枚举回调收到的 dwFlags。SDK 定义 bit0 为“枚举超时”，而兼容层
   * 只回放已缓存的在线会话、不会超时，因此缺省为 0；客体对该位有别的解释时
   * 由游戏模块登记它的实际期望。
   */
  readonly enumSessionsCallbackFlags?: number;
  /**
   * 枚举诊断读取的客体绝对地址对：[会话列表全局, 会话计数]。
   * 只影响详细日志；未登记时通用层不读任何游戏的全局布局。
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
  /** Bink 源文件只有稀疏索引时不执行原生解码，以“已播放完成”的兼容句柄推进。 */
  readonly skipIncompleteBinkPlayback?: boolean;
  /** 每次 VM 会话最多启动多少个原版 Bink 实例；旧 DLL 重入不稳定的游戏可限为 1。 */
  readonly nativeBinkPlaybackLimit?: number;
  /** 该客体的 IPersistStream::Save 桥在 v86 中不安全时，将 OleSaveToStream
   * 作为成功的兼容桩。结构化存储外壳仍工作，但不执行客体对象序列化。 */
  readonly skipGuestOleSaveToStream?: boolean;
  /** 随游戏 DLL 的签名保护补丁；键为规范化 DLL 路径。签名不符时拒绝加载。 */
  readonly guestDllPatches?: Readonly<Record<string, readonly GuestDllPatch[]>>;
  /** 允许启用项目内的虚拟 Winsock LAN。默认关闭。 */
  readonly virtualWinsockLan?: boolean;
  /** 浏览器直接启动主程序时需要代替的外层 launcher 同步对象。 */
  readonly launcher?: {
    readonly handle: number;
    readonly mutexName: string;
    readonly eventName: string;
    /** launcher 通过 WM_USER 协议交给主程序的共享内存校验串。 */
    readonly protectedData?: string;
  };
  /** 光盘卷标；未登记时共用层只报告中性的 CDROM。 */
  readonly cdromVolumeLabel?: string;
  /** 只有登记在此处的游戏专属导入才可由门面短路处理。 */
  readonly successfulImports?: readonly string[];
  /** key 为小写 `registry-path\\value-name`。 */
  readonly registryDefaults?: Readonly<Record<string, RegistryDefaultValue>>;
  /** 按 VM 惰性生成并缓存的默认值；显式写入的注册表值优先，不能缓存到共享 profile。 */
  readonly registrySessionDefaults?: Readonly<Record<string, () => RegistryDefaultValue>>;
}

export const EMPTY_GAME_SHIM_PROFILE: GameShimProfile = Object.freeze({});
