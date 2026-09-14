/**
 * RA2/YR PE32 载入器。
 *
 * 这不是 Windows 模拟器：它只做 Windows loader 的最小部分，把 PE 映像放到
 * v86 的客体内存，然后把 IAT 改写为同步 hypercall 桩。Win32 语义由 JS host 实现。
 */

export const HYPERCALL_PAGE = 0x0006_0000;
export const HYPERCALL_STACK = HYPERCALL_PAGE + 0x00;
export const HYPERCALL_EAX = HYPERCALL_PAGE + 0x04;
export const HYPERCALL_EDX = HYPERCALL_PAGE + 0x08;
export const HYPERCALL_REQUEST = HYPERCALL_PAGE + 0x0c;
/** 用 COM1 输出事件立即唤醒 host，避免每次 hypercall 等待定时轮询。 */
export const HYPERCALL_NOTIFY_PORT = 0x03f8;
/** 0=无异常，否则为 CPU vector + 1（由 boot.asm 最后发布）。 */
export const HYPERCALL_EXCEPTION = HYPERCALL_PAGE + 0x10;
export const HYPERCALL_EXCEPTION_ERROR = HYPERCALL_PAGE + 0x14;
export const HYPERCALL_EXCEPTION_EIP = HYPERCALL_PAGE + 0x18;
export const HYPERCALL_EXCEPTION_CS = HYPERCALL_PAGE + 0x1c;
export const HYPERCALL_EXCEPTION_EFLAGS = HYPERCALL_PAGE + 0x20;
export const HYPERCALL_EXCEPTION_ESP = HYPERCALL_PAGE + 0x24;
export const HYPERCALL_EXCEPTION_EAX = HYPERCALL_PAGE + 0x28;
export const HYPERCALL_EXCEPTION_ECX = HYPERCALL_PAGE + 0x2c;
export const HYPERCALL_EXCEPTION_EDX = HYPERCALL_PAGE + 0x30;
export const HYPERCALL_EXCEPTION_EBX = HYPERCALL_PAGE + 0x34;
export const HYPERCALL_EXCEPTION_EBP = HYPERCALL_PAGE + 0x38;
export const HYPERCALL_EXCEPTION_ESI = HYPERCALL_PAGE + 0x3c;
export const HYPERCALL_EXCEPTION_EDI = HYPERCALL_PAGE + 0x40;
/** Host 解析 PE 后写入的真实 AddressOfEntryPoint，供通用启动固件跳转。 */
export const HYPERCALL_ENTRY = HYPERCALL_PAGE + 0x44;
/** 已预留且尚未返回的回调桥总数（包括尚未开始执行的桥）。 */
export const HYPERCALL_CALLBACK_DEPTH = HYPERCALL_PAGE + 0x48;
/** 固件停机循环标记：PE 入口返回后 hang 写 1（host 据此把静默停机当作退出）。 */
export const HYPERCALL_HALTED = HYPERCALL_PAGE + 0x4c;
/** 跳板桥回调后把客体回调的 EAX 存这里（诊断用：枚举回调的 BOOL 返回值）。 */
export const HYPERCALL_CALLBACK_RESULT = HYPERCALL_PAGE + 0x50;
/** Host 为当前游戏选择的主线程栈顶；大 PE 可避开原固定栈区。 */
export const HYPERCALL_STACK_TOP = HYPERCALL_PAGE + 0x58;
/** 客体内 QueryPerformanceCounter 的 64-bit 单调计数器（1 tick = 1ms）。 */
export const HYPERCALL_QPC_LOW = HYPERCALL_PAGE + 0x5c;
export const HYPERCALL_QPC_HIGH = HYPERCALL_PAGE + 0x60;
/** 客体/host 共享的 Win32 LastError。 */
export const HYPERCALL_LAST_ERROR = HYPERCALL_PAGE + 0x64;
/** 协作式客体线程调度：当前/下一线程 id 与 API 返回后的继续地址。 */
export const HYPERCALL_THREAD_CURRENT = HYPERCALL_PAGE + 0x68;
export const HYPERCALL_THREAD_NEXT = HYPERCALL_PAGE + 0x6c;
export const HYPERCALL_THREAD_CONTINUATION = HYPERCALL_PAGE + 0x70;
/** PIT 抢占调度与 host 共用的线程数。 */
export const HYPERCALL_THREAD_COUNT = HYPERCALL_PAGE + 0x74;
/** Win32 光标显示计数器（ShowCursor 的返回值；>=0 表示可见）。 */
export const HYPERCALL_CURSOR_COUNT = HYPERCALL_PAGE + 0x78;
/** PeekMessageA 空队列快速返回预算；0 时必须回 host 检查消息/定时器。 */
export const HYPERCALL_PEEK_BUDGET = HYPERCALL_PAGE + 0x7c;
/** host/客体共享的 Win32 光标坐标，供 GetCursorPos 快速桩直接读取。 */
export const HYPERCALL_CURSOR_X = HYPERCALL_PAGE + 0x80;
export const HYPERCALL_CURSOR_Y = HYPERCALL_PAGE + 0x84;
/** RA2 shell 当前由 host 合成的离屏 surface，供 Unlock 快桩识别换层边界。 */
export const HYPERCALL_ACTIVE_SHELL_SURFACE = HYPERCALL_PAGE + 0x88;
/**
 * import 桩占用全局 request/EAX/EDX 返回槽的完整生命周期。
 * host 必须先清 request 再发 IRQ4，因此 request=0 不代表当前线程已消费返回值；
 * PIT 以本标记为切换屏障，消除 IRQ4 iret 与桩内 cli 之间的抢占窗口。
 */
