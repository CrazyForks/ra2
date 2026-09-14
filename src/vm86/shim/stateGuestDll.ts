/**
 * 随游戏提供的客体 DLL 的装载与桥接（mixin 拆分自 state.ts）：
 * PE 映像装载、IAT 重定向、动态导入登记与原版 Bink 线程固定。
 * 挂在文件层之后，kernel32/win32 分派之前。
 */
import type { PeImport, Win32Call } from '../win32';
import { normalizeGuestPath } from '../paths';
import { GUEST_THREAD_CRITICAL_DEPTH, HYPERCALL_THREAD_CURRENT, makeImportStub } from '../pe';
import type { Constructor, LoadedGuestDll } from './state';
import type { ShimFilesChain } from './stateFiles';

export type ShimGuestDllChain = InstanceType<ReturnType<typeof withShimGuestDll>>;

export function withShimGuestDll<TBase extends Constructor<ShimFilesChain>>(Base: TBase) {
  return class extends Base {
    protected readonly dynamicImports = new Map<number, PeImport>();
    /** 原生 Bink 实例期间已从 hypercall 桩改成直跳客体 DLL 的入口，以及被覆盖的
     *  原始入口字节。主程序会缓存静态 IAT 中的函数地址，所以这里不能只处理
     *  GetProcAddress 动态桩；Close 时也必须逐字节恢复原入口。 */
    protected readonly directGuestDllImportStubs = new Map<PeImport, Uint8Array>();
    protected readonly vtables = new Map<string, number>();
    protected readonly loadedGuestDlls = new Map<string, LoadedGuestDll>();

    resolveDynamicImport(id: number): PeImport | undefined {
      return this.dynamicImports.get(id);
    }

    protected loadGuestDll(name: string): LoadedGuestDll | null {
      const normalized = normalizeGuestPath(name);
      const cached = this.loadedGuestDlls.get(normalized);
      if (cached) return cached;
      const file = this.files.get(normalized);
      const argBytesOf = this.options.importArgBytes;
      if (!file || !argBytesOf) return null;
      const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
      if (file.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) return null;
      const pe = dv.getUint32(0x3c, true);
      if (pe + 24 > file.length || dv.getUint32(pe, true) !== 0x0000_4550) return null;
      const sections = dv.getUint16(pe + 6, true);
      const optionalSize = dv.getUint16(pe + 20, true);
      const opt = pe + 24;
      const sectionTable = opt + optionalSize;
      const base = dv.getUint32(opt + 28, true);
      const size = dv.getUint32(opt + 56, true);
      const headers = Math.min(dv.getUint32(opt + 60, true), file.length);
      const image = new Uint8Array(size);
      image.set(file.subarray(0, headers));
      for (let i = 0; i < sections; i++) {
        const section = sectionTable + i * 40;
        const rva = dv.getUint32(section + 12, true);
        const rawSize = dv.getUint32(section + 16, true);
        const raw = dv.getUint32(section + 20, true);
        if (rawSize && raw + rawSize <= file.length && rva + rawSize <= image.length) {
          image.set(file.subarray(raw, raw + rawSize), rva);
        }
      }
      const rawOf = (rva: number): number => guestDllRvaToRaw(dv, file.length, opt, sectionTable, sections, rva);
      const importRva = dv.getUint32(opt + 104, true);
      const imports: Array<{ dll: string; name: string; iat: number; argBytes: number }> = [];
      const missingImports: string[] = [];
      for (let descriptor = importRva ? rawOf(importRva) : -1; descriptor >= 0; descriptor += 20) {
        const originalThunk = dv.getUint32(descriptor, true);
        const dllNameRva = dv.getUint32(descriptor + 12, true);
        const firstThunk = dv.getUint32(descriptor + 16, true);
        if (!dllNameRva && !firstThunk) break;
        const dll = readGuestDllCString(file, rawOf(dllNameRva)).toUpperCase();
        for (let index = 0; index < 4096; index++) {
          const thunk = dv.getUint32(rawOf((originalThunk || firstThunk) + index * 4), true);
          if (!thunk) break;
          const importName =
            (thunk & 0x8000_0000) !== 0 ? `ord${thunk & 0xffff}` : readGuestDllCString(file, rawOf(thunk + 2));
          try {
            imports.push({
              dll,
              name: importName,
              iat: firstThunk + index * 4,
              argBytes: argBytesOf(dll, importName),
            });
          } catch {
            missingImports.push(`${dll}!${importName}`);
          }
        }
      }
      if (missingImports.length) {
        throw new Error(`${name} 客体 DLL 依赖未登记 ABI: ${missingImports.join(', ')}`);
      }
      for (const imported of imports) {
        const stub = this.registerDynamicWin32Import(imported.dll, imported.name, imported.argBytes);
        putGuestDllU32(image, imported.iat, stub);
      }
      for (const patch of this.gameProfile.guestDllPatches?.[normalized] ?? []) {
        if (
          patch.expected.length !== patch.replacement.length ||
          patch.rva < 0 ||
          patch.rva + patch.expected.length > image.length
        ) {
          console.warn(`[VM DLL] ${normalized} 补丁范围无效 @0x${patch.rva.toString(16)}`);
          return null;
        }
        const current = image.subarray(patch.rva, patch.rva + patch.expected.length);
        if (!current.every((byte, index) => byte === patch.expected[index])) {
          console.warn(`[VM DLL] ${normalized} 补丁签名不匹配 @0x${patch.rva.toString(16)}`);
          return null;
        }
        image.set(patch.replacement, patch.rva);
      }
      const exports = new Map<string, number>();
      const exportRva = dv.getUint32(opt + 96, true);
      if (exportRva) {
        const directory = rawOf(exportRva);
        const ordinalBase = dv.getUint32(directory + 16, true);
        const functionCount = dv.getUint32(directory + 20, true);
        const nameCount = dv.getUint32(directory + 24, true);
        const functions = rawOf(dv.getUint32(directory + 28, true));
        const names = rawOf(dv.getUint32(directory + 32, true));
        const ordinals = rawOf(dv.getUint32(directory + 36, true));
        for (let i = 0; i < functionCount; i++) {
          const address = base + dv.getUint32(functions + i * 4, true);
          exports.set(`ord${ordinalBase + i}`, address);
        }
        for (let i = 0; i < nameCount; i++) {
          const exportName = readGuestDllCString(file, rawOf(dv.getUint32(names + i * 4, true)));
          const ordinal = dv.getUint16(ordinals + i * 2, true);
          exports.set(exportName, base + dv.getUint32(functions + ordinal * 4, true));
        }
      }
      this.memory.write_memory(image, base);
      const loaded: LoadedGuestDll = {
        name: normalized,
        base,
        size: image.length,
        entry: base + dv.getUint32(opt + 16, true),
        initialized: false,
        exports,
      };
      this.loadedGuestDlls.set(normalized, loaded);
      return loaded;
    }

    protected guestDllByHandle(handle: number): LoadedGuestDll | undefined {
      return [...this.loadedGuestDlls.values()].find((module) => module.base === handle >>> 0);
    }

    /**
     * 在主 EXE 入口前初始化随游戏提供的 DLL，并把主模块静态 IAT 统一改为真实导出。
     * 这样函数指针参数（BinkSetSoundSystem → BinkOpenDirectSound）也不会残留 hypercall 桩。
     */
    linkGuestDllBeforeEntry(name: string, entry: number, imports: PeImport[]): number {
      const module = this.loadGuestDll(name);
      if (!module) return entry;
      const dll = name.toLowerCase();
      const targets = imports.filter((imported) => imported.dll.toLowerCase() === dll);
      for (const imported of targets) {
        const target = module.exports.get(imported.name);
        if (!target) throw new Error(`${name} 缺少主程序所需导出 ${imported.name}`);
        this.writeU32(imported.slot, target);
      }
      return this.initializeLoadedGuestDllBeforeEntry(module, entry);
    }

    /**
     * 只在主 EXE 入口前完成客体 DLL 的 PROCESS_ATTACH，不改写主模块 IAT。
     * Bink 需要这个模式：CRT/DirectSound 全局状态应在菜单回调与客体线程出现前
     * 建好，但 Open/Close/逐帧 API 仍必须经过 host 做文件完整性和原子调用决策。
     */
    initializeGuestDllBeforeEntry(name: string, entry: number): number {
      const module = this.loadGuestDll(name);
      return module ? this.initializeLoadedGuestDllBeforeEntry(module, entry) : entry;
    }

    private initializeLoadedGuestDllBeforeEntry(module: LoadedGuestDll, entry: number): number {
      if (!module.entry || module.initialized) return entry;
      module.initialized = true;
      const code: number[] = [];
      const emit32 = (value: number) =>
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      const push = (value: number) => {
        code.push(0x68);
        emit32(value);
      };
      push(0);
      push(1); // DLL_PROCESS_ATTACH
      push(module.base);
      code.push(0xb8);
      emit32(module.entry);
      code.push(0xff, 0xd0); // call DllMainCRTStartup
      code.push(0x85, 0xc0, 0x75, 0x02, 0xcc, 0xf4); // FALSE → INT3 后停机
      code.push(0xb8);
      emit32(entry);
      code.push(0xff, 0xe0); // jmp 主 EXE 入口，保留 boot 的原返回地址
      return this.allocateDynamicCode(code);
    }

    /**
     * 静态 IAT 已被 hypercall 桩接管时，把原调用桥回随游戏提供的客体 DLL。
     * import stub 执行 `ret n` 后参数仍留在旧栈地址，桥按原顺序重新压栈调用导出。
     */
    protected redirectGuestDllExport(
      call: Win32Call,
      dll: string,
      exportName: string,
      atomicGuestCall = false,
    ): boolean {
      const module = this.loadGuestDll(dll);
      const target = module?.exports.get(exportName);
      if (!module || !target) return false;
      const originalReturn = this.readU32(call.stack);
      const argumentCount = call.imported.argBytes >>> 2;
      const code: number[] = [];
      const emit32 = (value: number) =>
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      const push = (value: number) => {
        code.push(0x68);
        emit32(value);
      };
      // 先复制原参数；DllMain 的三次 push 会复用 import stub 已弹掉的旧参数区。
      for (let index = argumentCount; index >= 1; index--) {
        code.push(0xff, 0x35);
        emit32(call.stack + index * 4); // push dword [addr]
      }
      if (atomicGuestCall) {
        code.push(0xfa); // cli
        code.push(0x8b, 0x0d);
        emit32(HYPERCALL_THREAD_CURRENT);
        code.push(0xff, 0x04, 0x8d);
        emit32(GUEST_THREAD_CRITICAL_DEPTH);
      }
      if (!module.initialized && module.entry) {
        module.initialized = true;
        push(0);
        push(1); // DLL_PROCESS_ATTACH
        push(module.base);
        code.push(0xb8);
        emit32(module.entry);
        code.push(0xff, 0xd0); // call DllMainCRTStartup
      }
      code.push(0xb8);
      emit32(target);
      code.push(0xff, 0xd0); // call export（Bink 导出均为 stdcall）
      if (atomicGuestCall) {
        code.push(0x89, 0xc2); // mov edx,eax
        code.push(0x8b, 0x0d);
        emit32(HYPERCALL_THREAD_CURRENT);
        code.push(0xff, 0x0c, 0x8d);
        emit32(GUEST_THREAD_CRITICAL_DEPTH);
        code.push(0x83, 0x3c, 0x8d);
        emit32(GUEST_THREAD_CRITICAL_DEPTH);
        code.push(0x00);
        code.push(0x75, 0x09); // 外层仍持锁则保持 CLI，跳到 lockedReturn
        code.push(0x89, 0xd0); // mov eax,edx
        push(originalReturn);
        // STI 只保证紧随其后的一条指令不会被中断；必须让那条指令就是 RET。
        // 旧序列在 STI 后还恢复寄存器/装载跳转地址，浏览器 Worker 的真实 PIT
        // 会在桥接器中间抢占，把尚未回到调用方的 ESP/EIP 保存成线程上下文。
        code.push(0xfb, 0xc3); // sti; ret
        code.push(0x89, 0xd0); // lockedReturn: mov eax,edx
        push(originalReturn);
        code.push(0xc3); // ret（外层锁仍保持 CLI）
        this.writeU32(call.stack, this.allocateDynamicCode(code));
        return true;
      }
      code.push(0xb9);
      emit32(originalReturn);
      code.push(0xff, 0xe1); // jmp original return，保留导出返回的 EAX
      this.writeU32(call.stack, this.allocateDynamicCode(code));
      return true;
    }

    /** 在原生 DLL 的一个实例存活期间，把主模块的高频 IAT 直接指到客体导出。
     * 关闭实例前恢复 hypercall stub，下一次 Open 才能重新执行完整/稀疏文件决策。 */
    protected routeStaticGuestDllExports(dll: string, exportNames: ReadonlySet<string>, direct: boolean): void {
      const module = direct ? this.loadGuestDll(dll) : undefined;
      const normalizedDll = dll.toLowerCase();
      for (const imported of this.staticImports) {
        if (imported.dll.toLowerCase() !== normalizedDll || !exportNames.has(imported.name)) continue;
        const target = module?.exports.get(imported.name);
        this.writeU32(imported.slot, direct && target ? target : imported.stub);
      }
    }

    /** GetProcAddress 或静态 IAT 旧缓存留下的桩都要直达 DLL；否则 BinkWait 的自旋
     * 会继续以每秒上万次串口 hypercall 运行，音频时钟被拖住、影片无法结束。
     * 只覆盖七字节 `mov eax,target; jmp eax`，Close 前原样恢复这七字节。 */
    protected routeDynamicGuestDllExport(call: Win32Call, dll: string, exportName: string): void {
      if (call.imported.dll.toLowerCase() !== dll.toLowerCase()) return;
      const target = this.loadGuestDll(dll)?.exports.get(exportName);
      if (!target) return;
      if (!this.directGuestDllImportStubs.has(call.imported)) {
        this.directGuestDllImportStubs.set(call.imported, this.memory.read_memory(call.imported.stub, 7).slice());
      }
      this.memory.write_memory(
        [0xb8, target & 0xff, (target >>> 8) & 0xff, (target >>> 16) & 0xff, target >>> 24, 0xff, 0xe0],
        call.imported.stub,
      );
    }

    protected restoreDynamicGuestDllExports(dll: string): void {
      for (const [imported, originalBytes] of [...this.directGuestDllImportStubs]) {
        if (imported.dll.toLowerCase() !== dll.toLowerCase()) continue;
        this.memory.write_memory(originalBytes, imported.stub);
        this.directGuestDllImportStubs.delete(imported);
      }
    }

    protected pinNativeBinkThread(): void {
      if (this.nativeBinkPinnedThread !== null) return;
      const thread = this.readU32(HYPERCALL_THREAD_CURRENT);
      const depthAddress = GUEST_THREAD_CRITICAL_DEPTH + thread * 4;
      this.writeU32(depthAddress, this.readU32(depthAddress) + 1);
      this.nativeBinkPinnedThread = thread;
    }

    protected releaseNativeBinkThread(): void {
      const thread = this.nativeBinkPinnedThread;
      if (thread === null) return;
      const depthAddress = GUEST_THREAD_CRITICAL_DEPTH + thread * 4;
      const depth = this.readU32(depthAddress);
      this.writeU32(depthAddress, depth > 0 ? depth - 1 : 0);
      this.nativeBinkPinnedThread = null;
    }

    protected registerDynamicWin32Import(dll: string, name: string, argBytes: number): number {
      const id = this.nextDynamicId++;
      const stubBytes = this.options.dynamicImportStub?.(dll, name, id, argBytes) ?? makeImportStub(id, argBytes);
      const stub = this.allocateDynamicCode(stubBytes);
      this.dynamicImports.set(id, {
        id,
        dll,
        name,
        key: `${dll}!${name}`,
        slot: 0,
        stub,
        argBytes,
      });
      return stub;
    }
  };
}

function guestDllRvaToRaw(
  dv: DataView,
  fileLength: number,
  opt: number,
  sectionTable: number,
  sections: number,
  rva: number,
): number {
  if (rva < dv.getUint32(opt + 60, true)) return rva;
  for (let i = 0; i < sections; i++) {
    const section = sectionTable + i * 40;
    const virtual = dv.getUint32(section + 12, true);
    const size = Math.max(dv.getUint32(section + 8, true), dv.getUint32(section + 16, true));
    if (rva >= virtual && rva < virtual + size) {
      const raw = dv.getUint32(section + 20, true) + rva - virtual;
      if (raw < fileLength) return raw;
    }
  }
  throw new Error(`来宾 DLL RVA 无效: 0x${rva.toString(16)}`);
}

function readGuestDllCString(bytes: Uint8Array, offset: number): string {
  let value = '';
  for (let i = offset; i < bytes.length && bytes[i]; i++) value += String.fromCharCode(bytes[i]!);
  return value;
}

function putGuestDllU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = value >>> 24;
}
