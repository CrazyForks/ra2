import type { Win32Call, Win32Result } from '../win32';
import { fourCc, readBytesU32 } from './text';
import { normalizeGuestPath } from '../paths';
import { withUser32 } from './user32';
import { shimTraceEnabled } from './state';
import type { Constructor } from './state';

type User32Chain = InstanceType<ReturnType<typeof withUser32>>;

/** Winmm Win32 API cases extracted from Win32Shim.dispatch's main switch. */
export function withWinmm<TBase extends Constructor<User32Chain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    dispatchWinmm(call: Win32Call, key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'WINMM.DLL!timeGetTime':
          return { eax: this.clock.now() >>> 0 };
        case 'WINMM.DLL!timeGetDevCaps':
          if (a[0] && (a[1] ?? 0) >= 8) {
            this.writeU32(a[0], 1); // wPeriodMin
            this.writeU32(a[0] + 4, 1000); // wPeriodMax
          }
          return { eax: 0 }; // TIMERR_NOERROR
        case 'WINMM.DLL!mmioOpenA':
          return { eax: this.mmioOpen(a[0] ?? 0) };
        case 'WINMM.DLL!mmioDescend':
          return { eax: this.mmioDescend(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
        case 'WINMM.DLL!mmioAscend':
          return { eax: this.mmioAscend(a[0] ?? 0, a[1] ?? 0) };
        case 'WINMM.DLL!mmioRead':
          return { eax: this.mmioRead(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) >>> 0 };
        case 'WINMM.DLL!mmioClose':
          return { eax: this.mmioHandles.delete(a[0] ?? 0) ? 0 : 5 };
        case 'WINMM.DLL!timeBeginPeriod':
        case 'WINMM.DLL!timeEndPeriod':
          return { eax: 0 };
        case 'WINMM.DLL!timeKillEvent': {
          const removed = this.multimediaTimers.delete(a[0] ?? 0);
          this.invalidateFastPeek();
          return { eax: removed ? 0 : 97 }; // TIMERR_NOERROR/NOCANDO
        }
        case 'WINMM.DLL!timeSetEvent': {
          const id = this.nextMultimediaTimer++;
          const interval = Math.max(1, a[0] || 1);
          if (shimTraceEnabled('VM_TRACE_TIMER'))
            console.log(
              `⏲️ timeSetEvent id=${id} interval=${interval} callback=0x${(a[2] ?? 0).toString(16)} periodic=${((a[4] ?? 0) & 1) !== 0}`,
            );
          this.multimediaTimers.set(id, {
            id,
            interval,
            callback: a[2] ?? 0,
            user: a[3] ?? 0,
            periodic: ((a[4] ?? 0) & 1) !== 0,
            next: this.clock.now() + interval,
          });
          this.invalidateFastPeek();
          return { eax: id };
        }
        case 'WINMM.DLL!waveOutOpen':
          if (a[0]) this.writeU32(a[0], 1);
          return { eax: 0 };
        case 'WINMM.DLL!waveOutPrepareHeader':
          if (a[1]) this.writeU32(a[1] + 16, this.readU32(a[1] + 16) | 0x2); // WHDR_PREPARED
          return { eax: 0 };
        case 'WINMM.DLL!waveOutWrite':
          if (a[1]) this.writeU32(a[1] + 16, (this.readU32(a[1] + 16) & ~0x10) | 0x1); // WHDR_DONE
          return { eax: 0 };
        case 'WINMM.DLL!waveOutUnprepareHeader':
          if (a[1]) this.writeU32(a[1] + 16, this.readU32(a[1] + 16) & ~0x2);
          return { eax: 0 };
        case 'WINMM.DLL!waveOutRestart':
        case 'WINMM.DLL!waveOutSetVolume':
        case 'WINMM.DLL!waveOutPause':
        case 'WINMM.DLL!waveOutReset':
        case 'WINMM.DLL!waveOutClose':
          return { eax: 0 };
        case 'WINMM.DLL!mciSendCommandA': {
          const command = a[1] ?? 0;
          const params = a[3] ?? 0;
          if (command === 0x0803 && params) {
            // MCI_OPEN
            this.writeU32(params + 4, 1); // wDeviceID
          } else if (command === 0x0814 && params) {
            // MCI_STATUS
            const item = this.readU32(params + 8);
            // MCI_STATUS_MODE reports the intro stopped; position/length return 0.
            this.writeU32(params + 4, item === 4 ? 525 : 0); // MCI_MODE_STOP
          }
          return { eax: 0 };
        }
        case 'ADVAPI32.DLL!RegOpenKeyA':
        case 'ADVAPI32.DLL!RegOpenKeyExA': {
          const out = key.endsWith('RegOpenKeyA') ? (a[2] ?? 0) : (a[4] ?? 0);
          const parent = this.registryPath(a[0] ?? 0);
          const child = this.readCString(a[1] ?? 0)
            .replace(/[\\/]+/g, '\\')
            .toLowerCase();
          const handle = this.nextRegistryHandle++;
          this.registryHandles.set(handle, parent && child ? `${parent}\\${child}` : parent || child);
          if (shimTraceEnabled('VM_TRACE_REGISTRY')) {
            console.log(`🗂️ RegOpen ${parent}\\${child} -> 0x${handle.toString(16)}`);
          }
          if (out) this.writeU32(out, handle);
          return { eax: 0 };
        }
        case 'ADVAPI32.DLL!RegCreateKeyExA': {
          const parent = this.registryPath(a[0] ?? 0);
          const child = this.readCString(a[1] ?? 0)
            .replace(/[\\/]+/g, '\\')
            .toLowerCase();
          const handle = this.nextRegistryHandle++;
          this.registryHandles.set(handle, parent && child ? `${parent}\\${child}` : parent || child);
          if (shimTraceEnabled('VM_TRACE_REGISTRY')) {
            console.log(`🗂️ RegCreate ${parent}\\${child} -> 0x${handle.toString(16)}`);
          }
          if (a[7]) this.writeU32(a[7], handle);
          if (a[8]) this.writeU32(a[8], 1); // REG_CREATED_NEW_KEY
          return { eax: 0 };
        }
        case 'ADVAPI32.DLL!RegQueryValueExA': {
          const path = this.registryPath(a[0] ?? 0);
          const valueName = this.readCString(a[1] ?? 0).toLowerCase();
          const id = `${path}\\${valueName}`;
          let data = this.registryValues.get(id);
          let type = 1; // REG_SZ
          // Lightweight XWIS packages lack installer registry entries; map the single-player installation directory to virtual C:\\GAME.
          if (!data && (valueName === 'installpath' || valueName === 'path')) {
            data = Uint8Array.from([...new TextEncoder().encode('C:\\GAME'), 0]);
          }
          let profileDefault = this.gameProfile.registryDefaults?.[id];
          if (!data && !profileDefault && this.gameProfile.registrySessionDefaults?.[id]) {
            profileDefault = this.registrySessionDefaults.get(id);
            if (!profileDefault) {
              profileDefault = this.gameProfile.registrySessionDefaults[id]!();
              this.registrySessionDefaults.set(id, profileDefault);
            }
          }
          if (!data && profileDefault) {
            data = Uint8Array.from(profileDefault.bytes);
            type = profileDefault.type;
          }
          if (shimTraceEnabled('VM_TRACE_REGISTRY')) {
            console.log(`🗂️ RegQuery ${id} -> ${data ? new TextDecoder().decode(data) : 'NOT_FOUND'}`);
          }
          if (!data) return { eax: 2 }; // ERROR_FILE_NOT_FOUND lets the game use defaults.
          if (a[3]) this.writeU32(a[3], type);
          const capacity = a[5] ? this.readU32(a[5]) : 0;
          if (a[5]) this.writeU32(a[5], data.length);
          if (!a[4]) return { eax: 0 };
          if (capacity < data.length) return { eax: 234 }; // ERROR_MORE_DATA
          this.memory.write_memory(data, a[4]);
          return { eax: 0 };
        }
        case 'ADVAPI32.DLL!RegSetValueExA': {
          const path = this.registryPath(a[0] ?? 0);
          const valueName = this.readCString(a[1] ?? 0).toLowerCase();
          const data = this.readBytes(a[4] ?? 0, a[5] ?? 0).slice();
          if (shimTraceEnabled('VM_TRACE_REGISTRY')) {
            console.log(`🗂️ RegSet ${path}\\${valueName} <- ${new TextDecoder().decode(data)}`);
          }
          this.registryValues.set(`${path}\\${valueName}`, data);
          return { eax: 0 };
        }
        case 'ADVAPI32.DLL!RegDeleteValueA':
          this.registryValues.delete(`${this.registryPath(a[0] ?? 0)}\\${this.readCString(a[1] ?? 0).toLowerCase()}`);
          return { eax: 0 };
        case 'ADVAPI32.DLL!RegDeleteKeyA':
          return { eax: 0 };
        case 'ADVAPI32.DLL!RegEnumKeyExA':
          return { eax: 259 }; // ERROR_NO_MORE_ITEMS
        case 'ADVAPI32.DLL!RegQueryInfoKeyA':
          for (const ptr of [a[2], a[4], a[5], a[6], a[7], a[8], a[9], a[10]]) if (ptr) this.writeU32(ptr, 0);
          return { eax: 0 };
        case 'ADVAPI32.DLL!RegCloseKey':
          this.registryHandles.delete(a[0] ?? 0);
          return { eax: 0 };
        case 'MSVFW32.DLL!MCIWndCreateA':
          return { eax: this.createMciWindow(call) };
        default:
          void name;
          return null;
      }
    }
    protected registryPath(handle: number): string {
      const roots: Record<number, string> = {
        0x80000000: 'hkcr',
        0x80000001: 'hkcu',
        0x80000002: 'hklm',
        0x80000003: 'hku',
      };
      return this.registryHandles.get(handle) ?? roots[handle >>> 0] ?? `handle:${handle >>> 0}`;
    }
    protected mmioOpen(pathPtr: number): number {
      const path = normalizeGuestPath(this.readCString(pathPtr));
      const bytes = this.files.get(path);
      if (!bytes) return 0;
      const handle = this.nextMmioHandle++;
      this.mmioHandles.set(handle, { path, bytes, position: 0 });
      return handle;
    }
    protected mmioDescend(handle: number, chunkPtr: number, parentPtr: number, flags: number): number {
      const stream = this.mmioHandles.get(handle);
      if (!stream || !chunkPtr) return 5;
      const bytes = stream.bytes;
      let start = Math.max(0, stream.position);
      let end = bytes.length;
      if (parentPtr) {
        const parentId = this.readU32(parentPtr);
        const parentSize = this.readU32(parentPtr + 4);
        const parentData = this.readU32(parentPtr + 12);
        const parentStart = parentData - (parentId === fourCc('RIFF') || parentId === fourCc('LIST') ? 12 : 8);
        start = Math.max(start, parentData);
        end = Math.min(end, parentStart + 8 + parentSize);
      }

      const wantedId = this.readU32(chunkPtr);
      const wantedType = this.readU32(chunkPtr + 8);
      for (let offset = start; offset + 8 <= end;) {
        const id = readBytesU32(bytes, offset);
        const size = readBytesU32(bytes, offset + 4);
        const list = id === fourCc('RIFF') || id === fourCc('LIST');
        const type = list && offset + 12 <= end ? readBytesU32(bytes, offset + 8) : 0;
        const idMatches =
          (flags & 0x20) !== 0
            ? id === fourCc('RIFF') && (!wantedType || type === wantedType)
            : (flags & 0x40) !== 0
              ? id === fourCc('LIST') && (!wantedType || type === wantedType)
              : (flags & 0x10) !== 0
                ? id === wantedId
                : true;
        if (idMatches) {
          const dataOffset = offset + (list ? 12 : 8);
          this.writeU32(chunkPtr, id);
          this.writeU32(chunkPtr + 4, size);
          this.writeU32(chunkPtr + 8, type);
          this.writeU32(chunkPtr + 12, dataOffset);
          this.writeU32(chunkPtr + 16, 0);
          stream.position = dataOffset;
          return 0;
        }
        const next = offset + 8 + size + (size & 1);
        if (next <= offset || next > end) break;
        offset = next;
      }
      return 257; // MMIOERR_CHUNKNOTFOUND
    }
    protected mmioAscend(handle: number, chunkPtr: number): number {
      const stream = this.mmioHandles.get(handle);
      if (!stream || !chunkPtr) return 5;
      const id = this.readU32(chunkPtr);
      const size = this.readU32(chunkPtr + 4);
      const dataOffset = this.readU32(chunkPtr + 12);
      const headerBytes = id === fourCc('RIFF') || id === fourCc('LIST') ? 12 : 8;
      const start = dataOffset - headerBytes;
      stream.position = Math.min(stream.bytes.length, start + 8 + size + (size & 1));
      return 0;
    }
    protected mmioRead(handle: number, bufferPtr: number, requested: number): number {
      const stream = this.mmioHandles.get(handle);
      if (!stream || !bufferPtr || requested < 0) return -1;
      const count = Math.min(requested, Math.max(0, stream.bytes.length - stream.position));
      this.memory.write_memory(stream.bytes.subarray(stream.position, stream.position + count), bufferPtr);
      stream.position += count;
      return count;
    }
  };
}