export const HYPERCALL_IMPORT_ACTIVE = HYPERCALL_PAGE + 0x8c;
export const GUEST_THREAD_LIMIT = 64;
export const GUEST_THREAD_CONTEXT_ESPS = 0x0007_3400;
export const GUEST_THREAD_CONTEXT_SEH = 0x0007_3500;
export const GUEST_THREAD_CONTEXT_STACK_TOP = 0x0007_3600;
export const GUEST_THREAD_CONTEXT_STACK_BOTTOM = 0x0007_3700;
export const GUEST_THREAD_CONTEXT_LAST_ERROR = 0x0007_3800;
/** 0=不存在/已退出，1=可运行，>=2 表示 (100Hz tick 截止值 + 2)。 */
export const GUEST_THREAD_RUN_STATES = 0x0007_3900;
export const GUEST_SCHEDULER_TICKS = 0x0007_3a00;
/** 每线程兼容性原子执行深度；非零时 import 返回保持 CLI，不代表 Win32 锁。 */
export const GUEST_THREAD_CRITICAL_DEPTH = 0x0007_3b00;
export const GUEST_CALLBACK_OWNERS = 0x0007_3c00;
export const GUEST_CALLBACK_BASE = 0x0022_0000;
export const GUEST_CALLBACK_STRIDE = 4096;
export const GUEST_CALLBACK_SLOTS = 64;
/** 与 boot.asm 的 FNSAVE/FRSTOR 格式一致：108 字节状态，128 字节步长。 */
export const GUEST_THREAD_FPU_CONTEXTS = 0x0007_8000;
export const GUEST_THREAD_FPU_CONTEXT_BYTES = 128;

// 窗口几何/属性镜像表：让 GetClientRect/GetWindowRect/ClientToScreen/GetParent/
// GetWindowLongA 等高频只读查询留在客体内执行，避免每次跨 VM↔JS。
// 位于 0x62000（environment 字符串 0x61300 之后、TEB 0x70000 之前的空闲区）。
// hwnd 从 0x2000 顺序分配，按 (hwnd-0x2000) 索引；越界或未同步项回退完整 hypercall。
// X/Y 存绝对屏幕坐标（shim 同步时沿父链累加），客体桩无需遍历父链。
export const GUEST_WINDOW_TABLE = 0x0006_2000;
export const GUEST_WINDOW_TABLE_MAX = 896;
export const GUEST_WINDOW_ENTRY_BYTES = 64;
export const GUEST_WINDOW_X = 0;
export const GUEST_WINDOW_Y = 4;
export const GUEST_WINDOW_WIDTH = 8;
export const GUEST_WINDOW_HEIGHT = 12;
export const GUEST_WINDOW_PARENT = 16;
export const GUEST_WINDOW_STYLE = 20; // GWL_STYLE (-16)
export const GUEST_WINDOW_ID = 24; // GWL_ID (-12)
export const GUEST_WINDOW_EXSTYLE = 28; // GWL_EXSTYLE (-20)
export const GUEST_WINDOW_WNDPROC = 32; // GWL_WNDPROC (-4)
export const GUEST_WINDOW_USERDATA = 36; // GWL_USERDATA (-21)
export const GUEST_WINDOW_EXTRA0 = 40; // 窗口额外字节 0/4/8/12
export const GUEST_WINDOW_EXTRA4 = 44;
export const GUEST_WINDOW_EXTRA8 = 48;
export const GUEST_WINDOW_EXTRA12 = 52;
export const GUEST_WINDOW_VALID = 56;

