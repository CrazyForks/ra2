import type { Win32Call, Win32Result } from '../win32';
import { HYPERCALL_CALLBACK_RESULT } from '../pe';
import type { Constructor } from './state';
import type { withDirectx } from './directx';
import { createDefaultDplayTransport } from './dplayTransport';
import type { DplayTransport } from './dplayTransport';
import type { DplayWire } from './dplayWire';

type DirectxChain = InstanceType<ReturnType<typeof withDirectx>>;

/** 客体内存的 GUID 格式化为 {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}。
 *  Data1/Data2/Data3 是小端 u32/u16/u16，Data4 按原始字节序原样输出。 */
export function formatGuid(bytes: Uint8Array): string {
  const hex = (start: number, end: number) =>
    [...bytes.subarray(start, end)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const d1 = ((bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0)
    .toString(16)
    .padStart(8, '0');
  const d2 = (bytes[4]! | (bytes[5]! << 8)).toString(16).padStart(4, '0');
  const d3 = (bytes[6]! | (bytes[7]! << 8)).toString(16).padStart(4, '0');
  return `{${d1}-${d2}-${d3}-${hex(8, 10)}-${hex(10, 16)}}`;
}

/** CLSID_DirectPlay（Wine dplay.h 行 38，与游戏探测值一致）。 */
export const CLSID_DIRECTPLAY = '{d1eb6d20-8923-11d0-9d97-00a0c90a43cb}';

/** DPSPGUID_TCPIP（Wine dplay.h 行 71）。 */
const DPSPGUID_TCPIP = '{36e95ee0-8577-11cf-960c-0080c7534e82}';

/** DPSPGUID_TCPIP 的客体内存字节序（Data1/2/3 小端）。 */
const DPSPGUID_TCPIP_BYTES = new Uint8Array([
  0xe0, 0x5e, 0xe9, 0x36, 0x77, 0x85, 0xcf, 0x11, 0x96, 0x0c, 0x00, 0x80, 0xc7, 0x53, 0x4e, 0x82,
]);

/** 常见 SP GUID → 调试名（DPSPGUID_* 全表在 dplay.h）。 */
const SP_NAMES: Record<string, string> = {
  '{36e95ee0-8577-11cf-960c-0080c7534e82}': 'tcpip',
  '{685bc400-9d2c-11cf-a9cd-00aa006886e3}': 'ipx',
  '{0f1d6860-88d9-11cf-9c4e-00a0c905425e}': 'serial',
  '{44eaa760-cb68-11cf-9c4e-00a0c905425e}': 'modem',
};

/** 同一 vtable 可应答的 DirectPlay 接口（3/3A 同布局，2/2A 是 3 的前缀）。
 *  IID_IDirectPlay4/4A 带额外方法，不在此列。 */
const DIRECTPLAY_IIDS = new Set([
  '{00000000-0000-0000-c000-000000000046}', // IID_IUnknown
  '{2b74f7c0-9154-11cf-a9cd-00aa006886e3}', // IID_IDirectPlay2
  '{9d460580-a822-11cf-960c-0080c7534e82}', // IID_IDirectPlay2A
  '{133efe40-32dc-11d0-9cfb-00a0c90a43cb}', // IID_IDirectPlay3
  '{133efe41-32dc-11d0-9cfb-00a0c90a43cb}', // IID_IDirectPlay3A
]);

/** 请求了 DP IID，但本兼容层还没有这个接口。 */
export function isDirectPlayIid(iid: string): boolean {
  return DIRECTPLAY_IIDS.has(iid);
}

/** IDirectPlayLobby 系 IID（Wine dplobby.h 行 34-49）。 */
const LOBBY_IIDS = new Set([
  '{00000000-0000-0000-c000-000000000046}', // IID_IUnknown
  '{af465c71-9588-11cf-a020-00aa006157ac}', // IID_IDirectPlayLobby
  '{26c66a70-b367-11cf-a024-00aa006157ac}', // IID_IDirectPlayLobbyA
  '{0194c220-a303-11d0-9c4f-00a0c905425e}', // IID_IDirectPlayLobby2
  '{1bb4af80-a303-11d0-9c4f-00a0c905425e}', // IID_IDirectPlayLobby2A
  '{2db72490-652c-11d1-a7a8-0000f803abfc}', // IID_IDirectPlayLobby3
  '{2db72491-652c-11d1-a7a8-0000f803abfc}', // IID_IDirectPlayLobby3A
]);

/**
 * IDirectPlayLobby3 vtable：Lobby 11 + Lobby2 的 CreateCompoundAddress + Lobby3 的
 * ConnectEx/RegisterApplication/UnregisterApplication/WaitForConnectionSettings = 19 槽。
 * Lobby 1/2 布局是它的前缀，单一 vtable 可同时服务三代接口（Wine dplobby.c dpl3A_vt）。
 */
const LOBBY3_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['Connect', 16],
  ['CreateAddress', 28],
  ['EnumAddress', 20],
  ['EnumAddressTypes', 20],
  ['EnumLocalApplications', 16],
  ['GetConnectionSettings', 16],
  ['ReceiveLobbyMessage', 24],
  ['RunApplication', 20],
  ['SendLobbyMessage', 20],
  ['SetConnectionSettings', 16],
  ['SetLobbyMessageEvent', 16],
  ['CreateCompoundAddress', 20],
  ['ConnectEx', 20],
  ['RegisterApplication', 12],
  ['UnregisterApplication', 12],
  ['WaitForConnectionSettings', 8],
];

/** DPAID_* 数据类型 GUID（Wine dplobby.h 行 205-246）。 */
const DPAID_TOTAL_SIZE = '{1318f560-912c-11d0-9daa-00a0c90a43cb}';
const DPAID_SERVICE_PROVIDER = '{07d916c0-e0af-11cf-9c4e-00a0c905425e}';
const DPAID_LOBBY_PROVIDER = '{59b95640-9667-11d0-a77d-0000f803abfc}';
const DPAID_PHONE = '{78ec89a0-e0af-11cf-9c4e-00a0c905425e}';
const DPAID_MODEM = '{f6dcc200-a2fe-11d0-9c4f-00a0c905425e}';
const DPAID_INET = '{c4a54da0-e0af-11cf-9c4e-00a0c905425e}';
const DPAID_INET_PORT = '{e4524541-8ea5-11d1-8a96-006097b01411}';
const DPAID_COM_PORT = '{f2f0ce00-e0af-11cf-9c4e-00a0c905425e}';
/** ANSI 接口收到 W 数据类型 → DPERR_INVALIDFLAGS（Wine dplobby.c）。 */
const DPAID_W_GUIDS = new Set([
  '{ba5a7a70-9dbf-11d0-9cc1-00a0c905425e}', // DPAID_PhoneW
  '{01fd92e0-a2ff-11d0-9c4f-00a0c905425e}', // DPAID_ModemW
  '{e63232a0-9dbf-11d0-9cc1-00a0c905425e}', // DPAID_INetW
]);

/** DirectPlay 线上消息由 dplayTransport 负责承载，消息语义与 COM 层保持不变。 */
/** 逐消息/逐泵传输日志开关（排查链路时置 true）。平时开会把双 tab 控制台刷爆：
 *  每条消息 2~4 行、泵每次排空 2 行、枚举每次 4 行——devtools 打开时每行都有渲染
 *  成本，高频收发下日志本身就把页面拖慢（「联机很慢」的第一嫌疑人）。 */
const DPLAY_VERBOSE_LOG = false;
const DPLAY_DISCOVERY_TTL_MS = 30_000;

/** 规范 GUID 字符串 → 客体内存 16 字节小端（Data1/2/3 翻转，Data4 原样）。 */
export function guidBytes(guid: string): Uint8Array {
  const hex = guid.replace(/[{}-]/g, '');
  const out = new Uint8Array(16);
  const d1 = parseInt(hex.slice(0, 8), 16);
  const d2 = parseInt(hex.slice(8, 12), 16);
  const d3 = parseInt(hex.slice(12, 16), 16);
  out[0] = d1 & 0xff;
  out[1] = (d1 >>> 8) & 0xff;
  out[2] = (d1 >>> 16) & 0xff;
  out[3] = d1 >>> 24;
  out[4] = d2 & 0xff;
  out[5] = d2 >>> 8;
  out[6] = d3 & 0xff;
  out[7] = d3 >>> 8;
  for (let i = 0; i < 8; i++) out[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return out;
}

/** HRESULT：DPERR_UNINITIALIZED（MAKE_HRESULT(1, 0x877, 320)）。 */
const DPERR_UNINITIALIZED = 0x8877_0140;
/** HRESULT：DPERR_BUFFERTOOSMALL（30）/ INVALIDPLAYER（150）/ NOMESSAGES（190）。 */
const DPERR_BUFFERTOOSMALL = 0x8877_001e;
const DPERR_INVALIDPLAYER = 0x8877_0096;
const DPERR_NOMESSAGES = 0x8877_00be;

/**
 * IDirectPlay3 vtable：IUnknown 3 + IDirectPlay2 段 29 + IDirectPlay3 段 15 = 47 槽。
 * 顺序与 Wine dplay.h / DirectX SDK 一致（游戏实际请求 IID_IDirectPlay3A，
 * ANSI 变体同布局）。数值是含 this 在内的 stdcall 参数字节数。
 */
export const DP3_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['AddPlayerToGroup', 12],
  ['Close', 4],
  ['CreateGroup', 24],
  ['CreatePlayer', 28],
  ['DeletePlayerFromGroup', 12],
  ['DestroyGroup', 8],
  ['DestroyPlayer', 8],
  ['EnumGroupPlayers', 24],
  ['EnumGroups', 20],
  ['EnumPlayers', 20],
  ['EnumSessions', 24],
  ['GetCaps', 12],
  ['GetGroupData', 20],
  ['GetGroupName', 16],
  ['GetMessageCount', 12],
  ['GetPlayerAddress', 16],
  ['GetPlayerCaps', 12],
  ['GetPlayerData', 20],
  ['GetPlayerName', 16],
  ['GetSessionDesc', 12],
  ['Initialize', 8],
  ['Open', 12],
  ['Receive', 24],
  ['Send', 24],
  ['SetGroupData', 20],
  ['SetGroupName', 16],
  ['SetPlayerData', 20],
  ['SetPlayerName', 16],
  ['SetSessionDesc', 12],
  ['AddGroupToGroup', 12],
  ['CreateGroupInGroup', 28],
  ['DeleteGroupFromGroup', 12],
  ['EnumConnections', 20],
  ['EnumGroupsInGroup', 24],
  ['GetGroupConnectionSettings', 20],
  ['InitializeConnection', 12],
  ['SecureOpen', 20],
  ['SendChatMessage', 20],
  ['SetGroupConnectionSettings', 16],
  ['StartSession', 12],
  ['GetGroupFlags', 12],
  ['GetGroupParent', 12],
  ['GetPlayerAccount', 20],
  ['GetPlayerFlags', 12],
];

/**
 * DirectPlay 兼容层。当前阶段只让 COM 对象「出生」：IUnknown 标准语义 +
 * 无网络时必然成立的答复（GetCaps 全零、EnumConnections 零连接、
 * EnumSessions 未初始化/无连接）；其余方法停在边界，等游戏逐个揭示。
 * DirectPlay 方法仍从这里进入，具体网络承载由 transport 抽象负责。
 */
export function withDplayx<TBase extends Constructor<DirectxChain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    /** InitializeConnection 是否已成功（成功即视为「网络栈就绪」，会话枚举返回空列表）。 */
    private dplayConnectionInitialized = false;
    /** 当前会话（Open(CREATE/JOIN) 建立）。JOIN 在房间服务落地前视为本地会话。 */
    private dplaySession: {
      nameBytes: Uint8Array;
      maxPlayers: number;
      sessionFlags: number;
      appGuid: string;
      hosting: boolean;
    } | null = null;
    private dplayPlayers = new Map<
      number,
      { name: number; event: number; data: number; dataSize: number; local: boolean; announced: boolean }
    >();
    private nextDpid = 1;
    /** SetSessionDesc 存下的会话描述拷贝（InitializeConnection(NULL) 与枚举用到）。 */
    private sessionDesc = 0;
    /** DirectPlay transport 实例（懒开；浏览器默认 WebSocket）。 */
    private dplayTransport: DplayTransport | null = null;
    /** 当前会话的实例 GUID（建房时生成，加入时取自会话描述）。 */
    private dplayInstance = '';
    /** 本地玩家 DPID（CreatePlayer 时记下，收消息时定位）。 */
    private dplayLocal = 0;
    /** 泵注入被拒诊断日志节流时间戳。 */
    protected lastInjectRejectAt = 0;
    /** 收到的消息队列（Receive 弹出；数据在 shim 堆）。 */
    protected dplayQueue: Array<{ from: number; to: number; data: number; size: number }> = [];
    /** 缓存的远端会话（EnumSessions 的数据源；announce 心跳刷新）。 */
    private dplayRemoteSessions = new Map<
      string,
      {
        nameBytes: Uint8Array;
        maxPlayers: number;
        currentPlayers: number;
        appGuid: string;
        sessionFlags: number;
        lastSeen: number;
      }
    >();
    /** 建房方上次 announce 时间（心跳 piggyback 在 dplayx 调用上）。 */
    private dplayLastAnnounce = 0;
    /** 建房方心跳定时器——等待房里游戏可能完全静默（泵线程未跑），不能只靠 hypercall 节奏。 */
    private dplayHeartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
    /** 上次观察到的枚举回调 EAX（共享页 HYPERCALL_CALLBACK_RESULT，变化即打印）。 */
    private dplayLastCallbackResult = 0;
    /** 伪造的 TCP/IP 连接（DPLCONNECTION 40 字节）与 DPNAME，首次枚举时建立、重复复用。 */
    private tcpipConnection = 0;
    private tcpipConnectionName = 0;

    private ensureTcpipConnection(): void {
      if (this.tcpipConnection) return;
      // "TCP/IP\0" 纯 ASCII，GBK 逐字节兼容。
      const shortName = this.alloc(8, true);
      this.memory.write_memory(new Uint8Array([0x54, 0x43, 0x50, 0x2f, 0x49, 0x50, 0]), shortName);
      const name = this.alloc(16, true); // DPNAME: dwSize, dwFlags, lpszShortNameA, lpszLongNameA
      this.writeU32(name, 16);
      this.writeU32(name + 4, 0);
      this.writeU32(name + 8, shortName);
      this.writeU32(name + 12, 0);
      const conn = this.alloc(40, true); // DPLCONNECTION
      this.writeU32(conn, 40); // dwSize
      this.writeU32(conn + 4, 0); // dwFlags
      this.writeU32(conn + 8, 0); // lpSessionDesc
      this.writeU32(conn + 12, 0); // lpPlayerName
      this.memory.write_memory(DPSPGUID_TCPIP_BYTES, conn + 16); // guidSP
      this.writeU32(conn + 32, 0); // lpAddress
      this.writeU32(conn + 36, 0); // dwAddressSize
      this.tcpipConnection = conn;
      this.tcpipConnectionName = name;
    }

    /**
     * 客体回调桥（WndProc 同款跳板）：每组 args 右到左压栈后 call 客体函数，
     * 多组连续调用（枚举多个玩家/会话）；返回前把 EAX 设为 returnEax 再跳回
     * 原返回地址。枚举类 API 的返回值与回调 BOOL 无关，固定回 DP_OK。
     */
    protected invokeGuestCallbacks(call: Win32Call, callback: number, argSets: number[][], returnEax = 0): void {
      if (argSets.length === 0) return;
      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { trampoline } = frame;
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55); // push ebp
      code.push(0x89, 0xe5); // mov ebp, esp
      for (const args of argSets) {
        for (let i = args.length - 1; i >= 0; i--) push(args[i]!);
        code.push(0xb8);
        emit32(callback);
        code.push(0xff, 0xd0); // call eax
        code.push(0x89, 0xec); // mov esp, ebp；兼容 stdcall/cdecl 清理差异
        code.push(0xa3);
        emit32(HYPERCALL_CALLBACK_RESULT); // mov [result], eax
      }
      code.push(0x5d); // pop ebp
      code.push(0xb8);
      emit32(returnEax); // mov eax, returnEax
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
    }

    /** 单回调便捷形式。 */
    protected invokeGuestCallback(call: Win32Call, callback: number, argsInOrder: number[], returnEax = 0): void {
      this.invokeGuestCallbacks(call, callback, [argsInOrder], returnEax);
    }

    /** NUL 结尾窄字符串原样拷贝进 shim 堆（GBK 字节逐字保留，不做编解码）。 */
    private copyNarrowString(ptr: number, max = 256): number {
      if (!ptr) return 0;
      const bytes = this.memory.read_memory(ptr, max);
      let end = bytes.indexOf(0);
      if (end < 0) end = bytes.length;
      const copy = this.alloc(end + 1, true);
      this.memory.write_memory(bytes.subarray(0, end), copy);
      this.memory.write_memory(new Uint8Array([0]), copy + end);
      return copy;
    }

    /** DPNAME（16 字节 + 两个字符串）拷贝进 shim 堆——游戏缓冲可能被复用，枚举回调必须用拷贝。 */
    private copyDpName(namePtr: number): number {
      if (!namePtr) return 0;
      if (this.readU32(namePtr) < 16) return 0;
      const name = this.alloc(16, true);
      this.writeU32(name, 16); // dwSize
      this.writeU32(name + 4, this.readU32(namePtr + 4)); // dwFlags
      this.writeU32(name + 8, this.copyNarrowString(this.readU32(namePtr + 8)));
      this.writeU32(name + 12, this.copyNarrowString(this.readU32(namePtr + 12)));
      return name;
    }

    /** 任意字节块拷贝进 shim 堆。 */
    private copyGuestBytes(ptr: number, size: number): number {
      const copy = this.alloc(size, true);
      this.memory.write_memory(this.memory.read_memory(ptr, size), copy);
      return copy;
    }

    /** 两遍调用的定长输出语义：缓冲不足回写所需尺寸 + DPERR_BUFFERTOOSMALL，否则拷贝并回写。 */
    private writeSized(srcPtr: number, size: number, outPtr: number, sizePtr: number): Win32Result {
      if (!sizePtr) return { eax: 0x8000_4003 }; // E_POINTER
      if (!outPtr || this.readU32(sizePtr) < size) {
        this.writeU32(sizePtr, size);
        return { eax: DPERR_BUFFERTOOSMALL };
      }
      if (srcPtr && size) this.memory.write_memory(this.memory.read_memory(srcPtr, size), outPtr);
      this.writeU32(sizePtr, size);
      return { eax: 0 }; // DP_OK
    }

    /** NUL 前的原始字节（GBK 不做编解码）。 */
    private rawBytesUpToNul(ptr: number, max: number): Uint8Array {
      if (!ptr) return new Uint8Array(0);
      const bytes = this.memory.read_memory(ptr, max);
      let end = bytes.indexOf(0);
      if (end < 0) end = bytes.length;
      return bytes.slice(0, end);
    }

    /** 线上字节 → shim 堆字符串（附 NUL）。 */
    protected bytesToGuest(bytes: Uint8Array): number {
      const copy = this.alloc(bytes.length + 1, true);
      this.memory.write_memory(bytes, copy);
      this.memory.write_memory(new Uint8Array([0]), copy + bytes.length);
      return copy;
    }

    /** 合成 DPMSG_CREATEPLAYERORGROUP（48B，DirectPlay3A ASCII 布局照 Wine dplay.h）
     *  进本地队列：泵体排空时游戏分派器 0x4483D0 按 [eax]-3==0 走 0x448050(dpId, shortName)
     *  把玩家加进 UI——没有这条消息游戏会一直等对手出现（加入方卡死老症状）。
     *  注意 from 必须为 0（DPID_SYSMSG）：泵体 0x448480 按 from 分路，from≠0 走
     *  应用消息处理器 0x445B10，系统消息进不去分派器，泵体会卡死在游戏消息处理里。 */
    protected pushCreatePlayerMessage(dpid: number, nameBytes: Uint8Array, currentPlayers: number): void {
      const namePtr = this.bytesToGuest(nameBytes);
      const msg = this.alloc(48, true);
      const w = (off: number, value: number): void => this.writeU32(msg + off, value);
      w(0x00, 3); // dwType = DPMSG_CREATEPLAYERORGROUP
      w(0x04, 1); // dwPlayerType = DPPLAYERTYPE_PLAYER
      w(0x08, dpid);
      w(0x0c, currentPlayers);
      w(0x10, 0); // lpData
      w(0x14, 0); // dwDataSize
      w(0x18, 16); // dpnName.dwSize
      w(0x1c, 0); // dpnName.dwFlags
      w(0x20, namePtr); // dpnName.lpszShortNameA
      w(0x24, 0); // dpnName.lpszLongNameA
      w(0x28, 0); // dpIdParent
      w(0x2c, 0); // dwFlags
      this.dplayQueue.push({ from: 0, to: 0, data: msg, size: 48 }); // from=0：系统消息（DPID_SYSMSG）
      console.log(`[dplayx] 合成 DPMSG_CREATEPLAYERORGROUP dpid=${dpid}（队列 ${this.dplayQueue.length}）`);
    }

    /** DPNAME 拷贝里的短名原始字节（pinfo 广播用）。 */
    private nameBytesAt(namePtr: number): Uint8Array {
      if (!namePtr) return new Uint8Array(0);
      return this.rawBytesUpToNul(this.readU32(namePtr + 8), 256);
    }

    /** 挂接 transport 收消息处理（announce 在无会话时也缓存，其余按实例过滤）。 */
    private handleDplayMessage(m: DplayWire): void {
      if (!m) return;
      if (DPLAY_VERBOSE_LOG && m.t !== 'announce' && m.t !== 'sclose') {
        console.log(
          `[dplayx] 收消息 ${m.t} i=${m.i.slice(0, 8)}… d=${(m as { d?: number }).d ?? '-'}` +
            ` 会话=${this.dplaySession ? (this.dplaySession.hosting ? '房主' : '加入') : '无'}` +
            ` 实例匹配=${!!this.dplaySession && m.i === this.dplayInstance}`,
        );
      }
      if (m.t === 'announce') {
        this.dplayRemoteSessions.set(m.i, {
          nameBytes: m.n,
          maxPlayers: m.m,
          currentPlayers: m.c,
          appGuid: m.g,
          sessionFlags: m.f,
          lastSeen: this.clock.now(),
        });
        if (DPLAY_VERBOSE_LOG) {
          console.log(`[dplayx] 收到建房 announce ${m.i.slice(0, 8)}…（缓存 ${this.dplayRemoteSessions.size} 个会话）`);
        }
        return;
      }
      if (m.t === 'sclose') {
        // 建房方重新开房时旧实例立即失效（不等 10s 过期）。
        if (this.dplayRemoteSessions.delete(m.i)) {
          if (DPLAY_VERBOSE_LOG) {
            console.log(`[dplayx] 会话关闭通知：移除 ${m.i.slice(0, 8)}…（剩 ${this.dplayRemoteSessions.size}）`);
          }
        }
        if (this.dplaySession && !this.dplaySession.hosting && m.i === this.dplayInstance) {
          this.dplaySession = null;
          this.dplayPlayers.clear();
          this.dplayQueue.length = 0;
          this.nextDpid = 1;
          this.dplayLocal = 0;
        }
        return;
      }
      if (!this.dplaySession || m.i !== this.dplayInstance) return;
      switch (m.t) {
        case 'join': {
          // 当前 dplayx 状态重播按双 VM/双 tab 流程设计：第一个加入者拿 DPID 2；
          // relay 虽可容纳更多成员，但既有非房主玩家不会为第三个加入者全量重播，
          // 多人 DPID 分配与状态重播仍需后续协商。
          if (!this.dplaySession.hosting) return;
          if (!this.dplayPlayers.has(2)) {
            this.dplayPlayers.set(2, { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false });
          }
          if (this.nextDpid < 3) this.nextDpid = 3;
          // 重播本地玩家的 CREATE_PLAYER 消息，加入方才能看到房主。
          for (const [dpid, p] of this.dplayPlayers) {
            if (p.local) {
              this.dplayPost({
                t: 'newplayer',
                i: this.dplayInstance,
                d: dpid,
                n: this.nameBytesAt(p.name),
                c: this.dplayPlayers.size,
              });
              console.log(`[dplayx] 房主重播 newplayer dpid=${dpid} → 加入方`);
            }
          }
          return;
        }
        case 'pinfo': {
          // 名字同步。CREATE_PLAYER 合成统一走 newplayer（含创建者自己的回声），
          // 这里不再合成——否则房主会先收到加入方 pinfo 又收到 newplayer，双份。
          let p = this.dplayPlayers.get(m.d);
          if (!p) {
            p = { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false };
            this.dplayPlayers.set(m.d, p);
          } else if (p.local) {
            return;
          }
          p.name = this.bytesToGuest(m.n);
          return;
        }
        case 'newplayer': {
          // DPMSG_CREATEPLAYERORGROUP 广播（CreatePlayer 与房主 join 重播都走这里）。
          // 真实 DirectPlay 把这条消息发给包括创建者在内的所有人——创建者自己也
          // 要等它才会把自己加进 UI（加入方卡死根源）。transport 回声与
          // 重播可能重复到达，announced 标志保证每个玩家只合成一次。
          let p = this.dplayPlayers.get(m.d);
          if (!p) {
            p = { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false };
            this.dplayPlayers.set(m.d, p);
          } else if (p.announced) {
            return;
          }
          p.name = this.bytesToGuest(m.n);
          p.announced = true;
          return;
        }
        case 'pdata': {
          let p = this.dplayPlayers.get(m.d);
          if (!p) {
            p = { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false };
            this.dplayPlayers.set(m.d, p);
          } else if (p.local) {
            return;
          }
          if (p.data) this.freeAllocation(p.data);
          p.data = this.bytesToGuest(m.a);
          p.dataSize = m.a.length;
          return;
        }
        case 'msg': {
          // DPID_ALLPLAYERS(0) 广播给本地玩家；定向消息核对接收者。
          const to = m.o === 0 ? this.dplayLocal : m.o;
          if (to !== this.dplayLocal) return;
          if (DPLAY_VERBOSE_LOG) {
            const hex = [...m.a.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`[dplayx] 队列收应用消息 from=${m.f} to=${to} 长度=${m.a.length} 头=${hex}`);
          }
          this.dplayQueue.push({ from: m.f, to, data: this.bytesToGuest(m.a), size: m.a.length });
          return;
        }
        case 'leave': {
          const p = this.dplayPlayers.get(m.d);
          if (!p || p.local) return;
          if (p.data) this.freeAllocation(p.data);
          this.dplayPlayers.delete(m.d);
          return;
        }
      }
    }

    private ensureDplayTransport(): DplayTransport {
      if (!this.dplayTransport) {
        const transportFactory = this.options.dplayTransportFactory ?? createDefaultDplayTransport;
        this.dplayTransport = transportFactory({
          onMessage: (message) => this.handleDplayMessage(message),
          onOpen: () => this.replayDplayState(),
          onError: (error) => {
            if (DPLAY_VERBOSE_LOG) console.warn('[dplayx] transport error', error);
          },
        });
      }
      return this.dplayTransport;
    }

    private dplayPost(m: DplayWire): boolean {
      return this.ensureDplayTransport().send(m);
    }

    public disposeDplayTransport(): void {
      if (this.dplayHeartbeatTimer !== null) {
        globalThis.clearInterval(this.dplayHeartbeatTimer);
        this.dplayHeartbeatTimer = null;
      }
      const transport = this.dplayTransport;
      this.dplayTransport = null;
      transport?.close();
    }

    /** 建房方心跳：借任一 dplayx 调用的节奏重发 announce（2s）。 */
    private sendDplayAnnounce(): boolean {
      if (!this.dplaySession?.hosting) return false;
      const sent = this.dplayPost({
        t: 'announce',
        i: this.dplayInstance,
        n: this.dplaySession.nameBytes,
        m: this.dplaySession.maxPlayers,
        c: this.dplayPlayers.size,
        g: this.dplaySession.appGuid,
        f: this.dplaySession.sessionFlags,
      });
      if (sent) this.dplayLastAnnounce = this.clock.now();
      return sent;
    }

    private replayLocalPlayers(includePinfo: boolean): void {
      if (!this.dplaySession) return;
      for (const [dpid, player] of this.dplayPlayers) {
        if (!player.local) continue;
        const name = this.nameBytesAt(player.name);
        if (includePinfo) this.dplayPost({ t: 'pinfo', i: this.dplayInstance, d: dpid, n: name });
        this.dplayPost({ t: 'newplayer', i: this.dplayInstance, d: dpid, n: name, c: this.dplayPlayers.size });
        if (player.data) {
          this.dplayPost({
            t: 'pdata',
            i: this.dplayInstance,
            d: dpid,
            a: this.memory.read_memory(player.data, player.dataSize),
          });
        }
      }
    }

    private replayDplayState(): void {
      if (!this.dplaySession) return;
      if (this.dplaySession.hosting) this.sendDplayAnnounce();
      else this.dplayPost({ t: 'join', i: this.dplayInstance });
      this.replayLocalPlayers(true);
    }

    private dplayPump(): void {
      if (!this.dplaySession?.hosting) return;
      const now = this.clock.now();
      if (now - this.dplayLastAnnounce >= 2000) {
        this.sendDplayAnnounce();
      }
    }

    /** CoCreateInstance / DirectPlayCreate 共用的对象工厂。 */
    protected createDirectPlay(): number {
      // 频道必须在对象创建时就打开（被动监听）：加入方浏览会话列表期间只收不发，
      // 懒开会错过建房方的全部 announce（transport 不替 VM 缓存控制状态）。
      this.ensureDplayTransport();
      this.dplayObjectsCreated++;
      return this.createComObject('IDirectPlay3', DP3_METHODS, 'DPLAYX.COM');
    }

    /** 冒烟/菜单路线发现的探针信号：DP 对象已创建（游戏进入联机界面的标志）。 */
    public dplayObjectsCreated = 0;

    /** 冒烟/调试自检：DPlay 会话与玩家表（宿主侧断言联机是否达成）。 */
    public inspectDplayState(): {
      created: number;
      initialized: boolean;
      session: { hosting: boolean; instance: string; name: string } | null;
      players: Array<{ dpid: number; local: boolean; name: string }>;
      queue: number;
    } {
      const decode = (bytes: Uint8Array) => new TextDecoder('big5').decode(bytes);
      return {
        created: this.dplayObjectsCreated,
        initialized: this.dplayConnectionInitialized,
        session: this.dplaySession
          ? {
              hosting: this.dplaySession.hosting,
              instance: this.dplayInstance,
              name: decode(this.dplaySession.nameBytes),
            }
          : null,
        players: [...this.dplayPlayers.entries()].map(([dpid, p]) => ({
          dpid,
          local: p.local,
          name: decode(this.nameBytesAt(p.name)),
        })),
        queue: this.dplayQueue.length,
      };
    }

    /** DirectPlayLobbyCreateA 的 Lobby 对象工厂（Lobby3 布局兼容 1/2 代）。 */
    protected createDirectPlayLobby(): number {
      return this.createComObject('IDirectPlayLobby3A', LOBBY3_METHODS, 'DPLAYX.COM');
    }

    /** 复合地址里单个元素序列化后的尺寸（DPADDRESS 头 40 + 数据区）；未知类型跳过。 */
    private compoundAddressElementSize(guid: string, dataSize: number): number | null {
      switch (guid) {
        case DPAID_SERVICE_PROVIDER:
        case DPAID_LOBBY_PROVIDER:
          return 40 + 16; // 数据固定是 16 字节 GUID
        case DPAID_PHONE:
        case DPAID_MODEM:
        case DPAID_INET:
          return 40 + dataSize;
        case DPAID_INET_PORT:
          return 40 + 2;
        case DPAID_COM_PORT:
          return 40 + 20;
        default:
          return null;
      }
    }

    /**
     * IDirectPlayLobby3A.CreateCompoundAddress：把元素数组序列化成 dplayx 复合地址。
     * 布局照 Wine dplobby.c——首块 DPAID_TotalSize 记录总长，其余每块
     * GUID(16)+u32 尺寸+20 字节 union 空位+数据；两遍调用语义（容量不足返回
     * DPERR_BUFFERTOOSMALL 并回写所需尺寸）。
     */
    protected createCompoundAddress(a: number[]): Win32Result {
      const elementsPtr = a[1] ?? 0;
      const count = a[2] ?? 0;
      const addressPtr = a[3] ?? 0;
      const sizePtr = a[4] ?? 0;
      if (!elementsPtr || !count) return { eax: 0x8007_0057 }; // DPERR_INVALIDPARAM
      if (!sizePtr) return { eax: 0x8000_4003 }; // E_POINTER
      // DPCOMPOUNDADDRESSELEMENT = GUID(16) + dwDataSize + lpData = 24 字节。
      const elements: Array<{ guid: string; dataSize: number; data: number }> = [];
      for (let i = 0; i < count; i++) {
        const elem = elementsPtr + i * 24;
        elements.push({
          guid: formatGuid(this.readBytes(elem, 16)),
          dataSize: this.readU32(elem + 16),
          data: this.readU32(elem + 20),
        });
      }
      let required = 44; // 首块 TotalSize：头 40 + 4 字节总长
      for (const e of elements) {
        if (DPAID_W_GUIDS.has(e.guid)) return { eax: 0x8877_0078 }; // DPERR_INVALIDFLAGS
        const size = this.compoundAddressElementSize(e.guid, e.dataSize);
        if (size !== null) required += size;
      }
      const capacity = this.readU32(sizePtr);
      if (!addressPtr || capacity < required) {
        this.writeU32(sizePtr, required);
        return { eax: 0x8877_001e }; // DPERR_BUFFERTOOSMALL
      }
      const out = new Uint8Array(required);
      let pos = 0;
      const writeChunk = (guid: string, data: Uint8Array) => {
        out.set(guidBytes(guid), pos);
        pos += 16;
        const size = data.length;
        out[pos] = size & 0xff;
        out[pos + 1] = (size >>> 8) & 0xff;
        out[pos + 2] = (size >>> 16) & 0xff;
        out[pos + 3] = size >>> 24;
        pos += 4;
        pos += 20; // union 空位：Wine 不写这 20 字节，我们清零，布局一致
        out.set(data, pos);
        pos += size;
      };
      const total = new Uint8Array(4);
      total[0] = required & 0xff;
      total[1] = (required >>> 8) & 0xff;
      total[2] = (required >>> 16) & 0xff;
      total[3] = required >>> 24;
      writeChunk(DPAID_TOTAL_SIZE, total);
      for (const e of elements) {
        const size = this.compoundAddressElementSize(e.guid, e.dataSize);
        if (size === null) continue;
        const data =
          e.guid === DPAID_SERVICE_PROVIDER || e.guid === DPAID_LOBBY_PROVIDER
            ? guidBytes(formatGuid(this.readBytes(e.data, 16)))
            : this.readBytes(e.data, size - 40);
        writeChunk(e.guid, data);
      }
      this.memory.write_memory(out, addressPtr);
      this.writeU32(sizePtr, required);
      return { eax: 0 }; // DP_OK
    }

    /** DPLAYX.COM!IDirectPlay3.* 的 vtable 方法分派。 */
    protected dispatchDPlay(call: Win32Call): Win32Result | null {
      this.dplayPump(); // 建房方心跳 piggyback 在 dplayx 调用节奏上
      const callbackResult = this.readU32(HYPERCALL_CALLBACK_RESULT);
      if (callbackResult !== this.dplayLastCallbackResult) {
        this.dplayLastCallbackResult = callbackResult;
        if (DPLAY_VERBOSE_LOG) {
          // 枚举回调刚执行过：TRUE(1)=游戏接受该项并继续，FALSE(0)=游戏拒绝/停止。
          console.log(
            `[dplayx] 枚举回调返回 EAX=0x${callbackResult.toString(16)}（${callbackResult ? 'TRUE 接受' : 'FALSE 拒绝'}）`,
          );
        }
      }
      const key = call.imported.key;
      const a = call.args;
      const method = key.slice(key.lastIndexOf('.') + 1);
      const thisPtr = a[0] ?? 0;

      if (method === 'QueryInterface') {
        const riid = a[1] ?? 0;
        const iid = riid ? formatGuid(this.readBytes(riid, 16)) : '(null)';
        // Lobby 对象与 DP 对象各自支持自己的 IID 族。
        const interfaceName = key.slice(key.indexOf('!') + 1, key.lastIndexOf('.'));
        const supported = interfaceName.includes('Lobby') ? LOBBY_IIDS : DIRECTPLAY_IIDS;
        if (!supported.has(iid)) {
          if (a[2]) this.writeU32(a[2], 0);
          return { eax: 0x8000_4002 }; // E_NOINTERFACE
        }
        if (a[2]) this.writeU32(a[2], thisPtr);
        this.addComRef(thisPtr);
        return { eax: 0 };
      }
      if (method === 'AddRef') return { eax: this.addComRef(thisPtr) };
      if (method === 'Release') return { eax: this.releaseComObject(thisPtr) };

      if (key.startsWith('DPLAYX.COM!IDirectPlayLobby')) {
        switch (method) {
          case 'CreateCompoundAddress':
            return this.createCompoundAddress(a);
          default:
            return null;
        }
      }
      if (key.startsWith('DPLAYX.COM!IDirectPlay3.')) {
        switch (method) {
          case 'Initialize':
            // SP GUID 参数暂不落库；后续方法按需再记。
            return { eax: 0 }; // DP_OK
          case 'GetCaps': {
            // DPCAPS 40 字节；无网络时除 dwSize 外全零是真实状态。
            const capsPtr = a[1] ?? 0;
            if (!capsPtr) return { eax: 0x8000_4003 }; // E_POINTER
            const requested = this.readU32(capsPtr);
            const size = Math.min(requested || 40, 40);
            this.memory.write_memory(new Uint8Array(40), capsPtr);
            this.writeU32(capsPtr, size);
            return { eax: 0 }; // DP_OK
          }
          case 'GetSessionDesc':
            // 返回 SetSessionDesc 存下的描述拷贝（80 字节，名字指针指向 shim 拷贝）。
            return this.writeSized(this.sessionDesc, this.sessionDesc ? 80 : 0, a[1] ?? 0, a[2] ?? 0);
          case 'SetSessionDesc': {
            // 建房前设置会话描述（InitializeConnection(NULL) 的「默认连接」也
            // 关联这份描述）。拷贝 80 字节 + 名字/密码字符串进 shim 堆——游戏缓冲会被复用。
            const sdesc = a[1] ?? 0;
            if (!sdesc) return { eax: 0x8000_4003 };
            if (this.readU32(sdesc) < 80) return { eax: 0x8007_0057 };
            const copy = this.alloc(80, true);
            this.memory.write_memory(this.memory.read_memory(sdesc, 80), copy);
            const namePtr = this.readU32(copy + 48);
            const passwordPtr = this.readU32(copy + 52);
            if (namePtr) this.writeU32(copy + 48, this.copyNarrowString(namePtr, 128));
            if (passwordPtr) this.writeU32(copy + 52, this.copyNarrowString(passwordPtr, 64));
            this.sessionDesc = copy;
            return { eax: 0 }; // DP_OK
          }
          case 'Open': {
            // 建房（CREATE）：生成会话实例 GUID 并广播 announce；
            // 加入（JOIN）：目标实例取自会话描述（由我们的 EnumSessions 写入），
            // 广播 join 请求；具体承载由 transport 决定。
            const sdesc = a[1] ?? 0;
            const flags = a[2] ?? 0;
            if (!sdesc) return { eax: 0x8000_4003 }; // E_POINTER
            if (this.readU32(sdesc) < 80) return { eax: 0x8007_0057 }; // DPERR_INVALIDPARAM
            if (flags !== 1 && flags !== 2) {
              // DPOPEN_JOIN=1 / DPOPEN_CREATE=2
              this.unimplementedDetail = `Open(dwFlags=0x${flags.toString(16)})`;
              return null;
            }
            const namePtr = this.readU32(sdesc + 48);
            if (flags === 2) {
              // 重新建房时让旧实例在加入方立即失效。
              if (this.dplayInstance && this.dplaySession?.hosting) {
                this.dplayPost({ t: 'sclose', i: this.dplayInstance });
              }
              // 游戏对 CREATE 传 GUID_NULL 实例——会话身份由兼容层生成。
              const instanceBytes = new Uint8Array(16);
              for (let i = 0; i < 16; i++) instanceBytes[i] = Math.floor(Math.random() * 256);
              this.dplayInstance = formatGuid(instanceBytes);
              this.dplaySession = {
                nameBytes: this.rawBytesUpToNul(namePtr, 128),
                maxPlayers: this.readU32(sdesc + 40),
                sessionFlags: this.readU32(sdesc + 4),
                appGuid: formatGuid(this.readBytes(sdesc + 24, 16)),
                hosting: true,
              };
              this.dplayLastAnnounce = 0;
              console.log(`[dplayx] Open(CREATE) 建房实例 ${this.dplayInstance.slice(0, 8)}…`);
              if (this.dplayHeartbeatTimer === null) {
                this.dplayHeartbeatTimer = globalThis.setInterval(() => this.dplayPump(), 1500);
              }
            } else {
              this.dplayInstance = formatGuid(this.readBytes(sdesc + 8, 16));
              console.log(
                `[dplayx] Open(JOIN) 目标实例 ${this.dplayInstance.slice(0, 8)}…（缓存中${this.dplayRemoteSessions.has(this.dplayInstance) ? '在' : '不在'}）`,
              );
              this.dplaySession = {
                nameBytes: this.rawBytesUpToNul(namePtr, 128),
                maxPlayers: this.readU32(sdesc + 40),
                sessionFlags: this.readU32(sdesc + 4),
                appGuid: formatGuid(this.readBytes(sdesc + 24, 16)),
                hosting: false,
              };
              // 两 tab 测试的确定性分配：房主恒为 DPID 1，加入者从 2 开始。
              this.nextDpid = 2;
            }
            this.dplayPlayers.clear();
            this.dplayQueue.length = 0;
            this.dplayLocal = 0;
            if (this.dplaySession.hosting) this.dplayPump();
            else this.dplayPost({ t: 'join', i: this.dplayInstance });
            return { eax: 0 }; // DP_OK
          }
          case 'CreatePlayer': {
            // (LPDPID, LPDPNAME, HANDLE, LPVOID, DWORD, DWORD)——本地玩家拿 DPID 1 起。
            const idPtr = a[1] ?? 0;
            if (!idPtr) return { eax: 0x8000_4003 };
            if (!this.dplaySession) return { eax: DPERR_UNINITIALIZED };
            const dpid = this.nextDpid++;
            this.writeU32(idPtr, dpid);
            const name = this.copyDpName(a[2] ?? 0);
            this.dplayPlayers.set(dpid, {
              name,
              event: a[3] ?? 0,
              data: 0,
              dataSize: 0,
              local: true,
              announced: false,
            });
            this.dplayLocal = dpid;
            // 玩家信息广播给对端（对方尚未加入时会被丢弃；加入后由 join 应答重播房主）。
            this.dplayPost({ t: 'pinfo', i: this.dplayInstance, d: dpid, n: this.nameBytesAt(name) });
            // CREATE_PLAYER 系统消息发给包括创建者在内的所有人——创建者自己也靠
            // 这条消息（经 transport 回声）把自己加进 UI，双方 UI 都等它。
            this.dplayPost({
              t: 'newplayer',
              i: this.dplayInstance,
              d: dpid,
              n: this.nameBytesAt(name),
              c: this.dplayPlayers.size,
            });
            return { eax: 0 };
          }
          case 'DestroyPlayer': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            if (player.data) this.freeAllocation(player.data);
            this.dplayPlayers.delete(a[1] ?? 0);
            return { eax: 0 };
          }
          case 'SetPlayerData': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            if (player.data) this.freeAllocation(player.data);
            const size = a[3] ?? 0;
            player.data = size && a[2] ? this.copyGuestBytes(a[2], size) : 0;
            player.dataSize = player.data ? size : 0;
            if (player.local && player.data) {
              this.dplayPost({
                t: 'pdata',
                i: this.dplayInstance,
                d: a[1] ?? 0,
                a: this.memory.read_memory(player.data, player.dataSize),
              });
            }
            return { eax: 0 };
          }
          case 'GetPlayerData': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            return this.writeSized(player.data, player.dataSize, a[2] ?? 0, a[3] ?? 0);
          }
          case 'SetPlayerName': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            player.name = this.copyDpName(a[2] ?? 0);
            if (player.local) {
              this.dplayPost({
                t: 'pinfo',
                i: this.dplayInstance,
                d: a[1] ?? 0,
                n: this.nameBytesAt(player.name),
              });
            }
            return { eax: 0 };
          }
          case 'GetPlayerName': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            return this.writeSized(player.name, player.name ? 16 : 0, a[2] ?? 0, a[3] ?? 0);
          }
          case 'GetPlayerCaps': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            const capsPtr = a[2] ?? 0;
            if (!capsPtr) return { eax: 0x8000_4003 };
            const requested = this.readU32(capsPtr);
            const size = Math.min(requested || 40, 40);
            this.memory.write_memory(new Uint8Array(40), capsPtr);
            this.writeU32(capsPtr, size);
            return { eax: 0 };
          }
          case 'GetPlayerAddress': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            return this.writeSized(0, 0, a[2] ?? 0, a[3] ?? 0);
          }
          case 'GetMessageCount': {
            const countPtr = a[2] ?? 0;
            if (!countPtr) return { eax: 0x8000_4003 };
            this.writeU32(countPtr, this.dplayQueue.length);
            return { eax: 0 };
          }
          case 'Send': {
            // Send(this, DPID from, DPID to, DWORD flags, LPVOID data, DWORD size)：
            // size 在 a[5]、数据在 a[4]（曾错读 a[4]/a[3]——把 lpData 指针值当长度、
            // 从 flags 地址读 7MB 零页，真实报文从未送达，双方互等卡死）。
            const to = a[2] ?? 0;
            if (to !== 0 && !this.dplayPlayers.has(to)) return { eax: DPERR_INVALIDPLAYER };
            const size = a[5] ?? 0;
            const data = size && a[4] ? this.memory.read_memory(a[4], size) : new Uint8Array(0);
            this.dplayPost({ t: 'msg', i: this.dplayInstance, f: a[1] ?? 0, o: to, a: data });
            return { eax: 0 }; // DP_OK
          }
          case 'Receive': {
            // 弹出 transport 队列；空队列 → DPERR_NOMESSAGES（网络泵常态）。
            this.dplayPump();
            const msg = this.dplayQueue[0];
            if (!msg) {
              if (a[1]) this.writeU32(a[1], 0); // lpidFrom
              if (a[2]) this.writeU32(a[2], 0); // lpidTo
              if (a[5]) this.writeU32(a[5], 0); // lpdwDataSize
              return { eax: DPERR_NOMESSAGES };
            }
            if (!a[5]) return { eax: 0x8000_4003 }; // E_POINTER
            const capacity = this.readU32(a[5]);
            if (capacity < msg.size) {
              this.writeU32(a[5], msg.size);
              return { eax: DPERR_BUFFERTOOSMALL };
            }
            if (a[4] && msg.size) {
              this.memory.write_memory(this.memory.read_memory(msg.data, msg.size), a[4]);
            }
            this.writeU32(a[5], msg.size);
            if (a[1]) this.writeU32(a[1], msg.from);
            if (a[2]) this.writeU32(a[2], msg.to);
            if (!((a[3] ?? 0) & 0x8)) {
              // DPRECEIVE_PEEK=0x8 时不弹出
              this.dplayQueue.shift();
              this.freeAllocation(msg.data);
            }
            return { eax: 0 };
          }
          case 'Close': {
            if (this.dplaySession) {
              if (this.dplaySession.hosting) {
                // 房主关闭 DirectPlay 会话时必须销毁 relay 房间，不能只离开最后一个玩家。
                this.dplayPost({ t: 'sclose', i: this.dplayInstance });
              } else {
                // 加入方可能创建多个本地玩家；逐个退出，不能只发送最后一个 dplayLocal。
                for (const [dpid, player] of this.dplayPlayers) {
                  if (player.local) this.dplayPost({ t: 'leave', i: this.dplayInstance, d: dpid });
                }
              }
            }
            if (this.dplayHeartbeatTimer !== null) {
              globalThis.clearInterval(this.dplayHeartbeatTimer);
              this.dplayHeartbeatTimer = null;
            }
            this.dplaySession = null;
            this.dplayPlayers.clear();
            this.dplayQueue.length = 0;
            this.nextDpid = 1;
            this.dplayLocal = 0;
            return { eax: 0 };
          }
          case 'EnumPlayers': {
            // 本地 + 远端玩家逐个回调（多组回调共用一个跳板）。
            // EnumPlayers(this, LPDPENUMPLAYERSCALLBACK2, LPVOID, DWORD)——
            // callback=a[1]、context=a[2]、flags=a[3]（曾错读 a[2]/a[3]，游戏
            // 枚举玩家永远 E_POINTER，玩家列表建不起来）。
            const callback = a[1] ?? 0;
            if (!callback) return { eax: 0x8000_4003 };
            if (this.dplayPlayers.size === 0) return { eax: 0 };
            const argSets: number[][] = [];
            for (const [dpid, player] of this.dplayPlayers) {
              // LPDPENUMPLAYERSCALLBACK2(DPID, 类型, DPNAME*, 标志, 上下文)
              argSets.push([
                dpid,
                0, // 玩家（非组）
                player.name,
                player.local ? 0x0000_0008 : 0x0000_0010, // DPENUMPLAYERS_LOCAL/REMOTE
                a[2] ?? 0,
              ]);
            }
            this.invokeGuestCallbacks(call, callback, argSets);
            return { eax: 0 };
          }
          case 'EnumGroups':
            // 没有组：零回调。
            return { eax: 0 };
          case 'EnumConnections': {
            // 伪造唯一连接：TCP/IP SP，回调客体枚举函数（跳板桥接）。
            const callback = a[2] ?? 0;
            const context = a[3] ?? 0;
            if (!callback) return { eax: 0x8000_4003 }; // E_POINTER
            this.ensureTcpipConnection();
            // LPDPENUMCONNECTIONSCALLBACK(GUID*, 连接, 尺寸, DPNAME*, 标志, 上下文)
            this.invokeGuestCallback(call, callback, [
              this.tcpipConnection + 16, // LPCGUID 指向连接内嵌的 guidSP
              this.tcpipConnection,
              40,
              this.tcpipConnectionName,
              0x0000_0001, // DPCONNECTION_DIRECTPLAY
              context,
            ]);
            return { eax: 0 };
          }
          case 'EnumSessions': {
            // 从 transport 缓存的建房方 announce 构造会话列表；过期 30s 丢弃。
            const callback = a[3] ?? 0;
            const context = a[4] ?? 0;
            if (!callback) return { eax: 0x8000_4003 };
            if (!this.dplayConnectionInitialized) return { eax: DPERR_UNINITIALIZED };
            // 现场诊断：游戏传入的模板（过滤依据）与回调地址（可反汇编其检查逻辑）。
            const templatePtr = a[1] ?? 0;
            const templateApp =
              templatePtr && this.readU32(templatePtr) >= 80
                ? formatGuid(this.readBytes(templatePtr + 24, 16))
                : '(null)';
            if (DPLAY_VERBOSE_LOG) {
              console.log(
                `[dplayx] EnumSessions: 回调=0x${callback.toString(16)} ` +
                  `模板app=${templateApp} dwFlags=0x${(a[5] ?? 0).toString(16)} dwTimeout=${a[2] ?? 0}`,
              );
              // 客体回调的早期拒绝检查依据由游戏模块登记，通用层不猜任何游戏的全局布局。
              const probe = this.gameProfile.directPlay?.enumSessionsProbeAddresses;
              if (probe) {
                console.log(
                  `[dplayx] 游戏枚举状态: 列表全局=0x${this.readU32(probe[0]).toString(16)} ` +
                    `计数=${this.readU8(probe[1])}`,
                );
              }
            }
            const now = this.clock.now();
            const callbackFlags = this.gameProfile.directPlay?.enumSessionsCallbackFlags ?? 0;
            const argSets: number[][] = [];
            for (const [instance, s] of this.dplayRemoteSessions) {
              if (now - s.lastSeen > DPLAY_DISCOVERY_TTL_MS) {
                this.dplayRemoteSessions.delete(instance);
                continue;
              }
              const name = this.bytesToGuest(s.nameBytes);
              const desc = this.alloc(80, true);
              this.memory.write_memory(new Uint8Array(80), desc);
              this.writeU32(desc, 80); // dwSize
              this.writeU32(desc + 4, s.sessionFlags); // dwFlags（房主的会话旗标）
              this.memory.write_memory(guidBytes(instance), desc + 8); // guidInstance
              this.memory.write_memory(guidBytes(s.appGuid), desc + 24); // guidApplication（游戏按此过滤）
              this.writeU32(desc + 40, s.maxPlayers); // dwMaxPlayers
              this.writeU32(desc + 44, s.currentPlayers); // dwCurrentPlayers
              this.writeU32(desc + 48, name); // lpszSessionNameA
              const timeout = this.alloc(4, true);
              this.writeU32(timeout, a[2] ?? 0); // 回传游戏传入的枚举超时
              // LPDPENUMSESSIONSCALLBACK2(DPSESSIONDESC2*, DWORD*, 标志, 上下文)；
              // 标志取值与理由见游戏模块登记的 enumSessionsCallbackFlags。
              argSets.push([desc, timeout, callbackFlags, context]);
            }
            if (argSets.length === 0) {
              if (DPLAY_VERBOSE_LOG)
                console.log(`[dplayx] EnumSessions 返回 0 个会话（缓存 ${this.dplayRemoteSessions.size}）`);
              return { eax: 0 };
            }
            if (DPLAY_VERBOSE_LOG) {
              const first = [...this.dplayRemoteSessions.values()][0];
              console.log(
                `[dplayx] EnumSessions 返回 ${argSets.length} 个会话` +
                  `（app=${first?.appGuid}, flags=0x${first?.sessionFlags.toString(16)}, ` +
                  `cur=${first?.currentPlayers}/max=${first?.maxPlayers}）`,
              );
            }
            this.invokeGuestCallbacks(call, callback, argSets);
            return { eax: 0 };
          }
          case 'InitializeConnection': {
            // conn=null 是「用默认连接初始化」——参考环境（有 TCP/IP 的 2001 PC）
            // 上这会成功；兼容层的「默认连接」就是未来的浏览器传输。成功后记状态。
            const connPtr = a[1] ?? 0;
            if (!connPtr) {
              this.dplayConnectionInitialized = true;
              return { eax: 0 }; // DP_OK
            }
            // 带连接参数的形式：TCP/IP 默认连接（无地址）即视为就绪；已识别但
            // 非 TCP/IP 的 SP 停在边界；解析不出标准 DPLCONNECTION 的按游戏
            // 自带包装对象接受（见下）。
            const flags = a[2] ?? 0;
            const size = this.readU32(connPtr);
            if (size < 40) {
              this.unimplementedDetail = `InitializeConnection(conn=0x${connPtr.toString(16)} 截断 dwSize=${size}, dwFlags=0x${flags.toString(16)})`;
              return null;
            }
            const connFlags = this.readU32(connPtr + 4);
            const guidSp = formatGuid(this.readBytes(connPtr + 16, 16));
            const address = this.readU32(connPtr + 32);
            const addressSize = this.readU32(connPtr + 36);
            if (guidSp === DPSPGUID_TCPIP && !address) {
              this.dplayConnectionInitialized = true;
              return { eax: 0 }; // DP_OK
            }
            if (SP_NAMES[guidSp] !== undefined) {
              // ipx/serial/modem 或带地址的 TCP/IP：未支持的传输，停在边界并报详情。
              const addrText = !address
                ? '(null)'
                : guidSp === DPSPGUID_TCPIP
                  ? this.readCString(address, Math.min(addressSize || 256, 256))
                  : `0x${address.toString(16)}/${addressSize}`;
              const connFlagText =
                connFlags === 1 ? 'JOIN' : connFlags === 2 ? 'CREATE' : `0x${connFlags.toString(16)}`;
              this.unimplementedDetail = `InitializeConnection(SP=${SP_NAMES[guidSp]}, connFlags=${connFlagText}, addr=${addrText}, dwFlags=0x${flags.toString(16)})`;
              return null;
            }
            // 非标准 DPLCONNECTION：游戏用自带包装对象管理连接（拿到我们枚举的
            // 连接后自己拷贝封装，连 this 都是它的对象而非我们的）。参考环境里
            // 这条调用必然成功；真正的传输决策到 Open/Connect 才浮现。
            this.dplayConnectionInitialized = true;
            return { eax: 0 }; // DP_OK
          }
          default:
            return null;
        }
      }
      return null;
    }

    /** DPLAYX.DLL 序数导入（ord4 = DirectPlayLobbyCreateA，Wine dplayx.spec）。 */
    protected dispatchDplayx(key: string, _name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'DPLAYX.DLL!ord4': {
          // DirectPlayLobbyCreateA(GUID*, IDirectPlayLobbyA**, IUnknown*, LPVOID, DWORD)
          // —— 官方要求 lpGUIDDSP/lpData 为 NULL、dwDataSize 为 0（Wine dplobby.c）。
          if (a[0] || a[3] || a[4]) {
            if (a[1]) this.writeU32(a[1], 0);
            return { eax: 0x8007_0057 }; // DPERR_INVALIDPARAM = E_INVALIDARG
          }
          if (a[2]) {
            if (a[1]) this.writeU32(a[1], 0);
            return { eax: 0x8004_0110 }; // CLASS_E_NOAGGREGATION
          }
          if (!a[1]) return { eax: 0x8000_4003 }; // E_POINTER
          this.writeU32(a[1], this.createDirectPlayLobby());
          return { eax: 0 }; // DP_OK
        }
        default:
          return null;
      }
    }
  };
}
