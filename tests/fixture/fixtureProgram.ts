/**
 * 合成测试程序：一个手工生成的最小 Win32 PE32，不依赖任何原版游戏资源，
 * 用于在 CI 上端到端验证「PE 装载 → IAT hypercall → Win32 shim → 客体回调」
 * 全链路。
 *
 * 程序逻辑（入口由固件 call 进来，FS=TEB，ESP=0x700000）：
 *   1. GetVersion / GetCommandLineA+lstrlenA —— 基本调用与字符串返回
 *   2. HeapCreate/HeapAlloc/HeapFree —— shim 堆与 HEAP_ZERO_MEMORY
 *   3. VirtualAlloc/VirtualFree —— 虚拟保留区 arena
 *   4. CRITICAL_SECTION 四件套 —— 锁计数字段语义（快速桩与 host 路径同断言）
 *   5. _lopen/_lread/_llseek/_lclose —— 挂载文件读取与位置同步
 *   6. CreateFileA(OPEN_EXISTING) 缺失文件 —— INVALID_HANDLE + GetLastError=2
 *   7. RegisterClassA/CreateWindowExA/SendMessageA —— WndProc 回调跳板（同步）
 *   8. PostMessageA×3 + PostQuitMessage + GetMessageA/DispatchMessageA 泵
 *      —— 消息队列与 DispatchMessage 回调跳板
 *   9. Sleep(1) —— delayMs 挂起/唤醒路径
 *  10. ExitProcess(0)；任一检查失败以步骤号为退出码退出，定位失败环节。
 */
import { buildPe32, type BuiltPe } from './peBuilder';

/** fixture 自包含的 stdcall ABI（参数字节数）；与游戏 ABI 表解耦，避免互相拖累。 */
export const FIXTURE_ABI: Record<string, number> = {
  'KERNEL32.DLL!GetVersion': 0,
  'KERNEL32.DLL!GetCommandLineA': 0,
  'KERNEL32.DLL!lstrlenA': 4,
  'KERNEL32.DLL!HeapCreate': 12,
  'KERNEL32.DLL!HeapAlloc': 12,
  'KERNEL32.DLL!HeapFree': 12,
  'KERNEL32.DLL!VirtualAlloc': 16,
  'KERNEL32.DLL!VirtualFree': 12,
  'KERNEL32.DLL!InitializeCriticalSection': 4,
  'KERNEL32.DLL!EnterCriticalSection': 4,
  'KERNEL32.DLL!LeaveCriticalSection': 4,
  'KERNEL32.DLL!DeleteCriticalSection': 4,
  'KERNEL32.DLL!_lopen': 8,
  'KERNEL32.DLL!_lread': 12,
  'KERNEL32.DLL!_llseek': 12,
  'KERNEL32.DLL!_lclose': 4,
  'KERNEL32.DLL!CreateFileA': 28,
  'KERNEL32.DLL!GetLastError': 0,
  'KERNEL32.DLL!Sleep': 4,
  'KERNEL32.DLL!ExitProcess': 4,
  'USER32.DLL!RegisterClassA': 4,
  'USER32.DLL!CreateWindowExA': 48,
  'USER32.DLL!SendMessageA': 16,
  'USER32.DLL!PostMessageA': 16,
  'USER32.DLL!PostQuitMessage': 4,
  'USER32.DLL!GetMessageA': 16,
  'USER32.DLL!DispatchMessageA': 4,
  'USER32.DLL!DefWindowProcA': 16,
};

export const FIXTURE_MODULE_NAME = 'fixture.exe';
/** 挂载给 fixture 读取的文件路径与内容（C:\GAME\hello.txt = "HELLO"）。 */
export const FIXTURE_FILE_PATH = 'C:\\GAME\\hello.txt';
export const FIXTURE_FILE_BYTES = new Uint8Array([0x48, 0x45, 0x4c, 0x4c, 0x4f]);

const WM_USER = 0x0400;
const WM_APP = 0x8000;
const HEAP_ZERO_MEMORY = 0x8;
const MEM_COMMIT_RESERVE = 0x3000;
const PAGE_READWRITE = 0x4;
const MEM_RELEASE = 0x8000;
const GENERIC_READ = 0x8000_0000;
const OPEN_EXISTING = 3;
const WIN98_VERSION = 0x8000_0a04;
/** "HELL" 的小端 dword（_lread 全量读取校验）。 */
const HELLO_HEAD_DWORD = 0x4c4c_4548;