export interface PeImport {
  /** hypercall request id（0 专用于“无请求”，所以 id 从 1 开始） */
  id: number;
  dll: string;
  name: string;
  key: string;
  slot: number;
  stub: number;
  argBytes: number;
  /** Win32 层装载后注释的 DLL 数值标签（win32ModuleOf）；非 Win32 装载器忽略。 */
  win32Module?: number;
  /** 动态 COM 桩预计算路由：接口数值标签（见 shim/directx.ts COM_TAG_*）；非 COM 为 undefined。 */
  comTag?: number;
  /** 方法名（key 最后一个 '.' 之后），桩创建时算好——每次调用的 lastIndexOf+slice 是
   *  統一天下每秒几十万次 hypercall 的路由热点。 */
  method?: string;
}

export interface PeImage {
  entry: number;
  imageBase: number;
  sizeOfImage: number;
  /** 导入名（DLL!Func）→ IAT 槽位地址（已被打补丁） */
  imports: Map<string, number>;
  importList: PeImport[];
  /** 每 DLL 的 IAT 起始/槽数（for debug） */
  iatRanges: Array<{ dll: string; firstThunk: number; count: number }>;
}

export type ImportArgBytes = (dll: string, name: string) => number;
export type ImportStubFactory = (dll: string, name: string, id: number, argBytes: number) => Uint8Array;

/**
 * 生成 x86 stdcall import 桩。客体发布 request 并通过 COM1 端口通知 host，
 * 然后原地等待 JS 写回 EAX/EDX 并清零 request。
 * 这个握手使 v86 和浏览器的异步事件循环不会破坏 Win32 同步调用语义。
 */
