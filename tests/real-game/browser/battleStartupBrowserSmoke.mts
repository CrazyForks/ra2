import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import type { GamePerformanceSample } from '../../../src/games/performance';
import { summarizeGamePerformance } from '../../helpers/gamePerformance';
/** 真实资源直达战场：选择资源后不发送任何客体点击/键盘事件。 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const screenshotDirectory = process.env.RA2_BROWSER_SCREENSHOT_DIR ?? '/tmp';
mkdirSync(screenshotDirectory, { recursive: true });
const games = process.env.RA2_BROWSER_GAME ? [process.env.RA2_BROWSER_GAME] : ['ra2', 'yr'];
const modes = process.env.VM_BROWSER_MODE ? [process.env.VM_BROWSER_MODE] : ['worker', 'main'];
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  for (const game of games)
    for (const mode of modes) {
      assert.ok(game === 'ra2' || game === 'yr');
      assert.ok(mode === 'worker' || mode === 'main');
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 } });
      await context.addInitScript((game) => localStorage.setItem(`vm-resolution-${game}`, '800x600'), game);
      // 测试侧只读探针：验证原生本地 House 有单位；不替换 EXE，也不写游戏状态。
      const abi =
        game === 'ra2'
          ? { local: 0xa35db4, human: 0x134, units: 0x5434, dead: 0x13d }
          : { local: 0xa83d4c, human: 0x1ec, units: 0x5518, dead: 0x1f5 };
      const probe = (core: string) => `globalThis.__battleGamePerformance = () => (${core})?.getGamePerformance();
globalThis.__battleStartSnapshot = () => {
      const s=(${core})?.shim; if(!s) return null;
      const house=s.readU32(${abi.local}); if(!house) return null;
      const units=s.readU32(house+${abi.units}), size=s.readU32(house+${abi.units}+4);
      let total=0;
      if(units && size>0 && size<=4096) for(let i=0;i<size;i++) total+=s.readU32(units+i*4);
      return {human:s.readU8(house+${abi.human}),dead:s.readU8(house+${abi.dead}),units:total};
    };`;
      const module = mode === 'worker' ? 'vmWorker' : 'runtime';
      await context.route(`**/src/adapter/${module}.ts*`, async (route) => {
        const response = await route.fetch(),
          source = await response.text();
        const marker =
          mode === 'worker' ? 'installVmWorker(self);' : 'this.core = new VmCore(callbacks, source, platform);';
        assert.ok(source.includes(marker), '只读探针入口已变更');
        const replacement =
          mode === 'worker'
            ? `const controller = installVmWorker(self);${probe('controller.core')}`
            : `${marker}${probe('this.core')}`;
        await route.fulfill({ response, body: source.replace(marker, replacement) });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/?debug=1&start-page=battle${mode === 'main' ? '&vm-worker=0' : ''}`);
      await selectDevelopmentGame(page, game);
      try {
        // 不以 loading 时暂时没有 shell 为成功；要求战场像素、侧栏和持续帧更新。
        await page.waitForFunction(
          () => {
            const c = document.querySelector<HTMLElement>('#screen');
            const [edge, field] = (c?.dataset.vmBattlefield ?? '').split(',').map(Number);
            return (
              JSON.parse(c?.dataset.vmStatus ?? '{}').phase === 'running' &&
              !c?.dataset.shellPage &&
              edge! > 0.01 &&
              field! > 0.1
            );
          },
          null,
          { timeout: 150000 },
        );
        const snapshot = async () => {
          const target = mode === 'worker' ? page.workers().find((w) => w.url().includes('/vmWorker.ts'))! : page;
          return target.evaluate(() => (globalThis as any).__battleStartSnapshot?.());
        };
        await expect
          .poll(
            async () => {
              const state = await snapshot();
              return state?.human === 1 && state.dead === 0 && state.units > 0;
            },
            { timeout: 150000 },
          )
          .toBe(true);
        // 读条画面也可能有大量彩色像素。先等原生单位建立，再检查持续画面输出。
        const frame = Number(await page.locator('#screen').getAttribute('data-vm-frame'));
        await page.waitForFunction(
          (frame) => Number(document.querySelector<HTMLElement>('#screen')?.dataset.vmFrame) > frame + 120,
          frame,
          { timeout: 60000 },
        );
        assert.equal(await page.locator('#screen').getAttribute('data-shell-page'), null);
        assert.deepEqual(errors, []);
        const target = mode === 'worker' ? page.workers().find((w) => w.url().includes('/vmWorker.ts'))! : page;
        const samples: GamePerformanceSample[] = [];
        for (let i = 0; i < 6; i++) {
          if (i) await page.waitForTimeout(1000);
          const sample = (await target.evaluate(() =>
            (globalThis as any).__battleGamePerformance(),
          )) as GamePerformanceSample | null;
          assert.ok(sample, '已知 EXE 的原生帧 hook 必须可用');
          samples.push(sample);
        }
        const report = summarizeGamePerformance(samples);
        writeFileSync(
          join(screenshotDirectory, `${game}-native-perf-${mode}.json`),
          JSON.stringify({ game, mode, samples, report }, null, 2),
        );
        assert.ok(report?.valid && report.logicFps > 0, '原生逻辑计数必须真实推进');
        console.log('[game-perf]', game, mode, JSON.stringify(report));
        console.log(game, mode, '无客体输入直达战场通过');
      } finally {
        await page.screenshot({ path: join(screenshotDirectory, `${game}-battle-start-${mode}.png`) });
        console.log(
          await page.locator('#screen').evaluate((c) => {
            const d = (c as HTMLElement).dataset;
            return { status: d.vmStatus, shell: d.shellPage, frame: d.vmFrame, pixels: d.vmBattlefield };
          }),
        );
        await context.close();
      }
    }
} finally {
  await browser.close();
}
