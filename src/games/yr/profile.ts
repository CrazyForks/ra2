import type { GameShimProfile } from '../../vm86/shim/gameProfile';
import { RA2_SHIM_PROFILE } from '../ra2/profile';

/**
 * 尤里的复仇与 RA2 共用 Westwood shell/DirectX/Winsock 语义，但 gamemd.exe
 * 还会通知外层 launcher，并等待 WM_BEEF 携带共享内存校验串。浏览器直启时
 * 由 shim 代替 launcher 完成该握手。XWIS 专属导入和 RA2 1.006 注册表值不继承。
 */
export const YR_SHIM_PROFILE: GameShimProfile = Object.freeze({
  ...RA2_SHIM_PROFILE,
  launcher: Object.freeze({
    ...RA2_SHIM_PROFILE.launcher!,
    protectedData: 'UIDATA,3DDATA,MAPS',
  }),
  successfulImports: Object.freeze([]),
  registryDefaults: Object.freeze({}),
  registrySessionDefaults: Object.freeze({
    // YR 1.001 的 0x5dc170 从此处读取最多 22 字节，加入 LAN 时比较该身份。
    // 无安装器的浏览器 VM 都读到空串，会误报序号重复。仅补缺省会话身份，
    // 不修改 EXE 的比较逻辑，也不替换客体显式写入的 Serial 或作为在线激活凭证。
    "hklm\\software\\westwood\\yuri's revenge\\serial": () => ({
      type: 1,
      bytes: [...crypto.getRandomValues(new Uint8Array(22))].map((value) => 48 + (value % 10)).concat(0),
    }),
  }),
});
