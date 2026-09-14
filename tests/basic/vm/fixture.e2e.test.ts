/**
 * 合成 PE 端到端冒烟：CI 上无原版游戏资源也能守住核心回归——
 * PE 装载、hypercall 握手、堆/虚拟内存、文件读取、临界区、
 * WndProc 回调跳板（SendMessage 同步 + GetMessage/DispatchMessage 泵）、
 * Sleep 挂起唤醒、ExitProcess 退出码。
 *
 * 客体程序在每个检查点失败时以步骤码调用 ExitProcess，非零退出码即步骤号。
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_ABI } from '../../fixture/fixtureProgram';
import { runFixture, type FixtureMode } from '../../fixture/runFixture';

/** 两种模式下都必须真实 hypercall 过的导入（fast 模式里 _lread/临界区走客体内桩）。 */
const COMMON_EXPECTED_CALLS = [
  'KERNEL32.DLL!GetVersion',
  'KERNEL32.DLL!GetCommandLineA',
  'KERNEL32.DLL!lstrlenA',
  'KERNEL32.DLL!HeapCreate',
  'KERNEL32.DLL!HeapAlloc',
  'KERNEL32.DLL!HeapFree',
  'KERNEL32.DLL!VirtualAlloc',
  'KERNEL32.DLL!VirtualFree',
  'KERNEL32.DLL!_lopen',
  'KERNEL32.DLL!_llseek',
  'KERNEL32.DLL!_lclose',
  'KERNEL32.DLL!CreateFileA',
  'KERNEL32.DLL!DeleteCriticalSection',
  'KERNEL32.DLL!Sleep',
  'KERNEL32.DLL!ExitProcess',
  'USER32.DLL!RegisterClassA',
  'USER32.DLL!CreateWindowExA',
  'USER32.DLL!SendMessageA',
  'USER32.DLL!PostMessageA',
  'USER32.DLL!PostQuitMessage',
  'USER32.DLL!GetMessageA',
  'USER32.DLL!DispatchMessageA',
  'USER32.DLL!DefWindowProcA',
];
/** fast 模式下被客体内高速桩接管、不产生 hypercall 的导入。 */
const FAST_PATH_CALLS = [
  'KERNEL32.DLL!_lread',
  'KERNEL32.DLL!InitializeCriticalSection',
  'KERNEL32.DLL!EnterCriticalSection',
  'KERNEL32.DLL!LeaveCriticalSection',
  // ra2 起 GetLastError/SetLastError 在 fast 模式直读共享页，不过 host。
  'KERNEL32.DLL!GetLastError',
];

describe.each(['slow', 'fast'] as FixtureMode[])('fixture PE 端到端（%s 模式）', (mode) => {
  it('全部检查点通过，ExitProcess(0)', async () => {
    const result = await runFixture(mode);
    // 退出码非 0 时是客体自检失败的步骤号（见 fixtureProgram.ts 头部清单）。
    expect(result.exitCode).toBe(0);
    expect(result.firstCall).toBe('KERNEL32.DLL!GetVersion');

    for (const key of COMMON_EXPECTED_CALLS) {
      expect(result.callCounts.get(key) ?? 0, `缺少 hypercall: ${key}`).toBeGreaterThanOrEqual(1);
    }
    // 消息泵往返次数精确匹配：3×WM_USER + WM_QUIT。
    expect(result.callCounts.get('USER32.DLL!GetMessageA')).toBe(4);
    expect(result.callCounts.get('USER32.DLL!DispatchMessageA')).toBe(3);
    expect(result.callCounts.get('USER32.DLL!PostMessageA')).toBe(3);
    expect(result.callCounts.get('USER32.DLL!SendMessageA')).toBe(2);

    if (mode === 'slow') {
      // 慢速模式全部导入都过 host：fast 路径导入也要各出现预期次数。
      expect(result.callCounts.get('KERNEL32.DLL!_lread')).toBe(2);
      for (const key of FAST_PATH_CALLS.slice(1)) {
        expect(result.callCounts.get(key) ?? 0, `缺少 hypercall: ${key}`).toBeGreaterThanOrEqual(1);
      }
      expect(result.callCounts.get('KERNEL32.DLL!EnterCriticalSection')).toBe(2);
      expect(result.callCounts.get('KERNEL32.DLL!LeaveCriticalSection')).toBe(2);
    } else {
      // 快速模式：_lread 与无竞争的临界区 Enter/Leave 在客体内完成。
      for (const key of FAST_PATH_CALLS) {
        expect(result.callCounts.get(key) ?? 0, `${key} 不应产生 hypercall`).toBe(0);
      }
    }
    // 覆盖完整性：fixture ABI 里的每个导入要么被调用、要么被快速桩接管。
    for (const key of Object.keys(FIXTURE_ABI)) {
      const called = (result.callCounts.get(key) ?? 0) > 0;
      const fastPathed = mode === 'fast' && FAST_PATH_CALLS.includes(key);
      expect(called || fastPathed, `fixture 未覆盖导入: ${key}`).toBe(true);
    }
  }, 60_000);
});
