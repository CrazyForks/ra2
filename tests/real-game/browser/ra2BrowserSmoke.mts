import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import { chromium, type Locator, type Page } from '@playwright/test';

const ORIGIN = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const MENU_FRAME_SAMPLES = 6;
const GAME_ID = process.env.RA2_BROWSER_GAME === 'yr' ? 'yr' : 'ra2';
const GAME_LABEL = GAME_ID === 'yr' ? 'RA2YR' : 'RA2';
const EXECUTABLE = GAME_ID === 'yr' ? 'gamemd.exe' : 'game.exe';
// clickLogical 接收 1440×900 归一化坐标；RA2 与 YR 的右栏实际横向位置不同。
const MAIN_SINGLE_PLAYER: readonly [number, number] = GAME_ID === 'yr' ? [1288, 330] : [1034, 371];
const SINGLE_PLAYER_BACK: readonly [number, number] = GAME_ID === 'yr' ? [1288, 830] : [1034, 708];
const SINGLE_PLAYER_CAMPAIGN: readonly [number, number] = GAME_ID === 'yr' ? [1288, 330] : [1034, 371];

function serverReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(ORIGIN, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    req.setTimeout(1_000, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function ensureServer(): Promise<ChildProcess | null> {
  if (await serverReady()) return null;
  const origin = new URL(ORIGIN);
  // 直接启动 Vite，finally 中终止的就是服务本体，不留下 npm 的孙进程占用端口。
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', origin.hostname, '--port', origin.port || '443'],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite 提前退出：${server.exitCode}`);
    if (await serverReady()) return server;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill('SIGTERM');
  throw new Error('等待 Vite 启动超时');
}

async function expectShellPage(page: Page, expected: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    (name) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage?.toLowerCase().includes(name),
    expected.toLowerCase(),
    { timeout },
  );
}

async function waitForQuietFileReads(page: Page, canvas: Locator): Promise<void> {
  const deadline = Date.now() + 10_000;
  let quietBatches = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const batchText = await canvas.getAttribute('data-vm-batch');
    if (!batchText) continue;
    const batch = JSON.parse(batchText) as { calls: number; hot: Array<[string, number]> };
    const reads = batch.hot.find(([key]) => key === 'KERNEL32.DLL!ReadFile')?.[1] ?? 0;
    quietBatches = batch.calls < 4_000 && reads <= 100 ? quietBatches + 1 : 0;
    if (quietBatches >= 2) return;
  }
  throw new Error('主菜单文件读取在 10 秒内未进入稳态');
}

async function waitForBinkOpen(page: Page, before: number, label: string): Promise<void> {
  await page
    .waitForFunction(
      ({ count }) => {
        const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}';
        const calls = JSON.parse(raw) as Record<string, number>;
        return (calls['BINKW32.DLL!_BinkOpen@8'] ?? 0) > count;
      },
      { count: before },
      { timeout: 60_000 },
    )
    .catch(async (error: unknown) => {
      const canvas = page.locator('#screen');
      throw new Error(
        `${GAME_LABEL} ${label} 60 秒内没有执行新的 BinkOpen：` +
          `frame=${await canvas.getAttribute('data-vm-frame')}，` +
          `status=${await canvas.getAttribute('data-vm-status')}，` +
          `calls=${await canvas.getAttribute('data-vm-bink-calls')}`,
        { cause: error },
      );
    });
}

async function clickUntilShellPage(page: Page, canvas: Locator, expected: string, x: number, y: number): Promise<void> {
  const offsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [-50, 0],
    [50, 0],
    [0, -10],
    [0, 10],
    [0, -25],
    [0, 25],
    [-35, -12],
    [35, 12],
    [0, 0],
  ] as const;
  for (let attempt = 0; attempt < offsets.length; attempt++) {
    const current = (await canvas.getAttribute('data-shell-page')) ?? '';
    if (current.toLowerCase().includes(expected.toLowerCase())) return;
    await clickLogical(page, canvas, x + offsets[attempt]![0], y + offsets[attempt]![1]);
    try {
      // 原版切页会同步销毁一批 Win32 子窗口，并可能在返回主菜单时重新打开
      // LANGUAGE.MIX/Bink。过早重击旧 owner-draw 控件会在销毁链中制造重入；
      // 一次真实点击后给它完整的稳定窗口，再决定是否因动画吞键而重试。
      await expectShellPage(page, expected, 6_000);
      return;
    } catch {
      const rawStatus = await canvas.getAttribute('data-vm-status');
      if (rawStatus) {
        const status = JSON.parse(rawStatus) as { phase: string; detail: string };
        if (status.phase === 'error' || status.phase === 'blocked') {
          throw new Error(`菜单切换中断：${status.phase}：${status.detail}`);
        }
      }
      // 原版在同一拍重绘按钮时可能吞掉一次点击；仍在原页面才安全重试。
    }
  }
  await canvas.screenshot({ path: `/tmp/${GAME_ID}-${expected}-click-failed.png` });
  await expectShellPage(page, expected, 1_000);
}

