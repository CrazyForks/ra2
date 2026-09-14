import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** 无游戏素材：真实 ZIP/7z 解压 Worker、启动层顺序、延迟读取与失败语义。 */
import assert from 'node:assert/strict';
import SevenZip from '7z-wasm';
import { zipSync } from 'fflate';
import { chromium } from '@playwright/test';

const files = {
  'ra2.mix': new Uint8Array([1, 2, 3]),
  'language.mix': new Uint8Array([4]),
  'blowfish.dll': new Uint8Array([5]),
  'binkw32.dll': new Uint8Array([6]),
  'expand01.mix': new Uint8Array([7]),
  'movies01.mix': new Uint8Array(),
  'maps01.mix': new Uint8Array([8]),
  'theme.mix': new Uint8Array(1024 * 1024).fill(9),
};
const zip = zipSync(files);
const seven = await SevenZip({ print() {}, printErr() {} });
seven.FS.mkdir('/input');
for (const [name, bytes] of Object.entries(files)) seven.FS.writeFile(`/input/${name}`, bytes);
assert.equal(seven.callMain(['a', '-t7z', '/fixture.7z', '/input']), 0);
const sevenBytes = new Uint8Array(seven.FS.readFile('/fixture.7z'));
const duplicate = zipSync({ ...files, 'other/ra2.mix': new Uint8Array([99]) });
const broken = Buffer.from(zip);
// 破坏其他层的压缩载荷，目录和启动层仍可读；验证晚到的错误不被当成成功。
const name = broken.indexOf(Buffer.from('theme.mix'));
assert.ok(name > 0);
broken[name + 'theme.mix'.length + 3] ^= 0xff;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174');
  for (const [kind, bytes] of [
    ['zip', zip],
    ['blob', zip],
    ['7z', sevenBytes],
    ['nested', zipSync({ 'wrapped.zip': zip })],
    ['duplicate', duplicate],
    ['broken', broken],
    ['cancel', zip],
  ] as const) {
    const result = await page.evaluate(
      async ({ data, kind }) => {
        // @ts-ignore 浏览器通过 Vite 加载模块。
        const { openGameArchive } = await import('/src/adapter/gameArchiveLayers.ts');
        // @ts-ignore 浏览器通过 Vite 加载模块。
        const { ProgressiveGameFileProvider } = await import('/src/adapter/progressiveFiles.ts');
        try {
          const bytes = new Uint8Array(data);
          const source = await openGameArchive(kind === 'blob' ? new Blob([bytes]) : bytes, 'ra2', () => {});
          const layered = source instanceof ProgressiveGameFileProvider;
          const initial = [...source.files.keys()] as string[];
          const names = await source.list('');
          try {
            if (kind === 'cancel') source.cancel();
            const movie = await source.read('movies01.mix');
            const theme = await source.read('theme.mix');
            if (layered) await source.completion;
            return { kind, layered, initial, names, empty: movie?.length, theme: theme?.length, error: '' };
          } catch (error) {
            return { kind, layered, initial, error: String(error) };
          }
        } catch (error) {
          return { kind, layered: false, initial: [], error: String(error) };
        }
      },
      { data: [...bytes], kind },
    );
    console.log(result);
    if (kind === 'duplicate') assert.match(result.error, /同名/);
    else if (kind === 'broken') {
      assert.equal(result.layered, true);
      assert.match(result.error, /失败|损坏|长度/);
    } else if (kind === 'cancel') {
      assert.equal(result.layered, true);
      assert.match(result.error, /取消/);
    } else {
      assert.equal(result.error, '');
      assert.equal(result.layered, kind !== 'nested');
      assert.equal(result.empty, 0);
      assert.equal(result.theme, 1024 * 1024);
      if (result.layered) {
        assert.ok(result.initial.includes('expand01.mix'));
        assert.ok(result.initial.includes('movies01.mix'));
        assert.ok(!result.initial.includes('theme.mix'), '启动层必须先发布，不能整包解完再声称分层');
        assert.ok(!result.initial.includes('maps01.mix'));
        assert.ok(result.names?.includes('maps01.mix'));
      }
    }
  }
} finally {
  await browser.close();
}
