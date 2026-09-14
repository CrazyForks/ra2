/** 附加包按扩展名探索任意子目录，但只把安全的 basename 挂到客体根目录。 */
export function archiveExtensionKey(path: string, extensions: readonly string[]): string | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/');
  if (normalized.startsWith('/') || normalized.includes(':') || parts.includes('..') || /[\x00-\x1f]/.test(normalized))
    return null;
  const name = parts.at(-1) ?? '';
  return extensions.some((extension) => name.endsWith(extension.toLowerCase())) ? name : null;
}