async function clickLogical(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见');
  const resolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [width, height] = resolution.split('x').map(Number);
  const targetX = (x / 1440) * width!;
  const targetY = (y / 900) * height!;
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await clickLockedGuest(page, canvas, targetX, targetY, width!, height!, box.width, box.height);
    return;
  }
  const clientX = box.x + (targetX / width!) * box.width;
  const clientY = box.y + (targetY / height!) * box.height;
  // 换页后相同位置对应下一级按钮；先移开再移回，让原版收到新的 hover。
  // RA2 侧栏按钮约 100 CSS px 宽；只偏 30px 仍留在同一按钮里，原版收不到
  // mouse-leave→enter 的 hover 状态迁移。先移到画面左半部，再回到按钮中心。
  await page.mouse.move(box.x + box.width * 0.25, clientY);
  await page.waitForTimeout(100);
  await page.mouse.move(clientX, clientY);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

async function clickLockedGuest(
  page: Page,
  canvas: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  await moveLockedGuest(page, canvas, x, y, width, height, cssWidth, cssHeight);
  await page.waitForTimeout(100);
  await canvas.dispatchEvent('pointerdown', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 1,
  });
  await page.waitForTimeout(200);
  await canvas.dispatchEvent('pointerup', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 0,
  });
}

async function moveLockedGuest(
  _page: Page,
  canvas: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  const cursor = (await canvas.getAttribute('data-vm-cursor'))?.match(/^(\d+),(\d+)\//);
  const currentX = Number(cursor?.[1] ?? width / 2);
  const currentY = Number(cursor?.[2] ?? height / 2);
  const relative = (logicalDelta: number, cssExtent: number, logicalExtent: number): number => {
    if (!logicalDelta) return 0;
    const scaled = (logicalDelta * cssExtent) / logicalExtent;
    // PointerEvent movement 是整数设备计数；不足 1 CSS px 的尾差也必须产生一拍。
    return Math.sign(scaled) * Math.max(1, Math.abs(scaled));
  };
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: relative(x - currentX, cssWidth, width),
    movementY: relative(y - currentY, cssHeight, height),
  });
}

function callsOf(raw: string | null): Record<string, number> {
  return JSON.parse(raw ?? '{}') as Record<string, number>;
}

async function probeHostUi(page: Page): Promise<void> {
  const theme = await page.evaluate(() => ({
    yellow: getComputedStyle(document.documentElement).getPropertyValue('--ra2-yellow').trim(),
    debugBorder: getComputedStyle(document.querySelector<HTMLElement>('#vm-debug')!).borderLeftColor,
    sectionRadius: getComputedStyle(document.querySelector<HTMLElement>('#vm-debug .vm-debug-section')!).borderRadius,
    toolbarBackground: getComputedStyle(document.querySelector<HTMLElement>('#vm-controls .toolbar-button')!)
      .backgroundImage,
  }));
  assert.equal(theme.yellow.toLowerCase(), '#fff600', `网页未应用 RA2 信息黄：${JSON.stringify(theme)}`);
  assert.equal(theme.debugBorder, 'rgb(150, 150, 150)', `Debug 金属边框未生效：${JSON.stringify(theme)}`);
  assert.equal(theme.sectionRadius, '0px', `Debug 面板仍是普通圆角卡片：${JSON.stringify(theme)}`);
  // 控制栏按钮使用 CSS 三态，不再依赖游戏菜单精灵图。
  assert(theme.toolbarBackground.includes('linear-gradient'), `CSS 工具按钮未生效：${JSON.stringify(theme)}`);

  // 旧游戏专属光标表已删除；用通用的内存录制输出框验证面板滚轮加速。
  const scroller = page.locator('#vm-debug pre').first();
  const oldStyle = (await scroller.getAttribute('style')) ?? '';
  const oldText = (await scroller.textContent()) ?? '';
  await scroller.evaluate((element: HTMLElement) => {
    element.style.height = '80px';
    element.style.maxHeight = '80px';
    element.style.overflowY = 'auto';
    element.textContent = Array.from({ length: 40 }, (_, index) => `probe ${index}`).join('\n');
    element.scrollTop = 0;
  });
  await scroller.hover();
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(100);
  const scrollTop = await scroller.evaluate((element: HTMLElement) => element.scrollTop);
  assert(scrollTop >= 90, `网页面板滚轮未加速：deltaY=40 后只滚动 ${scrollTop}px`);
  await scroller.evaluate(
    (element: HTMLElement, previous: { style: string; text: string }) => {
      element.setAttribute('style', previous.style);
      element.textContent = previous.text;
      element.scrollTop = 0;
    },
    { style: oldStyle, text: oldText },
  );
  console.log(
    `🔬 网页 HUD：信息黄=${theme.yellow}，灰黑金属按钮，工业边角=${theme.sectionRadius}，滚轮 40→${scrollTop}px`,
  );
}