const REG = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 } as const;
type Reg32 = keyof typeof REG;

/** 极简 x86 发射器：只覆盖 fixture 程序用到的指令，跳转用 rel32 标签修补。 */
class X86Emitter {
  private bytes: number[] = [];
  private labels = new Map<string, number>();
  private rel32Fixups: Array<{ at: number; label: string }> = [];

  get length(): number {
    return this.bytes.length;
  }
  label(name: string): this {
    if (this.labels.has(name)) throw new Error(`重复标签: ${name}`);
    this.labels.set(name, this.bytes.length);
    return this;
  }
  labelOffset(name: string): number {
    const offset = this.labels.get(name);
    if (offset === undefined) throw new Error(`未知标签: ${name}`);
    return offset;
  }
  private u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  private u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }
  private u32(value: number): this {
    return this.u8(value)
      .u8(value >>> 8)
      .u8(value >>> 16)
      .u8(value >>> 24);
  }

  pushImm(value: number): this {
    return this.u8(0x68).u32(value);
  }
  pushReg(reg: Reg32): this {
    return this.u8(0x50 + REG[reg]);
  }
  callIat(slot: number): this {
    return this.u8(0xff).u8(0x15).u32(slot);
  }
  jmpIat(slot: number): this {
    return this.u8(0xff).u8(0x25).u32(slot);
  }
  movRegImm(reg: Reg32, value: number): this {
    return this.u8(0xb8 + REG[reg]).u32(value);
  }
  /** mov dst, src（89 /r，reg 字段 = src）。 */
  movRegReg(dst: Reg32, src: Reg32): this {
    return this.u8(0x89).u8(0xc0 | (REG[src] << 3) | REG[dst]);
  }
  testEaxEax(): this {
    return this.u8(0x85).u8(0xc0);
  }
  xorEaxEax(): this {
    return this.u8(0x31).u8(0xc0);
  }
  cmpEaxImm(value: number): this {
    // imm8 可表示的值用 83 /7 短形式，其余 3D imm32。
    if (value >= -0x80 && value <= 0x7f) return this.u8(0x83).u8(0xf8).u8(value);
    return this.u8(0x3d).u32(value);
  }
  cmpDwordAbsImm(address: number, value: number): this {
    return this.u8(0x81).u8(0x3d).u32(address).u32(value);
  }
  cmpByteAbsImm(address: number, value: number): this {
    return this.u8(0x80).u8(0x3d).u32(address).u8(value);
  }
  /** cmp dword [edi], imm32（81 3F）。 */
  cmpDwordEdiImm(value: number): this {
    return this.u8(0x81).u8(0x3f).u32(value);
  }
  /** cmp dword [esi], imm32（81 3E）。 */
  cmpDwordEsiImm(value: number): this {
    return this.u8(0x81).u8(0x3e).u32(value);
  }
  movDwordEdiImm(value: number): this {
    return this.u8(0xc7).u8(0x07).u32(value);
  }
  movDwordEsiImm(value: number): this {
    return this.u8(0xc7).u8(0x06).u32(value);
  }
  incDwordAbs(address: number): this {
    return this.u8(0xff).u8(0x05).u32(address);
  }
  addAbsEax(address: number): this {
    return this.u8(0x01).u8(0x05).u32(address);
  }
  movEaxEspPlus(offset: number): this {
    return this.u8(0x8b).u8(0x44).u8(0x24).u8(offset);
  }
  /** 条件跳转（0F 84 je / 85 jne / 82 jb / 83 jae …），rel32 后补。 */
  jcc(opcode: number, label: string): this {
    this.u8(0x0f).u8(opcode);
    this.rel32Fixups.push({ at: this.bytes.length, label });
    return this.u32(0);
  }
  je(label: string): this {
    return this.jcc(0x84, label);
  }
  jne(label: string): this {
    return this.jcc(0x85, label);
  }
  jz(label: string): this {
    return this.je(label);
  }
  jnz(label: string): this {
    return this.jne(label);
  }
  jmp(label: string): this {
    this.u8(0xe9);
    this.rel32Fixups.push({ at: this.bytes.length, label });
    return this.u32(0);
  }
  ret(popBytes: number): this {
    return this.u8(0xc2).u16(popBytes);
  }
  finalize(): Uint8Array {
    for (const fixup of this.rel32Fixups) {
      const target = this.labels.get(fixup.label);
      if (target === undefined) throw new Error(`跳转标签未定义: ${fixup.label}`);
      const relative = target - (fixup.at + 4);
      this.bytes[fixup.at] = relative & 0xff;
      this.bytes[fixup.at + 1] = (relative >>> 8) & 0xff;
      this.bytes[fixup.at + 2] = (relative >>> 16) & 0xff;
      this.bytes[fixup.at + 3] = (relative >>> 24) & 0xff;
    }
    return new Uint8Array(this.bytes);
  }
}

