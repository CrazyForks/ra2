/** 把 DOS/Win32 路径折叠到相对根目录，匹配 Linux host 上的大小写无关资源表。 */
export function normalizeWindowsPath(path: string): string {
  const slashes = path
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of slashes.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/').toLowerCase();
}