async function probeCampaignHover(page: Page, canvas: Locator, playCallsBeforePage: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Campaign canvas 不可见');
  const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
  await moveLockedGuest(page, canvas, 80, 520, width!, height!, box.width, box.height);
  await page.waitForTimeout(300);
  const hoverDispatchesBefore = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  const beforeCalls = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const before = beforeCalls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  await moveLockedGuest(page, canvas, 454, 188, width!, height!, box.width, box.height);
  const hashes = new Set<string>();
  for (let sample = 0; sample < 6; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    await page.waitForTimeout(150);
  }
  const hoverDispatchesEntered = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  assert.equal(
    hoverDispatchesEntered,
    hoverDispatchesBefore + 1,
    `阵营 logo 首次进入未产生且仅产生一次 hover：${hoverDispatchesBefore}→${hoverDispatchesEntered}`,
  );
  for (const [x, y] of [
    [465, 188],
    [475, 192],
    [460, 180],
    [470, 186],
  ] as const) {
    await moveLockedGuest(page, canvas, x, y, width!, height!, box.width, box.height);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
  const hoverDispatchesAfterWiggle = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  assert.equal(
    hoverDispatchesAfterWiggle,
    hoverDispatchesEntered,
    `同一阵营内部移动重复触发 hover 音频：${hoverDispatchesEntered}→${hoverDispatchesAfterWiggle}`,
  );
  const afterCalls = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const after = afterCalls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  const changedAudio = Object.fromEntries(
    Object.entries(afterCalls).filter(([key, count]) => count !== (beforeCalls[key] ?? 0)),
  );
  const target = await canvas.getAttribute('data-vm-worker-mouse');
  const dispatchTarget = await canvas.getAttribute('data-vm-worker-dispatch');
  assert(
    (afterCalls['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) >
      (beforeCalls['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) &&
      (afterCalls['DSOUND.COM!IDirectSoundBuffer.Unlock'] ?? 0) >
        (beforeCalls['DSOUND.COM!IDirectSoundBuffer.Unlock'] ?? 0),
    `阵营 logo hover 后 DirectSound PCM 没有继续写入：${JSON.stringify(changedAudio)}`,
  );
  assert(hashes.size >= 2, `阵营 logo hover 没有动画：6 次采样只有 ${hashes.size} 张画面，命中=${target}`);
  console.log(
    `🔬 阵营 hover：页面前/移开/移入 DirectSound Play ` +
      `${playCallsBeforePage}/${before}/${after}，Static 分派=${dispatchTarget}，` +
      `enter-edge=${hoverDispatchesBefore}→${hoverDispatchesEntered}→${hoverDispatchesAfterWiggle}，` +
      `PCM Lock/Unlock 持续更新，变化帧=${hashes.size}/6`,
  );
}

async function probeAndSkipCampaignVideo(
  page: Page,
  canvas: Locator,
  opensBefore: number,
  audioBefore: Record<string, number>,
): Promise<void> {
  try {
    await page.waitForFunction(
      (before) => {
        const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}';
        const calls = JSON.parse(raw) as Record<string, number>;
        return (calls['BINKW32.DLL!_BinkOpen@8'] ?? 0) > before;
      },
      opensBefore,
      { timeout: 30_000 },
    );
  } catch (error) {
    await canvas.screenshot({ path: `/tmp/${GAME_ID}-campaign-video-timeout.png` });
    throw new Error(
      `${GAME_LABEL} 战役选择后 30 秒未打开 Bink：frame=${await canvas.getAttribute('data-vm-frame')}，` +
        `resolution=${await canvas.getAttribute('data-vm-resolution')}，` +
        `shell=${await canvas.getAttribute('data-shell-page')}，` +
        `status=${await canvas.getAttribute('data-vm-status')}，` +
        `calls=${await canvas.getAttribute('data-vm-bink-calls')}`,
      { cause: error },
    );
  }
  // 用户报告的故障不是首屏画面，而是音频/等待链在播放途中卡住。持续观察 8 秒，
  // 同时检查每 500ms 的调用批次，避免只看开头 1.2 秒而漏掉 BinkWait 风暴。
  const hashes = new Set<string>();
  let maxBinkWaitCalls = 0;
  let maxSoundPositionCalls = 0;
  let maxBatchCalls = 0;
  for (let sample = 0; sample < 32; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const batchText = await canvas.getAttribute('data-vm-batch');
    if (sample >= 4 && batchText) {
      const batch = JSON.parse(batchText) as { calls: number; hot: Array<[string, number]> };
      maxBatchCalls = Math.max(maxBatchCalls, batch.calls);
      maxBinkWaitCalls = Math.max(
        maxBinkWaitCalls,
        batch.hot.find(([key]) => key === 'BINKW32.DLL!_BinkWait@4')?.[1] ?? 0,
      );
      maxSoundPositionCalls = Math.max(
        maxSoundPositionCalls,
        batch.hot.find(([key]) => key === 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition')?.[1] ?? 0,
      );
    }
    await page.waitForTimeout(250);
  }
  assert(hashes.size >= 12, `战役过场没有持续播放：32 次采样只有 ${hashes.size} 张画面`);
  assert(
    maxBinkWaitCalls < 100,
    `战役过场 BinkWait 仍在宿主 hypercall 自旋：最高 ${maxBinkWaitCalls}/500ms，总调用 ${maxBatchCalls}/500ms`,
  );
  assert(
    maxSoundPositionCalls < 250,
    `战役过场声音游标跨线程轮询过载：最高 ${maxSoundPositionCalls}/500ms，总调用 ${maxBatchCalls}/500ms`,
  );
  const audioAfter = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const buffersBefore = audioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0;
  const buffersAfter = audioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0;
  const playsBefore = audioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  const playsAfter = audioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  assert(
    buffersAfter > buffersBefore && playsAfter > playsBefore,
    `战役过场没有建立并播放音频缓冲：CreateSoundBuffer ${buffersBefore}→${buffersAfter}，Play ${playsBefore}→${playsAfter}`,
  );
  // 浏览器真实 Esc 会先作为保留键解除 Pointer Lock，部分平台不再把 keydown
  // 给页面。自动化环境直接触发同一个 pointerlockchange，验证页面会补出客体 Esc。
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => document.pointerLockElement === null, undefined, { timeout: 5_000 });
  console.log(
    `🔬 战役过场：8 秒变化帧=${hashes.size}/32，` +
      `BinkWait=${maxBinkWaitCalls}/500ms，声音游标=${maxSoundPositionCalls}/500ms，` +
      `音频 buffer=${buffersBefore}→${buffersAfter}、Play=${playsBefore}→${playsAfter}；` +
      `Esc 已退出 Pointer Lock 并透传跳过影片`,
  );
}

async function clickGuest(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见');
  const resolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [width, height] = resolution.split('x').map(Number);
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await clickLockedGuest(page, canvas, x, y, width!, height!, box.width, box.height);
    return;
  }
  await page.mouse.move(box.x + (x / width!) * box.width, box.y + (y / height!) * box.height);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

type BattlefieldSignal = {
  rightEdgeRatio: number;
  fieldRatio: number;
  frame: number;
};

async function battlefieldSignal(canvas: Locator): Promise<BattlefieldSignal> {
  const ratios = ((await canvas.getAttribute('data-vm-battlefield')) ?? '0,0').split(',').map(Number);
  return {
    rightEdgeRatio: ratios[0] ?? 0,
    fieldRatio: ratios[1] ?? 0,
    frame: Number((await canvas.getAttribute('data-vm-frame')) ?? 0),
  };
}

async function waitForPlayableBattle(
  page: Page,
  canvas: Locator,
  timeoutMs: number,
): Promise<{
  elapsedMs: number;
  signal: BattlefieldSignal;
}> {
  const startedAt = Date.now();
  let lastSignal: BattlefieldSignal = { rightEdgeRatio: 0, fieldRatio: 0, frame: 0 };
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(500);
    const rawStatus = await canvas.getAttribute('data-vm-status');
    if (rawStatus) {
      const status = JSON.parse(rawStatus) as { phase: string; detail: string };
      if (status.phase === 'error' || status.phase === 'blocked') {
        throw new Error(`战役运行中断：${status.phase}：${status.detail}`);
      }
    }
    lastSignal = await battlefieldSignal(canvas);
    if (lastSignal.rightEdgeRatio >= 0.08 && lastSignal.fieldRatio >= 0.05) {
      return { elapsedMs: Date.now() - startedAt, signal: lastSignal };
    }
    if (Date.now() - lastLogAt >= 5_000) {
      lastLogAt = Date.now();
      console.log(
        `⏳ 等待可操作战场 ${Math.round((Date.now() - startedAt) / 1_000)}s：` +
          `右栏=${lastSignal.rightEdgeRatio.toFixed(3)}，地图=${lastSignal.fieldRatio.toFixed(3)}，` +
          `帧=${lastSignal.frame}，批次=${await canvas.getAttribute('data-vm-batch')}`,
      );
    }
  }
  throw new Error(
    `等待可操作战场超时：右栏=${lastSignal.rightEdgeRatio.toFixed(3)}，` +
      `地图=${lastSignal.fieldRatio.toFixed(3)}，帧=${lastSignal.frame}`,
  );
}

async function probeMainMenu(
  page: Page,
  canvas: Locator,
): Promise<{
  uniqueFrames: number;
  displayedFps: number;
  maxBatchCalls: number;
  maxReadFileCalls: number;
  emittedFrames: number;
  maxBatchHot: Array<[string, number]>;
}> {
  const hashes = new Set<string>();
  const batches: Array<{ calls: number; hot: Array<[string, number]> }> = [];
  const startFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
  await page.waitForTimeout(750);
  for (let sample = 0; sample < MENU_FRAME_SAMPLES; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const batch = await canvas.getAttribute('data-vm-batch');
    if (batch) batches.push(JSON.parse(batch));
    await page.waitForTimeout(250);
  }
  const fpsOutput = page.locator('#vm-fps');
  let fpsText = await fpsOutput.evaluate((output: HTMLOutputElement) => output.value);
  if (Number(fpsText.match(/显示\s+([\d.]+)/)?.[1] ?? 0) < 20) {
    await page.waitForTimeout(1_000);
    fpsText = await fpsOutput.evaluate((output: HTMLOutputElement) => output.value);
  }
  return {
    uniqueFrames: hashes.size,
    displayedFps: Number(fpsText.match(/显示\s+([\d.]+)/)?.[1] ?? 0),
    maxBatchCalls: Math.max(0, ...batches.map((batch) => batch.calls)),
    maxReadFileCalls: Math.max(
      0,
      ...batches.map((batch) => batch.hot.find(([key]) => key === 'KERNEL32.DLL!ReadFile')?.[1] ?? 0),
    ),
    emittedFrames: Number((await canvas.getAttribute('data-vm-frame')) ?? 0) - startFrame,
    maxBatchHot: [...batches].sort((left, right) => right.calls - left.calls)[0]?.hot ?? [],
  };
}

assert(existsSync(`game/ra2/${EXECUTABLE}`), `缺少 game/ra2/${EXECUTABLE}`);
assert(existsSync('game/ra2/BINKW32.DLL'), '缺少 game/ra2/BINKW32.DLL');

const server = await ensureServer();
const browser = await chromium.launch({
  headless: process.env.RA2_BROWSER_HEADFUL !== '1',
  // 两款游戏的 v86 RAM 为 640MiB；headless renderer 的默认 V8 old-space 在
  // 连续帧探针/截图后偶发 GC 饥饿甚至 Target crashed。测试进程单独放宽上限，
  // 保证失败来自客体或断言，而不是 Playwright 宿主内存门槛。
  args: ['--js-flags=--max-old-space-size=4096'],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript((gameId) => {
    localStorage.setItem('ra2-vm-preferred-game', gameId);
    if (!localStorage.getItem(`vm-resolution-${gameId}`)) {
      localStorage.setItem(`vm-resolution-${gameId}`, '1440x900');
    }
    localStorage.removeItem('vm-clock-rate');
  }, GAME_ID);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    const detail = error.stack ?? error.message;
    pageErrors.push(detail);
    console.error(`❌ ${GAME_LABEL} pageerror：${detail}`);
  });
  page.on('crash', () => console.error(`❌ ${GAME_LABEL} Chromium renderer crashed`));
  await page.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
  // 本地资源现在必须显式选择；新浏览器上下文没有 IndexedDB 导入缓存。
  await page.getByRole('button', { name: '开发测试', exact: true }).click();
  await page
    .locator('.detected-games button')
    .nth(GAME_ID === 'ra2' ? 0 : 1)
    .click();

  const canvas = page.locator('#screen');
  const problem = page.locator('h3').filter({ hasText: /运行错误|接口待实现/ });
  await expectShellPage(page, 'mainmenu', 60_000);
  await waitForQuietFileReads(page, canvas);
  await waitForBinkOpen(page, 0, '首次主菜单');
  assert.equal(
    await page.locator('#vm-resolution').inputValue(),
    '1440x900',
    `${GAME_LABEL} 网页分辨率选择没有恢复 1440×900 偏好`,
  );
  assert.equal(await page.getByText('客体状态', { exact: true }).count(), 0, '仍渲染无用的客体状态区块');
  await probeHostUi(page);
  const mainMenuProbe = await probeMainMenu(page, canvas);
  assert(
    mainMenuProbe.uniqueFrames >= 5,
    `主菜单视频未连续播放：${MENU_FRAME_SAMPLES} 次采样只有 ${mainMenuProbe.uniqueFrames} 张不同画面，` +
      `VM帧=${mainMenuProbe.emittedFrames}，Bink=${await canvas.getAttribute('data-vm-bink-calls')}`,
  );
  assert(mainMenuProbe.emittedFrames >= 20, `主菜单实际输出帧过低：采样窗口只有 ${mainMenuProbe.emittedFrames} 帧`);
  if (mainMenuProbe.displayedFps > 0) {
    assert(mainMenuProbe.displayedFps >= 20, `主菜单显示帧率过低：${mainMenuProbe.displayedFps.toFixed(1)} fps`);
  }
  assert(
    mainMenuProbe.maxBatchCalls < 4_000,
    `Worker 调用批次过载：${mainMenuProbe.maxBatchCalls} calls/500ms，热点=${JSON.stringify(mainMenuProbe.maxBatchHot)}`,
  );
  assert(
    mainMenuProbe.maxReadFileCalls <= 100,
    `文件读取快速路径失效：ReadFile ${mainMenuProbe.maxReadFileCalls} calls/500ms`,
  );
  console.log(
    `🔬 主菜单视频：变化帧=${mainMenuProbe.uniqueFrames}/${MENU_FRAME_SAMPLES}，显示=${mainMenuProbe.displayedFps.toFixed(1)}fps，` +
      `VM帧=${mainMenuProbe.emittedFrames}，最大调用批次=${mainMenuProbe.maxBatchCalls}/500ms，` +
      `ReadFile=${mainMenuProbe.maxReadFileCalls}/500ms`,
  );
  assert.equal(await problem.count(), 0, '主菜单出现运行错误');
  await page.waitForTimeout(750);
  await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', undefined, { timeout: 5_000 });
  await page.waitForTimeout(500);
  // 返回主菜单会重新 BinkOpen 同一段 LANGUAGE.MIX 视频；不能只验证首屏。
  // 不用 Esc 退出普通菜单：RA2 的旧式 KillTimer/CallWindowProc 回调链在该时点
  // 会与 Pointer Lock 解锁消息重入；点击游戏自己的 Back 才是稳定原版路径。
  const mainMenuOpensBeforeReturn =
    callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkOpen@8'] ?? 0;
  await clickUntilShellPage(page, canvas, 'mainmenu', ...SINGLE_PLAYER_BACK);
  await waitForQuietFileReads(page, canvas);
  await waitForBinkOpen(page, mainMenuOpensBeforeReturn, '返回主菜单');
  let returnedMainMenuProbe = await probeMainMenu(page, canvas);
  // SetWindowText/MainMenu 会早于返回视频解码器完全恢复；若第一窗口仍夹着
  // BinkOpen 初始化，等一拍后重测稳态，性能门槛本身不降低。
  if (returnedMainMenuProbe.emittedFrames < 20) {
    await page.waitForTimeout(1_000);
    returnedMainMenuProbe = await probeMainMenu(page, canvas);
  }
  assert(
    returnedMainMenuProbe.uniqueFrames >= 5,
    `返回主菜单后视频未继续播放：${MENU_FRAME_SAMPLES} 次采样只有 ${returnedMainMenuProbe.uniqueFrames} 张不同画面`,
  );
  assert(
    returnedMainMenuProbe.emittedFrames >= 20,
    `返回主菜单后实际输出帧过低：采样窗口只有 ${returnedMainMenuProbe.emittedFrames} 帧`,
  );
  if (returnedMainMenuProbe.displayedFps > 0) {
    assert(
      returnedMainMenuProbe.displayedFps >= 20,
      `返回主菜单后显示帧率过低：${returnedMainMenuProbe.displayedFps.toFixed(1)} fps`,
    );
  }
  console.log(
    `🔬 返回主菜单视频：变化帧=${returnedMainMenuProbe.uniqueFrames}/${MENU_FRAME_SAMPLES}，` +
      `显示=${returnedMainMenuProbe.displayedFps.toFixed(1)}fps，VM帧=${returnedMainMenuProbe.emittedFrames}`,
  );

  const binkCalls = JSON.parse((await canvas.getAttribute('data-vm-bink-calls')) ?? '{}') as Record<string, number>;
  assert(
    (binkCalls['BINKW32.DLL!_BinkOpen@8'] ?? 0) >= 2,
    `${GAME_LABEL} 返回主菜单后没有再次执行 BinkOpen：${JSON.stringify(binkCalls)}`,
  );
  assert(
    (binkCalls['BINKW32.DLL!_BinkClose@4'] ?? 0) >= 1,
    `${GAME_LABEL} 切页没有完成 BinkClose：${JSON.stringify(binkCalls)}`,
  );
  assert.equal(
    binkCalls['BINKW32.DLL!_BinkCopyToBuffer@28'] ?? 0,
    0,
    `${GAME_LABEL} BinkCopyToBuffer 仍在走不安全的串口 hypercall 边界`,
  );

  await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  await page.waitForTimeout(1_000);
  const campaignHoverPlayBefore =
    callsOf(await canvas.getAttribute('data-vm-audio-calls'))['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  await clickUntilShellPage(page, canvas, 'campaign', ...SINGLE_PLAYER_CAMPAIGN);
  await page.waitForTimeout(1_000);
  await probeCampaignHover(page, canvas, campaignHoverPlayBefore);
  const campaignVideoOpensBefore =
    callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkOpen@8'] ?? 0;
  const campaignVideoAudioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  // 离开 shell 只代表进入战役简报，不能当作战场。必须等右侧栏和地图主体
  // 同时真正渲染出来，才开始验证 Pointer Lock。每一轮只点击一次，然后等待
  // 原版完成 CampaignMenu 的同步销毁；不能在进入重试循环前额外点击一次，否则
  // 会把普通单击变成人为双击，撞进旧窗口销毁/新窗口创建的重入区。
  const alliedOffsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [0, -10],
    [0, 10],
  ] as const;
  for (const [offsetX, offsetY] of alliedOffsets) {
    if (!(await canvas.getAttribute('data-shell-page'))) break;
    await clickGuest(page, canvas, 454 + offsetX, 188 + offsetY);
    try {
      await page.waitForFunction(
        () => !document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage,
        undefined,
        { timeout: 4_000 },
      );
      break;
    } catch {
      const rawStatus = await canvas.getAttribute('data-vm-status');
      if (rawStatus) {
        const status = JSON.parse(rawStatus) as { phase: string; detail: string };
        if (status.phase === 'error' || status.phase === 'blocked') {
          throw new Error(`选择阵营中断：${status.phase}：${status.detail}`);
        }
      }
      // CampaignMenu 重绘期间吞点击时，仅在仍有 shell title 时重试。
    }
  }
  assert.equal(await canvas.getAttribute('data-shell-page'), null, '选择盟军后仍停在 CampaignMenu');
  await probeAndSkipCampaignVideo(page, canvas, campaignVideoOpensBefore, campaignVideoAudioBefore);
  const battlefieldVideoBinkBefore = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const battlefieldVideoAudioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  // YR 的 shell/战役简报固定保持 800×600，进入真实战场时才读取 RA2MD.INI
  // 切到所选模式；先等分辨率切换，避免把 800×600 简报误判成可操作战场。
  await page.waitForFunction(
    () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmResolution === '1440x900',
    undefined,
    { timeout: 70_000 },
  );
  const playable = await waitForPlayableBattle(page, canvas, 70_000);
  console.log(
    `🔬 可操作战场：等待=${(playable.elapsedMs / 1_000).toFixed(1)}s，` +
      `右栏=${playable.signal.rightEdgeRatio.toFixed(3)}，地图=${playable.signal.fieldRatio.toFixed(3)}`,
  );
  // 战场右上角 EVA/简报小窗是独立的 Bink 实例，不能用前面的全屏过场音频
  // 断言代替。持续观察其 Close 和 DirectSound 流；实例可能在战场可操作判定
  // 之前已经 Open，因此以播放结束的 Close 增量作为稳定生命周期闸门。
  await page.waitForTimeout(8_000);
  const battlefieldVideoBinkAfter = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const battlefieldVideoAudioAfter = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  assert(
    (battlefieldVideoBinkAfter['BINKW32.DLL!_BinkClose@4'] ?? 0) >
      (battlefieldVideoBinkBefore['BINKW32.DLL!_BinkClose@4'] ?? 0),
    `${GAME_LABEL} 战场右上角过场 8 秒内没有完成 BinkClose`,
  );
  assert(
    (battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) >
      (battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0),
    `${GAME_LABEL} 战场右上角过场期间 DirectSound PCM 没有持续写入`,
  );
  console.log(
    `🔬 战场右上角过场：BinkOpen=${battlefieldVideoBinkBefore['BINKW32.DLL!_BinkOpen@8'] ?? 0}` +
      `→${battlefieldVideoBinkAfter['BINKW32.DLL!_BinkOpen@8'] ?? 0}，` +
      `BinkClose=${battlefieldVideoBinkBefore['BINKW32.DLL!_BinkClose@4'] ?? 0}` +
      `→${battlefieldVideoBinkAfter['BINKW32.DLL!_BinkClose@4'] ?? 0}，` +
      `buffer=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0}，` +
      `Play=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0}，` +
      `Lock=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0}`,
  );
  const battleFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
  const battleResolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [battleWidth, battleHeight] = battleResolution.split('x').map(Number);
  assert(
    Number.isFinite(battleWidth) && Number.isFinite(battleHeight),
    `${GAME_LABEL} 战场分辨率探针无效：${battleResolution}`,
  );
  assert.equal(battleResolution, '1440x900', `${GAME_LABEL} 未采用内存 INI 覆盖的 1440x900 战场分辨率`);
  const expectedPointer = `${battleWidth! - 1},${battleHeight! - 1}/${battleResolution}`;

  // Esc 跳过影片后 Pointer Lock 已退出。先用 Playwright 的真实浏览器点击重新
  // 获锁。无头 Chromium 不会为 CDP 注入的后续 mouse.move 生成相对 movementX/Y，
  // 因此在“真实 document.pointerLockElement 已建立”的前提下用 PointerEvent 探针
  // 注入相对计数，覆盖页面换算→Worker→USER32，而不把自动化限制误当产品回归。
  const battleBox = await canvas.boundingBox();
  if (!battleBox) throw new Error('战场 canvas 不可见');
  await page.mouse.click(battleBox.x + 4, battleBox.y + 4);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', undefined, { timeout: 5_000 });
  assert.equal(
    await page.evaluate(() => document.pointerLockElement?.id),
    'screen',
    `${GAME_LABEL} 浏览器没有真实进入 Pointer Lock`,
  );
  await moveLockedGuest(
    page,
    canvas,
    battleWidth! - 1,
    battleHeight! - 1,
    battleWidth!,
    battleHeight!,
    battleBox.width,
    battleBox.height,
  );
  // CSS→逻辑坐标是分数比例，第一拍 floor 后可能停在倒数 1px；真实鼠标仍会
  // 继续向边缘产生计数。补一个完整画布的正向 sweep，最终必须严格钳在边界，
  // 既不能停在旧分辨率，也不能让超量相对移动越界。
  await page.waitForTimeout(100);
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: battleBox.width,
    movementY: battleBox.height,
  });
  await page.waitForTimeout(500);
  assert.equal(
    await canvas.getAttribute('data-vm-cursor'),
    expectedPointer,
    `Pointer Lock 前端未采用战场 ${battleResolution} 边界`,
  );
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmWorkerCursor === expected,
    expectedPointer,
    { timeout: 5_000 },
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-client'),
    battleResolution,
    `客体 GetClientRect 仍未采用战场 ${battleResolution} 边界`,
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-key'),
    '0x101:27',
    '浏览器 Esc 解锁后没有向客体补齐 WM_KEYUP/VK_ESCAPE',
  );

  // 当前工具栏已移除旧 data-game-speed 按钮；保留原生速度观察边缘卷动，
  // 不再等待不存在的 UI，也不通过改客体速度字段制造性能收益。
  // 覆盖此前 Bink 返回后延迟发生的 PIT/线程上下文损坏。
  await page.waitForTimeout(10_000);
  assert(Number((await canvas.getAttribute('data-vm-frame')) ?? 0) > battleFrame, '战场画面停止更新');
  assert.equal(
    await canvas.getAttribute('data-vm-cursor'),
    expectedPointer,
    '战场运行 10 秒后前端鼠标边界退回旧分辨率',
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-cursor'),
    expectedPointer,
    '战场运行 10 秒后 Worker 鼠标边界退回旧分辨率',
  );
  assert.equal(await problem.count(), 0, '战场出现运行错误');
  assert.deepEqual(pageErrors, [], `浏览器页面异常：${pageErrors.join('\n')}`);
  const finalFrontPointer = await canvas.getAttribute('data-vm-cursor');
  const finalWorkerPointer = await canvas.getAttribute('data-vm-worker-cursor');
  const textOutCalls = Number((await canvas.getAttribute('data-vm-text-out-calls')) ?? 0);

  // 当前原生 select 已隐藏，由自绘 listbox 触发 change；操作真实可见选项，
  // 覆盖安全销毁 VM→reload→恢复偏好，不能等待隐藏 select 的可操作性。
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#vm-resolution-toggle').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
    page.locator('#vm-resolution-options').getByRole('option', { name: '1024×768', exact: true }).click(),
  ]);
  // 开发目录不作为玩家归档缓存；重载后仍需显式选择开发资源。
  await page.getByRole('button', { name: '开发测试', exact: true }).click();
  await page
    .locator('.detected-games button')
    .nth(GAME_ID === 'ra2' ? 0 : 1)
    .click();
  await expectShellPage(page, 'mainmenu', 60_000);
  assert.equal(
    await page.locator('#vm-resolution').inputValue(),
    '1024x768',
    `${GAME_LABEL} 重启后没有恢复新选择的分辨率`,
  );
  assert.equal(
    await page.evaluate((gameId) => localStorage.getItem(`vm-resolution-${gameId}`), GAME_ID),
    '1024x768',
    `${GAME_LABEL} 分辨率没有按游戏持久化`,
  );
  assert.deepEqual(pageErrors, [], `分辨率重启后浏览器页面异常：${pageErrors.join('\n')}`);
  console.log(
    `✅ ${GAME_LABEL} Chromium Worker：主菜单视频连续播放，战役流程持续运行，` +
      `Pointer Lock 前端=${finalFrontPointer}，Worker=${finalWorkerPointer}；` +
      `禁用宿主字体时 TextOutA 调用=${textOutCalls}；` +
      `控制栏切换 1024×768 后已安全重启并恢复偏好`,
  );
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}