export function makeImportStub(id: number, argBytes: number): Uint8Array {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`import stub id 非法: ${id}`);
  if (!Number.isInteger(argBytes) || argBytes < 0 || argBytes > 0xffff || argBytes % 4 !== 0) {
    throw new Error(`import stub 参数字节数非法: ${argBytes}`);
  }
  const b = new Uint8Array(512);
  let p = 0;
  // API 握手使用全局共享页；禁止 PIT 在 request 发布/回收中途切换线程。
  b[p++] = 0xfa; // cli
  // C7 05 8C000600 01000000  mov dword [importActive],1
  b[p++] = 0xc7;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_IMPORT_ACTIVE);
  p = put32(b, p, 1);
  // 89 25 00000600          mov [0x60000], esp
  b[p++] = 0x89;
  b[p++] = 0x25;
  p = put32(b, p, HYPERCALL_STACK);
  // B8 id                    mov eax, id
  b[p++] = 0xb8;
  p = put32(b, p, id);
  // A3 0C000600              mov [0x6000c], eax
  b[p++] = 0xa3;
  p = put32(b, p, HYPERCALL_REQUEST);
  // 66 BA F8 03 / EE         mov dx, 0x3f8; out dx, al（v86 serial0-output-byte）
  b[p++] = 0x66;
  b[p++] = 0xba;
  b[p++] = HYPERCALL_NOTIFY_PORT & 0xff;
  b[p++] = HYPERCALL_NOTIFY_PORT >>> 8;
  b[p++] = 0xee;
  // wait: STI 后先查 request。host 可能抢在 HLT 前就完成了释放（fast path），
  // 此时唤醒字节已被固件 irq_common 读走，若直接 HLT 将永远不会醒来。
  // 未释放才 HLT，靠 COM1 RX IRQ4 唤醒；CLI 恢复游戏环境。
  const wait = p;
  b[p++] = 0xfb; // sti
  b[p++] = 0x83;
  b[p++] = 0x3d;
  p = put32(b, p, HYPERCALL_REQUEST);
  b[p++] = 0x00;
  b[p++] = 0x74; // je done
  const jeOffset = p++;
  b[p++] = 0xf4; // hlt
  b[p++] = 0xfa; // cli
  b[p++] = 0xec; // in al, dx：通常已被固件读走；读空 FIFO 无害。
  b[p++] = 0xeb; // jmp wait
  const jmpRel8 = wait - (p + 1);
  b[p++] = jmpRel8 & 0xff;
  const done = p;
  b[jeOffset] = done - (jeOffset + 1);
  b[p++] = 0xfa; // cli
  // A1 04000600              mov eax, [0x60004]
  b[p++] = 0xa1;
  p = put32(b, p, HYPERCALL_EAX);
  // 8B 15 08000600           mov edx, [0x60008]
  b[p++] = 0x8b;
  b[p++] = 0x15;
  p = put32(b, p, HYPERCALL_EDX);
  // Host 可把 NEXT 改成另一条 runnable 线程。API 返回值已经装入 EAX/EDX，
  // 在切换前连同其余寄存器保存，因此每条线程恢复时仍得到自己的返回值。
  b[p++] = 0x8b;
  b[p++] = 0x0d;
  p = put32(b, p, HYPERCALL_THREAD_NEXT); // mov ecx,[next]
  b[p++] = 0x3b;
  b[p++] = 0x0d;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT); // cmp ecx,[current]
  b[p++] = 0x0f;
  b[p++] = 0x84;
  const noSwitchRel = p;
  p += 4;

  // 把 stdcall 的 return+args 先折叠成单一继续地址，再生成统一上下文帧。
  b[p++] = 0x8f;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_THREAD_CONTINUATION); // pop [cont]
  b[p++] = 0x81;
  b[p++] = 0xc4;
  p = put32(b, p, argBytes); // add esp,argBytes
  b[p++] = 0xff;
  b[p++] = 0x35;
  p = put32(b, p, HYPERCALL_THREAD_CONTINUATION); // push [cont]
  b[p++] = 0x9c; // pushfd
  // 兼容性原子执行区以外恢复 IF；普通 Win32 锁不屏蔽抢占。
  b[p++] = 0xa1;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT);
  b[p++] = 0x83;
  b[p++] = 0x3c;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CRITICAL_DEPTH);
  b[p++] = 0;
  b[p++] = 0x75;
  b[p++] = 0x07;
  b[p++] = 0x81;
  b[p++] = 0x0c;
  b[p++] = 0x24;
  p = put32(b, p, 0x0000_0200); // or [esp],IF
  b[p++] = 0xa1;
  p = put32(b, p, HYPERCALL_EAX); // 恢复 API 返回值
  b[p++] = 0x60; // pushad

  b[p++] = 0xa1;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT); // eax=current
  b[p++] = 0x89;
  b[p++] = 0x24;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_ESPS);
  // 与 PIT 切换共用 x87/MMX 保存区，不能只保存通用寄存器。
  b[p++] = 0x89;
  b[p++] = 0xc2; // mov edx,eax
  b[p++] = 0xc1;
  b[p++] = 0xe2;
  b[p++] = 7; // shl edx,7
  b[p++] = 0xdd;
  b[p++] = 0xb2;
  p = put32(b, p, GUEST_THREAD_FPU_CONTEXTS); // fnsave
  b[p++] = 0x8b;
  b[p++] = 0x15;
  p = put32(b, p, 0x0007_0000);
  b[p++] = 0x89;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_SEH);
  b[p++] = 0x8b;
  b[p++] = 0x15;
  p = put32(b, p, 0x0007_0004);
  b[p++] = 0x89;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_STACK_TOP);
  b[p++] = 0x8b;
  b[p++] = 0x15;
  p = put32(b, p, 0x0007_0008);
  b[p++] = 0x89;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_STACK_BOTTOM);
  b[p++] = 0x8b;
  b[p++] = 0x15;
  p = put32(b, p, HYPERCALL_LAST_ERROR);
  b[p++] = 0x89;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_LAST_ERROR);

  b[p++] = 0xa1;
  p = put32(b, p, HYPERCALL_THREAD_NEXT); // eax=next
  b[p++] = 0xa3;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT);
  b[p++] = 0x8b;
  b[p++] = 0x24;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_ESPS);
  b[p++] = 0x89;
  b[p++] = 0xc2; // mov edx,eax
  b[p++] = 0xc1;
  b[p++] = 0xe2;
  b[p++] = 7; // shl edx,7
  b[p++] = 0xdd;
  b[p++] = 0xa2;
  p = put32(b, p, GUEST_THREAD_FPU_CONTEXTS); // frstor
  b[p++] = 0x8b;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_SEH);
  b[p++] = 0x89;
  b[p++] = 0x15;
  p = put32(b, p, 0x0007_0000);
  b[p++] = 0x8b;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_STACK_TOP);
  b[p++] = 0x89;
  b[p++] = 0x15;
  p = put32(b, p, 0x0007_0004);
  b[p++] = 0x8b;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_STACK_BOTTOM);
  b[p++] = 0x89;
  b[p++] = 0x15;
  p = put32(b, p, 0x0007_0008);
  b[p++] = 0x8b;
  b[p++] = 0x14;
  b[p++] = 0x85;
  p = put32(b, p, GUEST_THREAD_CONTEXT_LAST_ERROR);
  b[p++] = 0x89;
  b[p++] = 0x15;
  p = put32(b, p, HYPERCALL_LAST_ERROR);
  // 当前 API 返回值已进入保存帧；恢复下一线程前可释放全局返回槽。
  b[p++] = 0xc7;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_IMPORT_ACTIVE);
  p = put32(b, p, 0);
  b[p++] = 0x61; // popad
  b[p++] = 0x9d; // popfd
  b[p++] = 0xc3; // ret 到下一线程的继续地址/入口

  const noSwitch = p;
  const relative = noSwitch - (noSwitchRel + 4);
  put32(b, noSwitchRel, relative);
  // EAX/EDX 已装入寄存器且不会切换线程，返回前释放全局返回槽。
  b[p++] = 0xc7;
  b[p++] = 0x05;
  p = put32(b, p, HYPERCALL_IMPORT_ACTIVE);
  p = put32(b, p, 0);
  b[p++] = 0x8b;
  b[p++] = 0x0d;
  p = put32(b, p, HYPERCALL_THREAD_CURRENT);
  b[p++] = 0x83;
  b[p++] = 0x3c;
  b[p++] = 0x8d;
  p = put32(b, p, GUEST_THREAD_CRITICAL_DEPTH);
  b[p++] = 0;
  b[p++] = 0x75;
  b[p++] = 0x01;
  b[p++] = 0xfb; // sti：兼容性原子执行区以外允许抢占
  b[p++] = 0xc2;
  b[p++] = argBytes & 0xff;
  b[p++] = (argBytes >>> 8) & 0xff;
  if (p > b.length) throw new Error(`import stub 超出容量: ${p}`);
  return b.slice(0, p);
}

