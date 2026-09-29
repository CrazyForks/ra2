/**
 * Loading bundled guest DLLs: PE loading, static IAT linking, initialization, and dynamic imports. Apply after file state and before kernel32/win32 dispatch.
 */
import type { PeImport } from '../win32';
import { normalizeGuestPath } from '../paths';
import { makeImportStub } from '../pe';
import type { Constructor, LoadedGuestDll } from './state';
import type { ShimFilesChain } from './stateFiles';

export type ShimGuestDllChain = InstanceType<ReturnType<typeof withShimGuestDll>>;

export function withShimGuestDll<TBase extends Constructor<ShimFilesChain>>(Base: TBase) {
  return class extends Base {
    protected readonly dynamicImports = new Map<number, PeImport>();
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
     * Initialize bundled DLLs before the main EXE entry and replace its static IAT with actual exports. Imported function addresses passed as callbacks must point to the same guest exports, not host import stubs.
     */
    linkGuestDllBeforeEntry(name: string, entry: number, imports: PeImport[]): number {
      const module = this.loadGuestDll(name);
      if (!module) throw new Error(`Required guest DLL could not be loaded: ${name}`);
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
     * Perform guest DLL PROCESS_ATTACH before the main EXE entry without rewriting its IAT.
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
      code.push(0x85, 0xc0, 0x75, 0x02, 0xcc, 0xf4); // FALSE triggers INT3, then halt.
      code.push(0xb8);
      emit32(entry);
      code.push(0xff, 0xe0); // Jump to the main EXE entry, preserving boot's original return address.
      return this.allocateDynamicCode(code);
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
