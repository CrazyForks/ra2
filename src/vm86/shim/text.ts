/**
 * 客体窄字符串解码：Win9x 中文环境用 GBK（cp936）。ASCII 无损；
 * 环境缺 TextDecoder（极老浏览器）时退化为 latin1 逐字节。
 */
const guestNarrowDecoder: { decode(bytes: Uint8Array): string } | null =
  typeof TextDecoder === 'function' ? new TextDecoder('gbk') : null;

export function decodeGuestNarrow(bytes: Uint8Array): string {
  if (!guestNarrowDecoder) return String.fromCharCode(...bytes);
  try {
    return guestNarrowDecoder.decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** MessageBox 没有宿主 UI 时选择 Win32 默认按钮，而不是对所有类型伪造 IDOK。 */
export function defaultMessageBoxResult(type: number): number {
  const buttons = (() => {
    switch (type & 0x0f) {
      case 1:
        return [1, 2]; // IDOK, IDCANCEL
      case 2:
        return [3, 4, 5]; // IDABORT, IDRETRY, IDIGNORE
      case 3:
        return [6, 7, 2]; // IDYES, IDNO, IDCANCEL
      case 4:
        return [6, 7]; // IDYES, IDNO
      case 5:
        return [4, 2]; // IDRETRY, IDCANCEL
      case 6:
        return [2, 10, 11]; // IDCANCEL, IDTRYAGAIN, IDCONTINUE
      default:
        return [1]; // IDOK
    }
  })();
  const defaultIndex = Math.min((type >>> 8) & 0x03, buttons.length - 1);
  return buttons[defaultIndex] ?? 1;
}

/** 小端四字节标签（RIFF/LIST chunk id）。 */
export function fourCc(value: string): number {
  return (
    (value.charCodeAt(0) & 0xff) |
    ((value.charCodeAt(1) & 0xff) << 8) |
    ((value.charCodeAt(2) & 0xff) << 16) |
    ((value.charCodeAt(3) & 0xff) << 24)
  );
}

/** Uint8Array 小端 u32。 */
export function readBytesU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** 客体内存里的 ANSI/系统区域设置文本（繁体中文游戏用 Big5）。 */
export function decodeAnsi(bytes: Uint8Array): string {
  try {
    return new TextDecoder('big5').decode(bytes);
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** Win32 DLL 数值分派标签：装载时算一次，运行时 dispatch 零字符串操作。 */
export const WIN32_KERNEL32 = 0;
export const WIN32_USER32 = 1;
export const WIN32_GDI32 = 2;
export const WIN32_WINMM = 3;
export const WIN32_ADVAPI32 = 4;
export const WIN32_MSVFW32 = 5;
export const WIN32_DDRAW_COM = 6;
export const WIN32_DSOUND_COM = 7;
export const WIN32_DDRAW = 8;
export const WIN32_DSOUND = 9;
export const WIN32_OLE32 = 10;
export const WIN32_DPLAYX = 11;
export const WIN32_DPLAYX_COM = 12;
export const WIN32_WSOCK32 = 13;

/** DLL 名字 → 数值标签；COM 命名空间（DDRAW.COM/DSOUND.COM）单独成类。 */
export function win32ModuleOf(dll: string): number {
  const key = dll.toUpperCase();
  if (key.startsWith('DDRAW.COM')) return WIN32_DDRAW_COM;
  if (key.startsWith('DSOUND.COM')) return WIN32_DSOUND_COM;
  if (key.startsWith('DPLAYX.COM')) return WIN32_DPLAYX_COM;
  if (key.startsWith('DDRAW')) return WIN32_DDRAW;
  if (key.startsWith('DSOUND')) return WIN32_DSOUND;
  if (key.startsWith('DPLAYX')) return WIN32_DPLAYX;
  if (key.startsWith('KERNEL32')) return WIN32_KERNEL32;
  if (key.startsWith('USER32')) return WIN32_USER32;
  if (key.startsWith('GDI32')) return WIN32_GDI32;
  if (key.startsWith('WINMM')) return WIN32_WINMM;
  if (key.startsWith('ADVAPI32')) return WIN32_ADVAPI32;
  if (key.startsWith('MSVFW32')) return WIN32_MSVFW32;
  if (key.startsWith('OLE32')) return WIN32_OLE32;
  if (key.startsWith('WSOCK32') || key.startsWith('WS2_32')) return WIN32_WSOCK32;
  return -1;
}
