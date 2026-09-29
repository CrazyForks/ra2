import type { GuestMemory } from '../../vm86/win32';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { resolveNativeLayout, matchesLoaded, type NativeLayoutPolicy } from './nativeLayout';
import { applyNativePatches, type NativePatchPlan } from './nativePatches';
import { writeGameSpeedFlag } from './gameSpeedFlag';
import { readU32, readF64, writeF64 } from './guestMemoryIO';
import { installStartupTrampoline } from './startupTrampoline';
import { installBattleStartup } from './battleStartup';
import { makeLanStartupTiming, lanTimingCall } from './lanStartupTiming';

export interface AdaptiveRuntimePolicy extends NativeLayoutPolicy {
  label: string;
  initialSendRate: number;
  repairInvalidRate: boolean;
  createFrameReader: NonNullable<GameRuntimeHooks['createFrameReader']>;
  patches: (layout: NonNullable<ReturnType<typeof resolveNativeLayout>>) => (NativePatchPlan | null)[];
}

/** One immutable resolution per VM. No shared executable mutation or process-global address cache. */
export function createAdaptiveRuntimeHooks(
  memory: GuestMemory,
  exe: Uint8Array,
  policy: AdaptiveRuntimePolicy,
): GameRuntimeHooks {
  const layout = resolveNativeLayout(memory, exe, policy);
  const plans = layout ? policy.patches(layout) : [];
  const unsupported = () => new Error(`${policy.label}：无法唯一识别原生启动入口或指令签名不匹配`);
  return {
    createFrameReader: policy.createFrameReader,
    prepareImage(memory) {
      if (plans.some((plan) => plan && !matchesLoaded(memory, plan.evidence)))
        throw new Error(`${policy.label}：兼容补丁指令签名不匹配`);
      for (const plan of plans) {
        if (plan && !applyNativePatches(memory, plan)) throw new Error(`${policy.label}：兼容补丁指令签名不匹配`);
      }
    },
    prepareStartupPage(memory, page, hash, reserve) {
      if (!['lan', 'skirmish', 'battle'].includes(page)) throw new Error(`${policy.label}：不支持启动页面 ${page}`);
      const menu = layout?.menu;
      if (!menu || !matchesLoaded(memory, menu.evidence)) throw unsupported();
      const navigate = (m: GuestMemory, allocate: (size: number) => number) =>
        installStartupTrampoline(m, allocate, hash, {
          label: policy.label,
          site: menu.site,
          signature: menu.signature,
          movOperand: menu.movOperand,
          target: page === 'lan' ? 3 : 11,
        });
      if (page !== 'battle') {
        navigate(memory, reserve);
        return;
      }
      const battle = layout?.battle;
      if (!battle || !matchesLoaded(memory, battle.evidence)) throw unsupported();
      installBattleStartup(memory, reserve, hash, {
        label: policy.label,
        site: battle.site,
        handler: battle.handler,
        navigate,
      });
    },
    writeGameSpeedFlag(memory, value) {
      const settings = layout?.settings;
      if (!settings || !matchesLoaded(memory, settings.evidence)) return null;
      return writeGameSpeedFlag(memory, settings.pointer, settings.offset, value);
    },
    beforeHostMessage(memory, message) {
      const repair = policy.repairInvalidRate && layout?.repair;
      if (!repair || message < 0x200 || message > 0x20e || !matchesLoaded(memory, repair.evidence)) return;
      try {
        const rules = readU32(memory, repair.pointer);
        if (rules < 0x100000 || rules >= 0x10000000) return;
        const address = rules + repair.offset;
        const value = readF64(memory, address);
        if (!Number.isFinite(value) || value <= 0) writeF64(memory, address, 0.016);
      } catch {
        /* No live Rules object yet; preserve native input handling. */
      }
    },
    prepareNetwork(memory, allocateCode) {
      const lan = layout?.lan;
      if (!lan) return false;
      if (!matchesLoaded(memory, lan.evidence)) throw new Error(`${policy.label} LAN：指令签名不匹配或重复安装`);
      const patches = lan.sites.map((site) => ({
        address: site.address,
        bytes: lanTimingCall(
          site.address,
          allocateCode(
            makeLanStartupTiming(
              layout.counters.sessionSpeed,
              layout.counters.requestedFps,
              site.bytes[0]!,
              policy.initialSendRate,
            ),
          ),
        ),
      }));
      for (const patch of patches) memory.write_memory(patch.bytes, patch.address);
      memory.write_memory([31], lan.report.address + 2);
      memory.write_memory([0xa8, 63], lan.negotiate.address + 5);
      return true;
    },
    crashHint(vector, eip) {
      if (policy.repairInvalidRate && vector === 0 && layout?.restorationFault === eip)
        return '；存档对象引用恢复失败：对象数据缺失或不一致。旧版保存缺陷生成的不完整存档无法补回丢失的数据；请开始新游戏并创建新存档。';
      return vector === 0 && layout?.repair?.divide === eip ? `；${policy.label} 原生 RepairRate 除数无效` : '';
    },
  };
}
