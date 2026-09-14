import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
class ResourceError extends Error {}
function validateUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new ResourceError('资源地址须为 HTTPS（本地测试允许回环 HTTP），不接受用户信息');
  }
  return url;
}

async function download(url: string, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects <= 10; redirects++) {
    validateUrl(url);
    // CI 实测：默认 Python UA 被下载端以 403/1010 拒绝，同地址浏览器 UA 返回 200。
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location') ?? '', url).href;
      continue;
    }
    if (!response.ok) {
      // 只输出有限分类，绝不回显 URL、原始 header、响应正文或网络异常。
      const server = response.headers.get('server')?.toLowerCase() ?? '';
      const category = ['cloudflare', 'nginx', 'apache', 'amazons3'].find((name) => server.includes(name)) ?? 'other';
      await response.body?.cancel();
      throw new ResourceError(`资源下载失败：HTTP ${response.status}; server=${category}`);
    }
    return response;
  }
  throw new ResourceError('资源下载重定向过多');
}

/** 只下载用户原始游戏包并校验固定哈希；提取使用前端共享模块。 */
export async function downloadResources(url: string, expected: string, destination: string): Promise<void> {
  let stage: string | undefined;
  let phase = '配置';
  try {
    validateUrl(url);
    if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw new ResourceError('请配置固定的资源包 SHA-256');
    if (!isAbsolute(destination)) throw new ResourceError('目标必须为绝对目录');
    try {
      await lstat(destination);
      throw new ResourceError('目标目录已存在');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    stage = await mkdtemp(join(dirname(destination), '.resource-stage-'));
    const archive = join(stage, 'archive.bin');
    phase = '下载';
    const response = await download(url, AbortSignal.timeout(15 * 60_000));
    if (!response.body) throw new ResourceError('资源响应为空');
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > 16 * 1024 ** 3) return callback(new ResourceError('资源下载体积超限'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(archive, { flags: 'wx' }),
    );
    const digest = hash.digest('hex');
    const source = await open(archive, 'r');
    const magic = Buffer.alloc(8);
    try {
      await source.read(magic, 0, 8, 0);
    } finally {
      await source.close();
    }
    const kind =
      magic[0] === 0x1f && magic[1] === 0x8b ? 'tar.gz' : magic.subarray(0, 2).toString() === 'PK' ? 'zip' : 'unknown';
    if (!expected) {
      // 缺少可信哈希时只报告摘要，不自动接受下载结果作为基线。
      console.log(`资源格式=${kind}; bytes=${size}; SHA-256=${digest}`);
      throw new ResourceError('请审核资源包并配置固定 SHA-256');
    }
    if (digest !== expected) throw new ResourceError('资源包 SHA-256 不匹配');
    await rename(archive, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? ((error as Error)?.cause as NodeJS.ErrnoException)?.code;
    const category = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'Z_DATA_ERROR',
      'ENOENT',
      'ENOSPC',
    ].includes(code ?? '')
      ? code
      : '未知错误';
    throw new Error(
      `CI 资源准备失败：${error instanceof ResourceError ? error.message : `${phase}阶段：${category}（地址及异常正文已隐藏）`}`,
    );
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
