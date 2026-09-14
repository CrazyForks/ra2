import { expect, it, vi } from 'vitest';
import { GamePerformanceMeter } from '../../src/adapter/gamePerformance';
import { createRa2FrameReader } from '../../src/games/ra2/performance';
import { createYrFrameReader } from '../../src/games/yr/performance';
import { RA2_STARTUP_PAGE_HASH } from '../../src/games/ra2/startupPage';
import { YR_STARTUP_PAGE_HASH } from '../../src/games/yr/startupPage';
import { createGuestMemory, writeU32 } from '../helpers/guestMemory';
import { summarizeGamePerformance } from '../helpers/gamePerformance';

const profiles = [
  {
    create: createRa2FrameReader,
    hash: RA2_STARTUP_PAGE_HASH,
    other: YR_STARTUP_PAGE_HASH,
    site: 0x540676,
    frame: 0xa40d2c,
    bytes: [
      0x8b, 0x15, 0x2c, 0x0d, 0xa4, 0, 0xa1, 0x74, 0x91, 0xab, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x2c, 0x0d, 0xa4, 0,
    ],
  },
  {
    create: createYrFrameReader,
    hash: YR_STARTUP_PAGE_HASH,
    other: RA2_STARTUP_PAGE_HASH,
    site: 0x55de73,
    frame: 0xa8ed84,
    bytes: [
      0x8b, 0x15, 0x84, 0xed, 0xa8, 0, 0xa1, 0x84, 0x77, 0xb0, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x84, 0xed, 0xa8, 0,
    ],
  },
];
it.each(profiles)('帧计数仅接受自己的 EXE 和指令签名，采样不写内存：$site', (p) => {
  const memory = createGuestMemory();
  memory.write_memory(p.bytes, p.site);
  writeU32(memory, p.frame, 321);
  const write = vi.spyOn(memory, 'write_memory');
  expect(p.create(memory, p.other)).toBeNull();
  expect(p.create(memory, p.hash)!()?.frame).toBe(321);
  expect(write).not.toHaveBeenCalled();
  memory.write_memory([0x90], p.site);
  expect(p.create(memory, p.hash)).toBeNull();
});
const counters = (frame: number) => ({ frame, gameSpeed: 0, sessionSpeed: 0, requestedFps: 60 });
it('目标 60 不冒充实际 FPS；停滞为零，菜单/重置/同时间不产生假峰值', () => {
  const meter = new GamePerformanceMeter();
  expect(meter.sample(counters(10), 100, true).logicFps).toBeNull();
  expect(meter.sample(counters(40), 1100, true).logicFps).toBe(30);
  expect(meter.sample(counters(40), 2100, true).logicFps).toBe(0);
  expect(meter.sample(counters(1), 3100, true).status).toBe('reset');
  expect(meter.sample(counters(2), 3100, true).logicFps).toBeNull();
  expect(meter.sample(counters(3), 3200, false).status).toBe('inactive');
  expect(meter.sample(counters(4), 3300, true).status).toBe('baseline');
});
it('按实际窗口时长加权，预热不足返回不可用，重置使报告失效', () => {
  const meter = new GamePerformanceMeter();
  const samples = [
    [0, 0],
    [30, 1000],
    [150, 3000],
    [150, 4000],
    [150, 5000],
  ].map(([frame, at]) => meter.sample(counters(frame!), at!, true));
  expect(summarizeGamePerformance(samples)).toMatchObject({
    logicFps: 30,
    windowFpsP05: 0,
    maxObservedStallMs: 2000,
    valid: true,
  });
  expect(summarizeGamePerformance(samples, 30000)).toBeNull();
  samples.push(meter.sample(counters(0), 6000, true));
  expect(summarizeGamePerformance(samples)).toMatchObject({ valid: false, invalidWindows: 1 });
});