/** 不进入 host 的 stdcall 快速桩：返回固定 EAX 并弹出参数。 */
export function makeConstantImportStub(eax: number, argBytes: number): Uint8Array {
  validateArgBytes(argBytes);
  return new Uint8Array([
    0xb8,
    eax & 0xff,
    (eax >>> 8) & 0xff,
    (eax >>> 16) & 0xff,
    (eax >>> 24) & 0xff,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

/** 不进入 host 的 stdcall 快速桩：原样返回第一个参数。 */
export function makeFirstArgImportStub(argBytes: number): Uint8Array {
  validateArgBytes(argBytes);
  return new Uint8Array([
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax, [esp + 4]
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

/**
 * 载入 PE 到以物理地址为下标的客体内存镜像。
 *
 * `stubAlloc` 必须返回客体虚拟/物理地址（当前固件为无分页平坦映射）。
 */
export function loadPe(
  mem8: Uint8Array,
  exe: Uint8Array,
  stubAlloc: (bytes: number) => number,
  importArgBytes: ImportArgBytes,
  importStub: ImportStubFactory = (_dll, _name, id, argBytes) => makeImportStub(id, argBytes),
): PeImage {
  const dv = viewOf(exe);
  need(exe, 0, 0x40, 'DOS 头');
  const peOff = dv.getUint32(0x3c, true);
  need(exe, peOff, 24, 'PE 头');
  if (dv.getUint32(peOff, true) !== 0x0000_4550) throw new Error('非 PE 文件');
  const numSections = dv.getUint16(peOff + 6, true);
  const optionalSize = dv.getUint16(peOff + 20, true);
  const optOff = peOff + 24;
  need(exe, optOff, optionalSize, 'PE optional header');
  if (dv.getUint16(optOff, true) !== 0x10b) throw new Error('仅支持 PE32');

  const imageBase = dv.getUint32(optOff + 28, true);
  const entry = dv.getUint32(optOff + 16, true) + imageBase;
  const sizeOfImage = dv.getUint32(optOff + 56, true);
  const sizeOfHeaders = dv.getUint32(optOff + 60, true);
  need(mem8, imageBase, sizeOfImage, 'VM 中的 PE 映像');

  // Windows 会同时映射 DOS/PE 头；部分 CRT 和 GetModuleHandle 后的代码会读它。
  const headerBytes = Math.min(sizeOfHeaders, exe.length);
  mem8.set(exe.subarray(0, headerBytes), imageBase);

  const sectionTable = optOff + optionalSize;
  need(exe, sectionTable, numSections * 40, 'section 表');
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    const vsize = dv.getUint32(s + 8, true);
    const vaddr = dv.getUint32(s + 12, true);
    const rawSize = dv.getUint32(s + 16, true);
    const rawOff = dv.getUint32(s + 20, true);
    const mappedSize = Math.max(vsize, rawSize);
    const dst = imageBase + vaddr;
    need(mem8, dst, mappedSize, `section #${i} 目标`);
    if (rawSize > 0) {
      need(exe, rawOff, rawSize, `section #${i} 原始数据`);
      mem8.set(exe.subarray(rawOff, rawOff + rawSize), dst);
    }
    if (mappedSize > rawSize) mem8.fill(0, dst + rawSize, dst + mappedSize);
  }

  const imports = new Map<string, number>();
  const importList: PeImport[] = [];
  const iatRanges: PeImage['iatRanges'] = [];
  const importDirRva = dv.getUint32(optOff + 104, true); // data directory[1]
  let descOff = importDirRva ? rvaToOff(exe, importDirRva) : -1;
  for (let descriptor = 0; descOff >= 0 && descriptor < 128; descriptor++, descOff += 20) {
    need(exe, descOff, 20, `import descriptor #${descriptor}`);
    const dllNameRva = dv.getUint32(descOff + 12, true);
    const firstThunkRva = dv.getUint32(descOff + 16, true);
    const origThunkRva = dv.getUint32(descOff, true);
    if (!dllNameRva && !firstThunkRva) break;
    if (!dllNameRva || !firstThunkRva) throw new Error(`import descriptor #${descriptor} 不完整`);

    const dll = readCstr(exe, dllNameRva);
    const dllUpper = dll.toUpperCase();
    let count = 0;
    for (let k = 0; k < 4096; k++) {
      const thunkRva = (origThunkRva || firstThunkRva) + k * 4;
      const thunkOff = rvaToOff(exe, thunkRva);
      if (thunkOff < 0) throw new Error(`${dll} thunk RVA 无效: 0x${thunkRva.toString(16)}`);
      need(exe, thunkOff, 4, `${dll} thunk #${k}`);
      const thunk = dv.getUint32(thunkOff, true);
      if (!thunk) break;

      const name = (thunk & 0x8000_0000) !== 0 ? `ord${thunk & 0xffff}` : readCstr(exe, thunk + 2); // IMAGE_IMPORT_BY_NAME 前 2 字节 = hint
      const slot = imageBase + firstThunkRva + k * 4;
      need(mem8, slot, 4, `${dll}!${name} IAT`);
      const argBytes = importArgBytes(dllUpper, name);
      const id = importList.length + 1;
      const stubBytes = importStub(dllUpper, name, id, argBytes);
      const stub = stubAlloc(stubBytes.length);
      need(mem8, stub, stubBytes.length, `${dll}!${name} stub`);
      mem8.set(stubBytes, stub);
      putU32(mem8, slot, stub);

      const key = `${dllUpper}!${name}`;
      imports.set(key, slot);
      importList.push({ id, dll: dllUpper, name, key, slot, stub, argBytes });
      count++;
    }
    iatRanges.push({ dll, firstThunk: imageBase + firstThunkRva, count });
  }

  return { entry, imageBase, sizeOfImage, imports, importList, iatRanges };
}

function validateArgBytes(argBytes: number): void {
  if (!Number.isInteger(argBytes) || argBytes < 0 || argBytes > 0xffff || argBytes % 4 !== 0) {
    throw new Error(`import stub 参数字节数非法: ${argBytes}`);
  }
}

/** RVA → 文件偏移（header 或 section；无匹配返回 -1） */
/**
 * 枚举 EXE 导入表的全部 `DLL!函数名` 键（大写），不做桩生成。
 * 供文件层按导入覆盖度把自定义命名的 EXE 归类到对应兼容层；结构异常时返回空表。
 */
export function peImportKeys(exe: Uint8Array): string[] {
  try {
    const dv = viewOf(exe);
    const keys: string[] = [];
    if (exe.length < 0x40) return keys;
    const peOff = dv.getUint32(0x3c, true);
    if (peOff < 0 || peOff + 24 > exe.length) return keys;
    const optionalSize = dv.getUint16(peOff + 20, true);
    const optOff = peOff + 24;
    if (optOff + optionalSize > exe.length) return keys;
    const importDirRva = optionalSize >= 108 ? dv.getUint32(optOff + 104, true) : 0; // data directory[1]
    let descOff = importDirRva ? rvaToOff(exe, importDirRva) : -1;
    for (let descriptor = 0; descOff >= 0 && descriptor < 128; descriptor++, descOff += 20) {
      if (descOff + 20 > exe.length) return keys;
      const dllNameRva = dv.getUint32(descOff + 12, true);
      const firstThunkRva = dv.getUint32(descOff + 16, true);
      const origThunkRva = dv.getUint32(descOff, true);
      if (!dllNameRva && !firstThunkRva) break;
      if (!dllNameRva || !firstThunkRva) return keys;
      const dllUpper = readCstr(exe, dllNameRva).toUpperCase();
      for (let k = 0; k < 4096; k++) {
        const thunkRva = (origThunkRva || firstThunkRva) + k * 4;
        const thunkOff = rvaToOff(exe, thunkRva);
        if (thunkOff < 0 || thunkOff + 4 > exe.length) return keys;
        const thunk = dv.getUint32(thunkOff, true);
        if (!thunk) break;
        const name = (thunk & 0x8000_0000) !== 0 ? `ord${thunk & 0xffff}` : readCstr(exe, thunk + 2); // IMAGE_IMPORT_BY_NAME 前 2 字节 = hint
        keys.push(`${dllUpper}!${name}`);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

export function rvaToOff(exe: Uint8Array, rva: number): number {
  const dv = viewOf(exe);
  if (exe.length < 0x40) return -1;
  const peOff = dv.getUint32(0x3c, true);
  if (peOff < 0 || peOff + 24 > exe.length) return -1;
  const numSections = dv.getUint16(peOff + 6, true);
  const optionalSize = dv.getUint16(peOff + 20, true);
  const optOff = peOff + 24;
  if (optOff + optionalSize > exe.length) return -1;
  const sizeOfHeaders = optionalSize >= 64 ? dv.getUint32(optOff + 60, true) : 0;
  if (rva < sizeOfHeaders && rva < exe.length) return rva;
  const sectionTable = optOff + optionalSize;
  if (sectionTable + numSections * 40 > exe.length) return -1;
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    const vsize = dv.getUint32(s + 8, true);
    const vaddr = dv.getUint32(s + 12, true);
    const rawSize = dv.getUint32(s + 16, true);
    const rawOff = dv.getUint32(s + 20, true);
    if (rva >= vaddr && rva < vaddr + Math.max(vsize, rawSize)) {
      const off = rawOff + (rva - vaddr);
      return off < exe.length ? off : -1;
    }
  }
  return -1;
}

function readCstr(exe: Uint8Array, rva: number): string {
  const off = rvaToOff(exe, rva);
  if (off < 0) throw new Error(`ASCII 串 RVA 无效: 0x${rva.toString(16)}`);
  let end = off;
  while (end < exe.length && exe[end] !== 0) end++;
  if (end === exe.length) throw new Error(`ASCII 串未终止: RVA 0x${rva.toString(16)}`);
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(exe[i]!);
  return s;
}

function put32(bytes: Uint8Array, p: number, value: number): number {
  bytes[p++] = value & 0xff;
  bytes[p++] = (value >>> 8) & 0xff;
  bytes[p++] = (value >>> 16) & 0xff;
  bytes[p++] = (value >>> 24) & 0xff;
  return p;
}

function putU32(bytes: Uint8Array, p: number, value: number): void {
  bytes[p] = value & 0xff;
  bytes[p + 1] = (value >>> 8) & 0xff;
  bytes[p + 2] = (value >>> 16) & 0xff;
  bytes[p + 3] = (value >>> 24) & 0xff;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function need(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(`${label} 越界: offset=0x${offset.toString(16)} length=0x${length.toString(16)}`);
  }
}
