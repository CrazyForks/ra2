import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** 真实 WebGL2 像素校验：先 pnpm run dev，再运行本脚本。无需游戏资源。 */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  // 字符串在浏览器内编译，避免 tsx 的 keepNames 辅助函数泄漏进 evaluate。
  const result = await page.evaluate<{ backend: string; differences: number; colors: number }>(`(async () => {
    // 动态 URL 由 Vite 编译，避免 Node 尝试导入浏览器模块。
    const moduleUrl = '/src/ui/pages/game/vmFrameRenderer.ts';
    const { createVmFrameRenderer } = await import(moduleUrl);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const renderer = createVmFrameRenderer(canvas);
    if (renderer.backend !== 'WebGL2') throw new Error('本测试必须使用真实 WebGL2');
    const gl = canvas.getContext('webgl2');
    const rgb565 = new Uint16Array(65536);
    const rgba = new Uint8Array(65536 * 4);
    for (let p = 0; p < 65536; p++) {
      rgb565[p] = p;
      const r = (p >>> 11) & 31, g = (p >>> 5) & 63, b = p & 31;
      rgba.set([(r << 3) | (r >>> 2), (g << 2) | (g >>> 4), (b << 3) | (b >>> 2), 255], p * 4);
    }
    const base = { width: 256, height: 256, pixels: new Uint8Array(0), palette: new Uint8Array(0) };
    const read = () => {
      const bytes = new Uint8Array(rgba.length);
      gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const error = gl.getError();
      if (error) throw new Error('WebGL 错误 ' + error);
      return bytes;
    };
    renderer.draw({ ...base, rgba }, 256, 256);
    const reference = read();
    let differences = 0;
    for (let pass = 0; pass < 3; pass++) {
      renderer.draw({ ...base, rgb565 }, 256, 256);
      const actual = read();
      for (let i = 0; i < actual.length; i++) if (actual[i] !== reference[i]) differences++;
      // 强制走相同尺寸的 texSubImage2D，再切回 RGBA 检查格式重分配。
      renderer.draw({ ...base, rgb565: rgb565.slice() }, 256, 256);
      const updated = read();
      for (let i = 0; i < updated.length; i++) if (updated[i] !== reference[i]) differences++;
      renderer.draw({ ...base, rgba }, 256, 256);
    }
    renderer.destroy();
    return { backend: renderer.detail, differences, colors: rgb565.length };
  })()`);
  assert.equal(result.differences, 0, 'GPU 紧凑帧必须与原 RGBA 路径逐字节一致');
  console.log(result);
} finally {
  await browser.close();
}