/** .data 段内容构造器：标签记录偏移，绝对地址由调用方按 dataBase 换算。 */
class DataBuilder {
  private bytes: number[] = [];
  private labels = new Map<string, number>();
  label(name: string): this {
    this.labels.set(name, this.bytes.length);
    return this;
  }
  offsetOf(name: string): number {
    const offset = this.labels.get(name);
    if (offset === undefined) throw new Error(`未知数据标签: ${name}`);
    return offset;
  }
  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }
  asciiz(value: string): this {
    for (let i = 0; i < value.length; i++) this.bytes.push(value.charCodeAt(i) & 0xff);
    this.bytes.push(0);
    return this;
  }
  reserve(count: number): this {
    for (let i = 0; i < count; i++) this.bytes.push(0);
    return this;
  }
  align(alignment: number): this {
    while (this.bytes.length % alignment) this.bytes.push(0);
    return this;
  }
  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export interface FixturePe {
  built: BuiltPe;
  abi: Record<string, number>;
}

/**
 * 两遍构造：第一遍用占位 IAT 地址发射（长度与最终一致），从 buildPe32
 * 拿到真实 IAT 布局后第二遍定稿。
 */
export function buildFixturePe(): FixturePe {
  const imports = [
    {
      dll: 'KERNEL32.dll',
      names: [
        'GetVersion',
        'GetCommandLineA',
        'lstrlenA',
        'HeapCreate',
        'HeapAlloc',
        'HeapFree',
        'VirtualAlloc',
        'VirtualFree',
        'InitializeCriticalSection',
        'EnterCriticalSection',
        'LeaveCriticalSection',
        'DeleteCriticalSection',
        '_lopen',
        '_lread',
        '_llseek',
        '_lclose',
        'CreateFileA',
        'GetLastError',
        'Sleep',
        'ExitProcess',
      ],
    },
    {
      dll: 'USER32.dll',
      names: [
        'RegisterClassA',
        'CreateWindowExA',
        'SendMessageA',
        'PostMessageA',
        'PostQuitMessage',
        'GetMessageA',
        'DispatchMessageA',
        'DefWindowProcA',
      ],
    },
  ];

  const emit = (iat: (key: string) => number): { text: Uint8Array; data: Uint8Array } => {
    const code = new X86Emitter();
    const data = new DataBuilder();

    // ── .data 布局 ──
    data.label('WNDCLASS').reserve(40);
    data.label('CLASS_NAME').asciiz('FIXTURE');
    data.label('WINDOW_TITLE').asciiz('Fixture');
    data.align(4);
    data.label('PATH_HELLO').asciiz(FIXTURE_FILE_PATH);
    data.label('PATH_MISSING').asciiz('C:\\GAME\\missing.bin');
    data.align(4);
    data.label('BUF').reserve(16);
    data.label('COUNTER').u32(0);
    data.label('WPARAM_SUM').u32(0);
    data.label('CS').reserve(24);
    data.label('MSG').reserve(28);

    const imageBase = 0x0040_0000;
    const textBase = imageBase + 0x1000; // buildPe32 按声明顺序从 0x1000 排 section
    const dataBase = imageBase + 0x2000;
    const D = (name: string): number => dataBase + data.offsetOf(name);

    const failCodes = new Set<number>();
    /** 每个失败点跳到独立 fail 块：push 步骤码后 ExitProcess，host 按退出码定位。 */
    const fail = (code: number): string => {
      failCodes.add(code);
      return `fail_${code}`;
    };
    const K = (name: string): number => iat(`KERNEL32.DLL!${name}`);
    const U = (name: string): number => iat(`USER32.DLL!${name}`);

    // ── 1. GetVersion() == Win98 ──
    code.callIat(K('GetVersion'));
    code.cmpEaxImm(WIN98_VERSION);
    code.jne(fail(1));

    // ── 2. GetCommandLineA() → lstrlenA == "fixture.exe".length ──
    code.callIat(K('GetCommandLineA'));
    code.pushReg('eax');
    code.callIat(K('lstrlenA'));
    code.cmpEaxImm(FIXTURE_MODULE_NAME.length);
    code.jne(fail(2));

    // ── 3. HeapCreate(0,0,0) → ebx=hHeap ──
    code.pushImm(0).pushImm(0).pushImm(0);
    code.callIat(K('HeapCreate'));
    code.testEaxEax();
    code.jz(fail(3));
    code.movRegReg('ebx', 'eax');

    // ── 4/5. HeapAlloc(hHeap, HEAP_ZERO_MEMORY, 64)：零初始化 + 写入回读 ──
    code.pushImm(64).pushImm(HEAP_ZERO_MEMORY).pushReg('ebx');
    code.callIat(K('HeapAlloc'));
    code.testEaxEax();
    code.jz(fail(4));
    code.movRegReg('edi', 'eax');
    code.cmpDwordEdiImm(0);
    code.jne(fail(5));
    code.movDwordEdiImm(0xdead_beef);
    code.cmpDwordEdiImm(0xdead_beef);
    code.jne(fail(5));

    // ── 6. HeapFree(hHeap, 0, ptr) == 1 ──
    code.pushReg('edi').pushImm(0).pushReg('ebx');
    code.callIat(K('HeapFree'));
    code.cmpEaxImm(1);
    code.jne(fail(6));

    // ── 7/8. VirtualAlloc(NULL, 0x1000, COMMIT|RESERVE, RW)：写入回读 ──
    code.pushImm(PAGE_READWRITE).pushImm(MEM_COMMIT_RESERVE).pushImm(0x1000).pushImm(0);
    code.callIat(K('VirtualAlloc'));
    code.testEaxEax();
    code.jz(fail(7));
    code.movRegReg('esi', 'eax');
    code.movDwordEsiImm(0x1234_5678);
    code.cmpDwordEsiImm(0x1234_5678);
    code.jne(fail(8));

    // ── 9. VirtualFree(base, 0, MEM_RELEASE) == 1 ──
    code.pushImm(MEM_RELEASE).pushImm(0).pushReg('esi');
    code.callIat(K('VirtualFree'));
    code.cmpEaxImm(1);
    code.jne(fail(9));

    // ── 10-13. CRITICAL_SECTION：init → LockCount=-1；enter×2 → Recursion=2；
    //    leave → 1；再 leave → LockCount 回 -1；delete。快速桩与 host 路径同断言。 ──
    code.pushImm(D('CS'));
    code.callIat(K('InitializeCriticalSection'));
    code.cmpDwordAbsImm(D('CS') + 4, 0xffff_ffff);
    code.jne(fail(10));
    code.pushImm(D('CS'));
    code.callIat(K('EnterCriticalSection'));
    code.pushImm(D('CS'));
    code.callIat(K('EnterCriticalSection'));
    code.cmpDwordAbsImm(D('CS') + 8, 2);
    code.jne(fail(11));
    code.pushImm(D('CS'));
    code.callIat(K('LeaveCriticalSection'));
    code.cmpDwordAbsImm(D('CS') + 8, 1);
    code.jne(fail(12));
    code.pushImm(D('CS'));
    code.callIat(K('LeaveCriticalSection'));
    code.cmpDwordAbsImm(D('CS') + 4, 0xffff_ffff);
    code.jne(fail(13));
    code.pushImm(D('CS'));
    code.callIat(K('DeleteCriticalSection'));

    // ── 14. _lopen("C:\GAME\hello.txt", OF_READ) → ebx=句柄 ──
    code.pushImm(0).pushImm(D('PATH_HELLO'));
    code.callIat(K('_lopen'));
    code.cmpEaxImm(-1);
    code.je(fail(14));
    code.movRegReg('ebx', 'eax');

    // ── 15/16. _lread 全量 5 字节 == "HELLO" ──
    code.pushImm(5).pushImm(D('BUF')).pushReg('ebx');
    code.callIat(K('_lread'));
    code.cmpEaxImm(5);
    code.jne(fail(15));
    code.cmpDwordAbsImm(D('BUF'), HELLO_HEAD_DWORD);
    code.jne(fail(16));
    code.cmpByteAbsImm(D('BUF') + 4, 0x4f); // 'O'
    code.jne(fail(16));

    // ── 17. _llseek(1, FILE_BEGIN) == 1；再读 1 字节 == 'E'（镜像位置同步） ──
    code.pushImm(0).pushImm(1).pushReg('ebx');
    code.callIat(K('_llseek'));
    code.cmpEaxImm(1);
    code.jne(fail(17));
    code.pushImm(1).pushImm(D('BUF')).pushReg('ebx');
    code.callIat(K('_lread'));
    code.cmpEaxImm(1);
    code.jne(fail(17));
    code.cmpByteAbsImm(D('BUF'), 0x45); // 'E'
    code.jne(fail(17));

    // ── 18. _lclose == 0 ──
    code.pushReg('ebx');
    code.callIat(K('_lclose'));
    code.testEaxEax();
    code.jnz(fail(18));

    // ── 19/20. CreateFileA(missing, GENERIC_READ, …, OPEN_EXISTING) == -1，
    //    GetLastError == ERROR_FILE_NOT_FOUND ──
    code
      .pushImm(0)
      .pushImm(0)
      .pushImm(OPEN_EXISTING)
      .pushImm(0)
      .pushImm(0)
      .pushImm(GENERIC_READ)
      .pushImm(D('PATH_MISSING'));
    code.callIat(K('CreateFileA'));
    code.cmpEaxImm(-1);
    code.jne(fail(19));
    code.callIat(K('GetLastError'));
    code.cmpEaxImm(2);
    code.jne(fail(20));

    // ── 21. RegisterClassA(&WNDCLASS) != 0 ──
    code.pushImm(D('WNDCLASS'));
    code.callIat(U('RegisterClassA'));
    code.testEaxEax();
    code.jz(fail(21));

    // ── 22. CreateWindowExA(0, "FIXTURE", "Fixture", 0, 0,0,100,100, 0,0,0,0) → ebx=hwnd ──
    code
      .pushImm(0)
      .pushImm(0)
      .pushImm(0)
      .pushImm(0)
      .pushImm(100)
      .pushImm(100)
      .pushImm(0)
      .pushImm(0)
      .pushImm(0)
      .pushImm(D('WINDOW_TITLE'))
      .pushImm(D('CLASS_NAME'))
      .pushImm(0);
    code.callIat(U('CreateWindowExA'));
    code.testEaxEax();
    code.jz(fail(22));
    code.movRegReg('ebx', 'eax');

    // ── 23. SendMessageA(hwnd, WM_APP, 5, 0)：WndProc 同步回调返回 0x42 ──
    code.pushImm(0).pushImm(5).pushImm(WM_APP).pushReg('ebx');
    code.callIat(U('SendMessageA'));
    code.cmpEaxImm(0x42);
    code.jne(fail(23));

    // ── 24. SendMessageA(hwnd, WM_APP+1, 0, 0)：WndProc 尾调用 DefWindowProcA → 0 ──
    code
      .pushImm(0)
      .pushImm(0)
      .pushImm(WM_APP + 1)
      .pushReg('ebx');
    code.callIat(U('SendMessageA'));
    code.testEaxEax();
    code.jnz(fail(24));

    // ── 25. PostMessageA(hwnd, WM_USER, 0x11, 0) × 3，再 PostQuitMessage(0) ──
    for (let i = 0; i < 3; i++) {
      code.pushImm(0).pushImm(0x11).pushImm(WM_USER).pushReg('ebx');
      code.callIat(U('PostMessageA'));
      code.testEaxEax();
      code.jz(fail(25));
    }
    code.pushImm(0);
    code.callIat(U('PostQuitMessage'));

    // ── 消息泵：GetMessageA 返回 0（WM_QUIT）时退出 ──
    code.label('msg_loop');
    code.pushImm(0).pushImm(0).pushImm(0).pushImm(D('MSG'));
    code.callIat(U('GetMessageA'));
    code.testEaxEax();
    code.jz('msg_done');
    code.pushImm(D('MSG'));
    code.callIat(U('DispatchMessageA'));
    code.jmp('msg_loop');
    code.label('msg_done');

    // ── 26/27. WndProc 计数校验：3 条 WM_USER，wParam 累计 0x11×3 ──
    code.cmpDwordAbsImm(D('COUNTER'), 3);
    code.jne(fail(26));
    code.cmpDwordAbsImm(D('WPARAM_SUM'), 0x33);
    code.jne(fail(27));

    // ── 28. Sleep(1)：host delayMs 挂起/唤醒路径 ──
    code.pushImm(1);
    code.callIat(K('Sleep'));

    // ── 成功 ──
    code.pushImm(0);
    code.callIat(K('ExitProcess'));

    // ── 失败块：ExitProcess(步骤码) ──
    for (const code_ of [...failCodes].sort((a, b) => a - b)) {
      code.label(`fail_${code_}`);
      code.pushImm(code_);
      code.callIat(K('ExitProcess'));
    }

    // ── WndProc(hwnd, msg, wParam, lParam)，stdcall ──
    code.label('wndproc');
    code.movEaxEspPlus(8); // msg
    code.cmpEaxImm(WM_USER);
    code.jne('wndproc_not_user');
    code.incDwordAbs(D('COUNTER'));
    code.movEaxEspPlus(12); // wParam
    code.addAbsEax(D('WPARAM_SUM'));
    code.xorEaxEax();
    code.ret(16);
    code.label('wndproc_not_user');
    code.cmpEaxImm(WM_APP);
    code.jne('wndproc_default');
    code.movRegImm('eax', 0x42);
    code.ret(16);
    code.label('wndproc_default');
    // 参数已在栈上且顺序一致：尾调用 DefWindowProcA，由它的 ret 16 一并清理。
    code.jmpIat(U('DefWindowProcA'));

    const text = code.finalize();

    // WNDCLASSA：+4 lpfnWndProc，+36 lpszClassName；其余字段为 0。
    const wndclass = data.toBytes().slice();
    const wndprocAddress = textBase + code.labelOffset('wndproc');
    const classNameAddress = D('CLASS_NAME');
    wndclass.set(
      [
        wndprocAddress & 0xff,
        (wndprocAddress >>> 8) & 0xff,
        (wndprocAddress >>> 16) & 0xff,
        (wndprocAddress >>> 24) & 0xff,
      ],
      4,
    );
    wndclass.set(
      [
        classNameAddress & 0xff,
        (classNameAddress >>> 8) & 0xff,
        (classNameAddress >>> 16) & 0xff,
        (classNameAddress >>> 24) & 0xff,
      ],
      36,
    );
    return { text, data: wndclass };
  };

  const placeholder = emit(() => 0);
  const first = buildPe32({
    entryRva: 0x1000,
    sections: [
      { name: '.text', data: placeholder.text, characteristics: 0x6000_0020 },
      { name: '.data', data: placeholder.data, characteristics: 0xc000_0040 },
    ],
    imports,
  });
  const resolved = emit((key) => {
    const slot = first.iat.get(key);
    if (slot === undefined) throw new Error(`IAT 槽缺失: ${key}`);
    return slot;
  });
  if (resolved.text.length !== placeholder.text.length || resolved.data.length !== placeholder.data.length) {
    throw new Error('fixture 两遍发射长度不一致（IAT 地址必须总是 imm32）');
  }
  const built = buildPe32({
    entryRva: 0x1000,
    sections: [
      { name: '.text', data: resolved.text, characteristics: 0x6000_0020 },
      { name: '.data', data: resolved.data, characteristics: 0xc000_0040 },
    ],
    imports,
  });
  // 数据地址在发射时按固定 RVA 烘焙；section 排布若漂移必须在这里炸出来。
  if (built.sectionRva['.text'] !== 0x1000 || built.sectionRva['.data'] !== 0x2000) {
    throw new Error(`fixture section 布局假设被破坏: ${JSON.stringify(built.sectionRva)}`);
  }
  return { built, abi: FIXTURE_ABI };
}
