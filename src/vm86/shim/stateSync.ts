/**
 * 客体同步对象与协作式调度（mixin 拆分自 state.ts）：
 * Event/Mutex/临界区、WaitFor* 语义与线程选择。
 * 挂在文件与 DLL 层之后、kernel32 分派之前。
 */
import type { PeImport } from '../win32';
import {
  GUEST_SCHEDULER_TICKS,
  GUEST_THREAD_CONTEXT_ESPS,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_RUN_STATES,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_THREAD_NEXT,
} from '../pe';
import type { Constructor, GuestEventObject, GuestMutexObject, GuestThreadState, GuestWaitState } from './state';
import type { ShimGuestDllChain } from './stateGuestDll';

export type ShimSyncChain = InstanceType<ReturnType<typeof withShimSync>>;

export function withShimSync<TBase extends Constructor<ShimGuestDllChain>>(Base: TBase) {
  return class extends Base {
    /** 同步对象句柄；若 profile 保留 launcher 哨兵，则从其后开始。 */
    protected nextSyncHandle: number;
    protected readonly guestEvents = new Map<number, GuestEventObject>();
    protected readonly namedGuestEvents = new Map<string, GuestEventObject>();
    protected readonly guestMutexes = new Map<number, GuestMutexObject>();
    protected readonly namedGuestMutexes = new Map<string, GuestMutexObject>();

    constructor(...args: any[]) {
      super(...args);
      this.nextSyncHandle = (this.gameProfile.launcher?.handle ?? 0x0001_001f) + 1;
    }

    private allocateGuestSyncHandle(): number {
      while (
        this.guestEvents.has(this.nextSyncHandle) ||
        this.guestMutexes.has(this.nextSyncHandle) ||
        this.guestThreadHandles.has(this.nextSyncHandle)
      )
        this.nextSyncHandle++;
      return this.nextSyncHandle++;
    }

    private duplicateGuestEvent(object: GuestEventObject): number {
      const handle = this.allocateGuestSyncHandle();
      object.handles.add(handle);
      this.guestEvents.set(handle, object);
      return handle;
    }

    protected createGuestEvent(manualReset: boolean, initialState: boolean, name: string): number {
      const normalized = name.toLowerCase();
      const existing = normalized ? this.namedGuestEvents.get(normalized) : undefined;
      if (existing) {
        this.lastError = 183; // ERROR_ALREADY_EXISTS
        return this.duplicateGuestEvent(existing);
      }
      const object: GuestEventObject = {
        manualReset,
        signaled: initialState,
        name: normalized,
        handles: new Set(),
      };
      if (normalized) this.namedGuestEvents.set(normalized, object);
      this.lastError = 0;
      return this.duplicateGuestEvent(object);
    }

    protected openGuestEvent(name: string): number {
      const object = this.namedGuestEvents.get(name.toLowerCase());
      if (!object) {
        this.lastError = 2; // ERROR_FILE_NOT_FOUND
        return 0;
      }
      this.lastError = 0;
      return this.duplicateGuestEvent(object);
    }

    protected setGuestEvent(handle: number): boolean {
      const event = this.guestEvents.get(handle);
      if (!event) {
        this.lastError = 6; // ERROR_INVALID_HANDLE
        return false;
      }
      event.signaled = true;
      this.lastError = 0;
      this.wakeGuestWaiters();
      return true;
    }

    protected resetGuestEvent(handle: number): boolean {
      const event = this.guestEvents.get(handle);
      if (!event) {
        this.lastError = 6;
        return false;
      }
      event.signaled = false;
      this.lastError = 0;
      return true;
    }

    private duplicateGuestMutex(object: GuestMutexObject): number {
      const handle = this.allocateGuestSyncHandle();
      object.handles.add(handle);
      this.guestMutexes.set(handle, object);
      return handle;
    }

    protected createGuestMutex(initialOwner: boolean, name: string): number {
      const normalized = name.toLowerCase();
      const existing = normalized ? this.namedGuestMutexes.get(normalized) : undefined;
      if (existing) {
        this.lastError = 183;
        return this.duplicateGuestMutex(existing);
      }
      const object: GuestMutexObject = {
        ownerThreadId: initialOwner ? this.readU32(HYPERCALL_THREAD_CURRENT) : null,
        recursion: initialOwner ? 1 : 0,
        abandoned: false,
        name: normalized,
        handles: new Set(),
      };
      if (normalized) this.namedGuestMutexes.set(normalized, object);
      this.lastError = 0;
      return this.duplicateGuestMutex(object);
    }

    protected openGuestMutex(name: string): number {
      const object = this.namedGuestMutexes.get(name.toLowerCase());
      if (!object) {
        this.lastError = 2;
        return 0;
      }
      this.lastError = 0;
      return this.duplicateGuestMutex(object);
    }

    protected releaseGuestMutex(handle: number): boolean {
      const mutex = this.guestMutexes.get(handle);
      if (!mutex) {
        this.lastError = 6;
        return false;
      }
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      if (mutex.ownerThreadId !== currentId || mutex.recursion <= 0) {
        this.lastError = 288; // ERROR_NOT_OWNER
        return false;
      }
      mutex.recursion--;
      if (mutex.recursion === 0) mutex.ownerThreadId = null;
      this.lastError = 0;
      if (mutex.ownerThreadId === null) this.wakeGuestWaiters();
      return true;
    }

    protected closeGuestSyncHandle(handle: number): boolean {
      const event = this.guestEvents.get(handle);
      if (event) {
        this.guestEvents.delete(handle);
        event.handles.delete(handle);
        if (event.handles.size === 0 && event.name) this.namedGuestEvents.delete(event.name);
        this.wakeGuestWaiters();
        return true;
      }
      const mutex = this.guestMutexes.get(handle);
      if (!mutex) return false;
      this.guestMutexes.delete(handle);
      mutex.handles.delete(handle);
      if (mutex.handles.size === 0 && mutex.name) this.namedGuestMutexes.delete(mutex.name);
      this.wakeGuestWaiters();
      return true;
    }

    /**
     * 返回 WAIT_OBJECT_0+n / WAIT_ABANDONED_0+n / WAIT_TIMEOUT / WAIT_FAILED。
     * 非零超时且条件未满足时先返回 WAIT_OBJECT_0 占位；import stub 会保存该线程
     * 的返回上下文，真正唤醒时再覆写保存的 EAX。
     */
    protected waitForGuestObjects(handles: number[], waitAll: boolean, timeout: number): number {
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      const current = this.guestThreads.get(currentId);
      if (
        !current ||
        handles.length === 0 ||
        handles.length > 64 ||
        handles.some((handle) => !this.isGuestWaitHandle(handle))
      ) {
        this.lastError = 6;
        return 0xffff_ffff;
      }
      const wait: GuestWaitState = { handles: [...handles], waitAll };
      const ready = this.evaluateGuestWait(wait, currentId, true);
      if (ready !== null) {
        this.lastError = 0;
        return ready;
      }
      if (timeout === 0) {
        this.lastError = 0;
        return 0x0000_0102; // WAIT_TIMEOUT
      }
      if (timeout !== 0xffff_ffff) wait.deadline = this.clock.now() + timeout;
      current.wait = wait;
      current.waitResult = undefined;
      this.lastError = 0;
      return 0; // 返回值在唤醒/超时时修正
    }

    private isGuestWaitHandle(handle: number): boolean {
      return (
        handle === this.gameProfile.launcher?.handle ||
        handle === 0xffff_fffe ||
        this.guestEvents.has(handle) ||
        this.guestMutexes.has(handle) ||
        this.guestThreadHandles.has(handle)
      );
    }

    private evaluateGuestWait(wait: GuestWaitState, threadId: number, consume: boolean): number | null {
      if (wait.handles.some((handle) => !this.isGuestWaitHandle(handle))) return 0xffff_ffff;
      const ready = wait.handles.map((handle) => {
        if (handle === this.gameProfile.launcher?.handle) return true;
        const targetId = handle === 0xffff_fffe ? threadId : this.guestThreadHandles.get(handle);
        if (targetId !== undefined) return this.guestThreads.get(targetId)?.terminated === true;
        const event = this.guestEvents.get(handle);
        if (event) return event.signaled;
        const mutex = this.guestMutexes.get(handle)!;
        return mutex.ownerThreadId === null || mutex.ownerThreadId === threadId;
      });
      const selected = wait.waitAll ? (ready.every(Boolean) ? 0 : -1) : ready.findIndex(Boolean);
      if (selected < 0) return null;
      if (!consume) return selected;

      let abandonedIndex = -1;
      const indices = wait.waitAll ? wait.handles.map((_, index) => index) : [selected];
      for (const index of indices) {
        const handle = wait.handles[index]!;
        const event = this.guestEvents.get(handle);
        if (event && !event.manualReset) event.signaled = false;
        const mutex = this.guestMutexes.get(handle);
        if (mutex) {
          if (mutex.abandoned && abandonedIndex < 0) abandonedIndex = index;
          mutex.abandoned = false;
          mutex.ownerThreadId = threadId;
          mutex.recursion++;
        }
      }
      if (abandonedIndex >= 0) return 0x0000_0080 + abandonedIndex;
      return wait.waitAll ? 0 : selected;
    }

    /** 客体结构是快、慢路径的共同真值。+16 保存内部等待者数（不暴露可用句柄）。 */
    protected initializeCriticalSection(pointer: number): void {
      this.zero(pointer, 24);
      this.writeU32(pointer + 4, 0xffff_ffff);
    }

    protected deleteCriticalSection(pointer: number): void {
      if (this.readU32(pointer + 16)) throw new Error('不能删除仍有等待线程的临界区');
      this.zero(pointer, 24);
    }

    private tryEnterCriticalSection(pointer: number, threadId: number): boolean {
      const owner = this.readU32(pointer + 12);
      if (owner !== 0 && owner !== threadId + 1) return false;
      const recursion = this.readU32(pointer + 8) + 1;
      this.writeU32(pointer + 8, recursion);
      this.writeU32(pointer + 12, threadId + 1);
      this.writeU32(pointer + 4, recursion - 1 + this.readU32(pointer + 16));
      return true;
    }

    protected enterCriticalSection(pointer: number): void {
      const threadId = this.readU32(HYPERCALL_THREAD_CURRENT);
      if (this.tryEnterCriticalSection(pointer, threadId)) return;
      const thread = this.guestThreads.get(threadId);
      if (!thread) throw new Error(`临界区等待线程不存在: ${threadId}`);
      thread.criticalSection = pointer;
      thread.waitResult = undefined;
      this.writeU32(pointer + 16, this.readU32(pointer + 16) + 1);
      this.writeU32(pointer + 4, this.readU32(pointer + 4) + 1);
    }

    protected leaveCriticalSection(pointer: number): void {
      const owner = this.readU32(HYPERCALL_THREAD_CURRENT) + 1;
      const recursion = this.readU32(pointer + 8);
      if (this.readU32(pointer + 12) !== owner || recursion === 0) {
        throw new Error(`线程 ${owner} 试图释放不属于自己的临界区 0x${pointer.toString(16)}`);
      }
      this.writeU32(pointer + 8, recursion - 1);
      this.writeU32(pointer + 4, recursion - 2 + this.readU32(pointer + 16));
      if (recursion === 1) {
        this.writeU32(pointer + 12, 0);
        this.wakeGuestCriticalWaiters();
      }
    }

    private wakeGuestCriticalWaiters(): void {
      for (const thread of this.guestThreads.values()) {
        const pointer = thread.criticalSection;
        if (pointer === undefined || thread.terminated || !this.tryEnterCriticalSection(pointer, thread.id)) continue;
        this.writeU32(pointer + 16, this.readU32(pointer + 16) - 1);
        this.writeU32(pointer + 4, this.readU32(pointer + 4) - 1);
        thread.criticalSection = undefined;
        this.completeGuestWait(thread, 0);
      }
    }

    private completeGuestWait(thread: GuestThreadState, result: number): void {
      thread.wait = undefined;
      thread.runnable = true;
      this.writeU32(GUEST_THREAD_RUN_STATES + thread.id * 4, 1);
      // 当前线程仍停在本次 Wait import 桩中，contextEsps 即使非零也只是上一次
      // 切换留下的旧帧地址；写 context+28 会破坏已经复用的活动栈。由 vmCore
      // 把结果写入本次共享 EAX。只有非当前等待线程才拥有可覆写的保存帧。
      if (thread.id === this.readU32(HYPERCALL_THREAD_CURRENT)) {
        thread.waitResult = result;
        return;
      }
      const context = this.readU32(GUEST_THREAD_CONTEXT_ESPS + thread.id * 4);
      if (context) this.writeU32(context + 28, result);
      else thread.waitResult = result;
    }

    private wakeGuestWaiters(): void {
      for (const thread of [...this.guestThreads.values()].sort((a, b) => a.id - b.id)) {
        if (!thread.wait || thread.terminated) continue;
        const result = this.evaluateGuestWait(thread.wait, thread.id, true);
        if (result !== null) this.completeGuestWait(thread, result);
      }
    }

    private abandonGuestMutexes(threadId: number): void {
      const seen = new Set<GuestMutexObject>();
      for (const mutex of this.guestMutexes.values()) {
        if (seen.has(mutex) || mutex.ownerThreadId !== threadId) continue;
        seen.add(mutex);
        mutex.ownerThreadId = null;
        mutex.recursion = 0;
        mutex.abandoned = true;
      }
      this.wakeGuestWaiters();
    }

    /** 在当前 hypercall 返回前更新线程状态，并选择下一条客体执行线。 */
    prepareGuestThreadReturn(
      call: { imported: PeImport; args: number[] },
      result: { delayMs?: number; threadExit?: boolean },
    ): number {
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      const current = this.guestThreads.get(currentId);
      const now = this.clock.now();
      // PIT 可以在两个 hypercall 之间把到期线程改回 runnable；在处理本次 API
      // 前先把固件侧状态合并回来，避免 host 仍把已运行的线程视作睡眠。
      const schedulerTicks = this.readU32(GUEST_SCHEDULER_TICKS);
      for (const thread of this.guestThreads.values()) {
        const runState = this.readU32(GUEST_THREAD_RUN_STATES + thread.id * 4);
        if (runState === 1 && !thread.terminated) {
          thread.runnable = true;
          thread.wakeAt = 0;
        } else if (runState >= 2 && ((schedulerTicks - (runState - 2)) | 0) >= 0) {
          thread.runnable = true;
          thread.wakeAt = 0;
          this.writeU32(GUEST_THREAD_RUN_STATES + thread.id * 4, 1);
        }
      }
      if (current) {
        if (result.threadExit) {
          current.terminated = true;
          current.runnable = false;
          this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, 0);
          this.releaseExitedThreadCallbacks(currentId);
          this.abandonGuestMutexes(currentId);
        } else if (call.imported.key === 'KERNEL32.DLL!Sleep') {
          const milliseconds = call.args[0] ?? 0;
          if (milliseconds > 0) {
            current.runnable = false;
            current.wakeAt = now + milliseconds;
            const ticks = Math.max(1, Math.ceil(this.clock.toHostDelay(milliseconds) / 10));
            this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, (schedulerTicks + ticks + 2) >>> 0);
          }
        } else if (result.delayMs && result.delayMs > 0) {
          current.runnable = false;
          current.wakeAt = now + this.clock.toGuestDelay(result.delayMs);
          const ticks = Math.max(1, Math.ceil(result.delayMs / 10));
          this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, (schedulerTicks + ticks + 2) >>> 0);
        }
        if (current.wait || current.criticalSection !== undefined) {
          current.runnable = false;
          this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, 0);
        }
      }
      return this.selectGuestThread(now, false, call.imported.key === 'KERNEL32.DLL!Sleep');
    }

    completeGuestThreadDelay(): { delayMs: number; result?: number } {
      const current = this.guestThreads.get(this.readU32(HYPERCALL_THREAD_CURRENT));
      const delayMs = this.selectGuestThread(this.clock.now(), true);
      const result = current?.waitResult;
      if (current) current.waitResult = undefined;
      return result === undefined ? { delayMs } : { delayMs, result };
    }

    private selectGuestThread(now: number, afterDelay = false, yielded = false): number {
      this.wakeGuestCriticalWaiters();
      for (const thread of this.guestThreads.values()) {
        if (thread.terminated) continue;
        if (thread.wait) {
          const ready = this.evaluateGuestWait(thread.wait, thread.id, true);
          if (ready !== null) this.completeGuestWait(thread, ready);
          else if (thread.wait.deadline !== undefined && now >= thread.wait.deadline) {
            this.completeGuestWait(thread, 0x0000_0102);
          }
        }
        if (!thread.runnable && thread.wakeAt > 0 && now >= thread.wakeAt) {
          thread.wakeAt = 0;
          thread.runnable = true;
          this.writeU32(GUEST_THREAD_RUN_STATES + thread.id * 4, 1);
        }
      }
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      // 兼容性原子执行区必须同时约束 host 和 PIT；普通 Win32 临界区允许调度。
      const current = this.guestThreads.get(currentId);
      if (current?.runnable && !current.terminated && this.readU32(GUEST_THREAD_CRITICAL_DEPTH + currentId * 4) > 0) {
        this.writeU32(HYPERCALL_THREAD_NEXT, currentId);
        return 0;
      }
      // 每次 hypercall 都会经过这里：单次扫描替代临时数组、排序及 flatMap。
      // 显式比较 id，不能依赖 Map 插入顺序；轮转次序和最近唤醒时间保持不变。
      let first: GuestThreadState | undefined;
      let next: GuestThreadState | undefined;
      let runnableCount = 0;
      let earliestDeadline = Infinity;
      for (const thread of this.guestThreads.values()) {
        if (thread.terminated) continue;
        if (thread.runnable) {
          runnableCount++;
          if (!first || thread.id < first.id) first = thread;
          if (thread.id > currentId && (!next || thread.id < next.id)) next = thread;
        }
        if (thread.wakeAt > now && thread.wakeAt < earliestDeadline) earliestDeadline = thread.wakeAt;
        const waitDeadline = thread.wait?.deadline ?? 0;
        if (waitDeadline > now && waitDeadline < earliestDeadline) earliestDeadline = waitDeadline;
      }
      next ??= first;
      // RA2 的主线程用 while (!workerDone) Sleep(0) 等后台工作线程。Windows
      // 会立刻返回，但浏览器若照搬会产生每秒数千次 VM↔JS 往返；当唯一的
      // runnable 就是调用者时，直接合并到最近线程截止点，客体可观察的调度结果
      // 不变，却能消除整段空转。
      if (yielded && next?.id === currentId && runnableCount === 1 && earliestDeadline < Infinity) {
        this.writeU32(HYPERCALL_THREAD_NEXT, currentId);
        return Math.max(1, this.clock.toHostDelay(earliestDeadline - now));
      }
      if (!next && afterDelay) {
        const current = this.guestThreads.get(currentId);
        if (current && !current.terminated && !current.wait && current.criticalSection === undefined) {
          current.runnable = true;
          current.wakeAt = 0;
          this.writeU32(GUEST_THREAD_RUN_STATES + current.id * 4, 1);
          next = current;
        }
      }
      if (next) {
        this.writeU32(HYPERCALL_THREAD_NEXT, next.id);
        return 0;
      }
      return earliestDeadline < Infinity ? Math.max(1, this.clock.toHostDelay(earliestDeadline - now)) : 1;
    }
  };
}
