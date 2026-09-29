import { describe, expect, it, vi } from 'vitest';
import { RA2_RUNTIME_HOOKS } from '../../src/games/ra2/runtimeHooks';
import { YR_RUNTIME_HOOKS } from '../../src/games/yr/runtimeHooks';
import { resolveNativeLayout } from '../../src/games/shared/nativeLayout';
import { RA2_SETTINGS_SIGNATURE } from '../../src/games/ra2/performance';
import { adaptiveImage } from '../fixture/adaptiveImage';
import { readU32, writeU32 } from '../helpers/guestMemory';

const resolve = (f: ReturnType<typeof adaptiveImage>, game: 'ra2' | 'yr') =>
  (game === 'ra2' ? RA2_RUNTIME_HOOKS : YR_RUNTIME_HOOKS).resolve!(f.memory, f.exe);

describe.each(['ra2', 'yr'] as const)('%s adaptive addresses', (game) => {
  it.each([0, 0x60])('uses moved operands and linked native handlers (shift %s)', (shift) => {
    const f = adaptiveImage(game, 0x500000, shift, 'edx');
    const hooks = resolve(f, game);
    const settings = 0x120000;
    writeU32(f.memory, f.pointer, settings);
    writeU32(f.memory, settings + f.settingsOffset, 3);
    expect(hooks.writeGameSpeedFlag!(f.memory, 5)).toBe(5);
    expect(readU32(f.memory, settings + f.settingsOffset)).toBe(5);
    let next = 0x90000;
    hooks.prepareStartupPage!(f.memory, 'battle', 'unregistered binary', (size) => {
      const at = next;
      next += size;
      return at;
    });
    expect(f.memory.read_memory(f.menu, 1)[0]).toBe(0xe9);
    expect(f.memory.read_memory(f.battle, 1)[0]).toBe(0xe9);
    const battleCode = f.memory.read_memory(0x90000, 80);
    expect(0x90000 + 37 + new DataView(battleCode.buffer, battleCode.byteOffset).getInt32(33, true)).toBe(f.handler);
    expect(() => hooks.prepareStartupPage!(f.memory, 'battle', '', () => 0x91000)).toThrow('签名');
  });

  it('rejects a changed live settings initializer before writing even a plausible target', () => {
    const f = adaptiveImage(game);
    const hooks = resolve(f, game);
    writeU32(f.memory, f.pointer, 0x120000);
    writeU32(f.memory, 0x120000 + f.settingsOffset, 3);
    f.memory.write_memory([0x90], f.sites.settings);
    const write = vi.spyOn(f.memory, 'write_memory');
    expect(hooks.writeGameSpeedFlag!(f.memory, 5)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses ambiguous menu matches without allocating or writing', () => {
    const f = adaptiveImage(game);
    f.patch(f.base + 0x1c00, f.memory.read_memory(f.menu - 9, 36).slice());
    const hooks = resolve(f, game);
    const allocate = vi.fn();
    const write = vi.spyOn(f.memory, 'write_memory');
    expect(() => hooks.prepareStartupPage!(f.memory, 'skirmish', '', allocate)).toThrow('唯一');
    expect(allocate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('validates all network sites before allocating or publishing any patch', () => {
    const f = adaptiveImage(game);
    const hooks = resolve(f, game);
    f.memory.write_memory([0], f.negotiate + 5);
    const allocate = vi.fn(() => 0xc0000);
    const write = vi.spyOn(f.memory, 'write_memory');
    expect(() => hooks.prepareNetwork!(f.memory, allocate)).toThrow('签名');
    expect(allocate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('installs network stubs at resolved sites and rejects repeat installation', () => {
    const f = adaptiveImage(game, 0x500000, 0x40);
    const hooks = resolve(f, game);
    const allocate = vi.fn(() => 0xc0000);
    expect(hooks.prepareNetwork!(f.memory, allocate)).toBe(true);
    expect(allocate).toHaveBeenCalledTimes(4);
    expect(f.memory.read_memory(f.report + 2, 1)[0]).toBe(31);
    expect([...f.memory.read_memory(f.negotiate + 5, 2)]).toEqual([0xa8, 63]);
    expect(() => hooks.prepareNetwork!(f.memory, allocate)).toThrow('重复');
  });
});

it('does not substitute fixed addresses when the PE or cross references are unsupported', () => {
  const f = adaptiveImage('ra2');
  f.patchWord(f.menu - 8, f.session); // Valid data, wrong session reference.
  const layout = resolveNativeLayout(f.memory, f.exe, {
    settingsSignature: RA2_SETTINGS_SIGNATURE,
    menuRegister: 0xbd,
  });
  expect(layout?.menu).toBeNull();
  f.exe[0] = 0;
  const hooks = resolve(f, 'ra2');
  const write = vi.spyOn(f.memory, 'write_memory');
  hooks.prepareImage!(f.memory);
  hooks.beforeHostMessage!(f.memory, 0x202);
  expect(hooks.writeGameSpeedFlag!(f.memory, 5)).toBeNull();
  expect(hooks.prepareNetwork!(f.memory, () => 0xc0000)).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it('keeps independent layouts for simultaneous VM instances', () => {
  const a = adaptiveImage('ra2', 0x400000);
  const b = adaptiveImage('ra2', 0x500000, 0x60);
  const first = resolve(a, 'ra2');
  const second = resolve(b, 'ra2');
  for (const f of [a, b]) {
    writeU32(f.memory, f.pointer, 0x120000);
    writeU32(f.memory, 0x120000 + f.settingsOffset, 3);
  }
  expect(second.writeGameSpeedFlag!(b.memory, 2)).toBe(2);
  expect(first.writeGameSpeedFlag!(a.memory, 5)).toBe(5);
  expect(readU32(b.memory, 0x120000 + b.settingsOffset)).toBe(2);
});

it('does not publish any network entry if a later stub allocation fails', () => {
  const f = adaptiveImage('ra2');
  const hooks = resolve(f, 'ra2');
  const before = f.lanSites.map((site) => f.memory.read_memory(site, 5).slice());
  let allocations = 0;
  expect(() =>
    hooks.prepareNetwork!(f.memory, () => {
      if (++allocations === 3) throw new Error('allocator exhausted');
      return 0xc0000 + allocations * 0x100;
    }),
  ).toThrow('allocator exhausted');
  f.lanSites.forEach((site, i) => expect(f.memory.read_memory(site, 5)).toEqual(before[i]));
});

it('repairs only the validated RA2 field and ignores stale evidence, other messages and YR', () => {
  const f = adaptiveImage('ra2', 0x500000, 0x40);
  const hooks = resolve(f, 'ra2');
  writeU32(f.memory, f.pointer, 0x120000);
  const field = 0x120000 + f.repairOffset;
  const view = new DataView(f.memory.bytes.buffer);
  view.setFloat64(field, 0, true);
  hooks.beforeHostMessage!(f.memory, 0x100);
  expect(view.getFloat64(field, true)).toBe(0);
  hooks.beforeHostMessage!(f.memory, 0x202);
  expect(view.getFloat64(field, true)).toBe(0.016);
  view.setFloat64(field, 0.025, true);
  hooks.beforeHostMessage!(f.memory, 0x202);
  expect(view.getFloat64(field, true)).toBe(0.025);
  f.memory.write_memory([0x90], f.repair);
  view.setFloat64(field, 0, true);
  hooks.beforeHostMessage!(f.memory, 0x202);
  expect(view.getFloat64(field, true)).toBe(0);
  const yr = adaptiveImage('yr');
  const write = vi.spyOn(yr.memory, 'write_memory');
  resolve(yr, 'yr').beforeHostMessage!(yr.memory, 0x202);
  expect(write).not.toHaveBeenCalled();
});
