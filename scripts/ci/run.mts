import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadResources } from './downloadResources';
import { verifyResources } from './gameResources';
import { Processes } from './processes';

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
const [mode, game, flag, ...extra] = process.argv.slice(2);
if (
  extra.length ||
  !['basic', 'browser', 'real-game'].includes(mode ?? '') ||
  (mode === 'real-game'
    ? !['ra2', 'yr'].includes(game ?? '') || (flag !== undefined && flag !== '--local')
    : game !== undefined)
) {
  throw new Error('用法：ci:basic | ci:browser | ci:real-game <ra2|yr> [--local]');
}
const report = await mkdtemp(resolve(`.tmp-${mode}-ci-`));
const env = { ...process.env };
// Only this process reads download credentials; do not pass them to pnpm, the game, Vite, or the browser.
for (const key of Object.keys(env)) if (/^GAME_.*_(URL|SHA256)$/.test(key)) delete env[key];
// VM_* flags are local debugging controls (skip frame checks, click sequences, hover-only, disable JIT, etc.) that weaken assertions.
// CI uses only values explicitly set below, without inheriting environment values, so stale runner variables cannot
// turn real-game acceptance into a superficial check.
for (const key of Object.keys(env)) if (key.startsWith('VM_')) delete env[key];
const tasks = new Processes(report, env);
let resources: string | undefined;
let interrupted = false;
async function cleanup(): Promise<void> {
  await tasks.close();
  if (resources) await rm(resources, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
async function installBrowser(): Promise<void> {
  env.DEBUG = 'pw:install,extract-zip';
  await tasks.run('install-browser', 5, 'pnpm', [
    'exec',
    'playwright',
    'install',
    '--with-deps',
    '--only-shell',
    'chromium',
  ]);
  delete env.DEBUG;
}
async function browsers(): Promise<void> {
  await tasks.run('relay-build', 2, 'pnpm', ['--filter', 'relay-package', 'run', 'build:lib']);
  env.RA2_BROWSER_ORIGIN = 'https://127.0.0.1:15180';
  env.RELAY_PROBE_URL = '127.0.0.1:15182';
  env.RELAY_PROBE_GRANT = '1';
  await tasks.vite(15180);
  const relay = tasks.start('relay', process.execPath, [
    '--import',
    'tsx',
    'packages/relay/src/cli.mts',
    '--host',
    '127.0.0.1',
    '--port',
    '15182',
  ]);
  for (const test of [
    'test:graphics',
    'test:graphics:upscale',
    'test:graphics:ai',
    'test:graphics:gan',
    'test:browser:react-ui',
    'test:custom-maps',
    'test:browser:touch-ui',
    'test:browser:archive-layers',
    'test:browser:relay',
  ]) {
    if (relay.child.exitCode !== null || relay.child.signalCode !== null) {
      await relay.done;
      throw new Error('relay 提前退出');
    }
    await tasks.run(test.replaceAll(':', '-'), 3, 'pnpm', ['run', test]);
  }
}
try {
  if (mode === 'basic') {
    if (existsSync('game') || existsSync('.tmp-third-party'))
      throw new Error('无素材 CI 不允许 game/ 或 .tmp-third-party/');
    await tasks.run('check', 10, 'pnpm', ['run', 'check']);
    await tasks.run('firmware-build', 1, 'pnpm', ['run', 'build:boot']);
    await tasks.run('firmware-diff', 1, 'git', ['diff', '--exit-code', '--', 'src/vm86/boot.bin']);
    await installBrowser();
    await browsers();
  } else if (mode === 'browser') {
    await browsers();
  } else {
    // Remote runs use only the game argument and two secrets; existing resource configuration is read locally only with explicit --local.
    const gameId = game as 'ra2' | 'yr';
    let roots: { game: string; thirdParty: string }, manifest: string, expected: string;
    if (flag === '--local') {
      roots = { game: env.RA2_GAME_ROOT ?? '', thirdParty: env.RA2_THIRD_PARTY_CACHE_DIR ?? '' };
      manifest = env.RA2_CI_RESOURCE_MANIFEST ?? '';
      expected = env.RA2_CI_RESOURCE_MANIFEST_SHA256 ?? '';
    } else {
      const prefix = gameId === 'ra2' ? 'GAME_RA2' : 'GAME_RA2_YR';
      // Report missing secrets explicitly before reaching the downloader's generic failure path, which would hide the missing configuration.
      const sourceUrl = process.env[`${prefix}_URL`];
      const sourceSha256 = process.env[`${prefix}_SHA256`];
      if (!sourceUrl || !sourceSha256) {
        throw new Error(
          `缺少 ${prefix}_URL / ${prefix}_SHA256：真实游戏验收只对可信分支运行，` +
            `需要仓库 secret；fork 或不配置 secret 的仓库不会执行该验收。`,
        );
      }
      resources = await mkdtemp(join(tmpdir(), 'ra2-resources-'));
      const payload = resources;
      console.log(`开始：下载并校验 ${gameId} 资源`);
      await downloadResources(sourceUrl, sourceSha256, join(payload, 'archive.bin'));
      console.log(`开始：提取 ${gameId} 游戏包（与前端共享）`);
      // Reclaim the 7z/WASM heap when the extraction process exits; retaining it in the orchestrator would consume memory needed by the two VMs.
      await tasks.run('prepare-game', 15, process.execPath, [
        '--import',
        'tsx',
        'scripts/ci/prepareGame.ts',
        gameId,
        payload,
      ]);
      const prepared = JSON.parse(await readFile(join(payload, 'prepared.json'), 'utf8')) as {
        manifest: string;
        expected: string;
      };
      await rm(join(payload, 'archive.bin'));
      roots = { game: join(payload, 'game'), thirdParty: join(payload, 'thirdParty') };
      manifest = prepared.manifest;
      expected = prepared.expected;
    }
    const inventory = await verifyResources(roots, manifest, expected, gameId);
    console.log(`真实资源校验通过：${Object.keys(inventory.files).length} 个文件`);
    Object.assign(env, {
      RA2_GAME_ROOT: roots.game,
      RA2_THIRD_PARTY_CACHE_DIR: roots.thirdParty,
      VM_REQUIRE_GAME_RESOURCES: '1',
      VM_GAME_DIR: join(roots.game, 'ra2'),
      RA2_CI_GAME: gameId,
      RA2_BROWSER_GAME: gameId,
      RA2_BROWSER_ORIGIN: 'https://127.0.0.1:15181',
      RA2_BROWSER_SCREENSHOT_DIR: join(report, 'screenshots'),
    });
    await mkdir(env.RA2_BROWSER_SCREENSHOT_DIR!, { recursive: true });
    if (flag !== '--local') await installBrowser();
    // Each job has an independent checkout; do not depend on dist/lib left by the Basic job or local runs.
    await tasks.run('relay-build', 2, 'pnpm', ['--filter', 'relay-package', 'run', 'build:lib']);
    const boot = [`tests/real-game/${gameId}/boot.test.ts`];
    if (gameId === 'ra2') boot.push('tests/real-game/ra2/shortGame.test.ts');
    await tasks.run('boot', 4, 'pnpm', ['exec', 'vitest', 'run', ...boot, '--maxWorkers=1']);
    await tasks.vite(15181);
    await tasks.run('battlefield', 15, 'pnpm', ['run', 'test:browser:battle-start']);
    console.log('验收范围：原始 EXE 与 Worker/主线程战场启动；同机双端联机暂不纳入 CI。');
  }
  console.log(`${mode}${game ? ` ${game}` : ''} PASS`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CI 执行失败');
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log(`报告：${report}`);
}
