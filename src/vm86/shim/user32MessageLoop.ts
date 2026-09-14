import type { MessageState, Win32Call, Win32Result } from '../win32';
import { GUEST_CALLBACK_STRIDE as CALLBACK_STRIDE } from '../pe';
import { shimTraceEnabled, type Constructor, type GuestCallbackFrame } from './state';
import { withUser32Windowing } from './user32Windowing';

type User32WindowingChain = InstanceType<ReturnType<typeof withUser32Windowing>>;

export function withUser32MessageLoop<TBase extends Constructor<User32WindowingChain>>(Base: TBase) {
  return class extends Base {
    protected lastPointerDown: { hwnd: number; message: number; time: number; x: number; y: number } | null = null;
    /** ComboDropWin 可能在 WM_LBUTTONDOWN 期间隐藏；保留这一轮左键的目标，
     * 避免后续 WM_LBUTTONUP 重新命中弹窗下方的兄弟 ComboBox。 */
    protected hostPointerCapture = 0;
    /** 最近一次合成 WM_NCHITTEST 时命中的子窗口；子窗口变化才重新合成。 */
    protected lastHitTestChild = 0;
    protected sendMessageSequence(
      call: Win32Call,
      hwnd: number,
      messages: Array<{ message: number; wParam: number; lParam: number }>,
      forcedReturn: number,
    ): { eax: number } {
      const callback = this.windows.get(hwnd);
      if (callback === undefined) return { eax: 0 };
      if (!callback) {
        for (const message of messages) {
          this.dispatchDefaultControl(call, hwnd, message.message, message.wParam, message.lParam);
        }
        return { eax: forcedReturn };
      }

      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      const last = messages.at(-1)!;
      this.lastCallbackState = {
        hwnd,
        message: last.message,
        callback,
        callStack: call.stack,
        originalReturn,
        trampoline,
        depth,
      };
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp,esp
      for (const message of messages) {
        push(message.lParam);
        push(message.wParam);
        push(message.message);
        push(hwnd);
        code.push(0xb8);
        emit32(callback);
        code.push(0xff, 0xd0); // call eax
        code.push(0x89, 0xec); // mov esp,ebp，兼容 stdcall/cdecl
      }
      code.push(0x89, 0xec, 0x5d); // mov esp,ebp; pop ebp
      code.push(0xb8);
      emit32(forcedReturn);
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      if (code.length > CALLBACK_STRIDE) throw new Error(`SendMessage 序列桥超出槽位: ${code.length}`);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return { eax: 0 };
    }

    protected sendMessage(
      call: Win32Call,
      args: number[],
      forcedReturn?: number,
      reservedFrame?: GuestCallbackFrame,
    ): { eax: number } {
      const hwnd = args[0] ?? 0;
      const message = args[1] ?? 0;
      const wParam = args[2] ?? 0;
      const lParam = args[3] ?? 0;
      const mci = this.mciWindows.get(hwnd);
      if (mci) {
        if (message === 0x0806 && !mci.playing) {
          // MCI_PLAY
          mci.playing = true;
          // MCIWnd 的异步播放完成后通知 owner；游戏自己的 WndProc 决定如何推进状态。
          this.queueMessage(0x03b9, 1, hwnd, mci.parent); // MM_MCINOTIFY / MCI_NOTIFY_SUCCESSFUL
        } else if (message === 0x0808) {
          // MCI_STOP
          mci.playing = false;
        } else if (message === 0x0010) {
          // WM_CLOSE
          this.mciWindows.delete(hwnd);
        }
        return { eax: 0 };
      }
      if (message === 0x000f && this.discardInactivePaint(hwnd)) return { eax: 0 };
      const callback = this.windows.get(hwnd);
      if (callback === undefined) return { eax: 0 };
      const selectionMessage = !!callback && this.syncListBoxSelectionMessage(hwnd, message, wParam, lParam);
      if (selectionMessage) this.invalidateWindow(hwnd);
      // 系统控件的默认 WndProc 属于 USER32，因此没有客体 callback 地址；
      // SendMessage 仍须同步执行它，不能吞掉 CB_ADDSTRING/BM_SETCHECK 等协议。
      if (!callback) {
        const result = this.dispatchDefaultControl(call, hwnd, message, wParam, lParam);
        return forcedReturn === undefined ? result : { eax: forcedReturn };
      }
      // 同步分发：真实 Win32 的 SendMessageA 直接进入 WndProc。用与消息泵相同的
      // 跳板改写返回地址——WndProc 的返回值留在 EAX，恰好成为 SendMessageA 的结果。
      if (message === 0x000f) this.pendingPaintValidations.add(hwnd);
      const originalReturn = this.readU32(call.stack);
      const frame = reservedFrame ?? this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      this.lastCallbackState = { hwnd, message, callback, callStack: call.stack, originalReturn, trampoline, depth };
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55); // push ebp
      code.push(0x89, 0xe5); // mov ebp, esp；保存回调前的栈顶
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      push(lParam);
      push(wParam);
      push(message);
      push(hwnd);
      code.push(0xb8);
      emit32(callback);
      code.push(0xff, 0xd0); // call eax
      code.push(0x89, 0xec); // mov esp, ebp；兼容 stdcall/cdecl 回调的参数清理差异
      code.push(0x5d); // pop ebp
      if (forcedReturn !== undefined) {
        code.push(0xb8);
        emit32(forcedReturn); // ShowWindow 等 API 的返回值不等于 WndProc 返回值
      }
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return { eax: 0 };
    }

    /**
     * RA2 shell 的内层循环调用 PeekMessageA，却不一定再调用 DispatchMessageA。
     * 浏览器在一个事件批次内也可能已经产生 move/down/up。将当前批次串成一段
     * 客体桥，依序进入原版控件 WndProc；所有回调完成后强制以 FALSE 返回
     * PeekMessageA，不能把最后一个 WndProc 的 EAX 当成“取得了一条 MSG”。
     */
    protected dispatchPendingHostInput(call: Win32Call): Win32Result {
      const pending = this.pendingHostDispatches.splice(0, 12);
      const dispatches: Array<MessageState & { callback: number }> = [];
      const notifyParent = (message: MessageState, notification: number, controlMessage = 0x0111) => {
        const parent = this.windowParents.get(message.hwnd) ?? 0;
        const callback = this.windows.get(parent) ?? 0;
        if (!parent || !callback) return;
        dispatches.push({
          ...message,
          hwnd: parent,
          message: controlMessage,
          wParam:
            controlMessage === 0x0111
              ? (((notification & 0xffff) << 16) | ((this.controlIds.get(message.hwnd) ?? 0) & 0xffff)) >>> 0
              : notification >>> 0,
          lParam: message.hwnd,
          callback,
        });
      };
      for (const message of pending) {
        let hwnd = message.hwnd;
        let callback = this.windows.get(hwnd) ?? 0;
        let delivered = message;
        if (!this.isActiveShellWindow(hwnd)) continue;
        const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
        this.hostInputTrace.push({
          phase: 'dispatch',
          hwnd,
          message: message.message,
          callback,
          className,
          lParam: message.lParam,
        });
        if (this.hostInputTrace.length > 24) this.hostInputTrace.splice(0, this.hostInputTrace.length - 24);
        if (!callback) {
          if (message.message === 0x0201 && (className === 'edit' || className === 'combobox')) {
            this.focusWindow = hwnd;
          }
          if (className === 'combobox' && message.message === 0x0202) {
            const combo = this.initializeComboState(hwnd);
            const clientY = message.lParam >> 16;
            const selectionTop = combo.selectionHeight + 4;
            if (combo.dropped && clientY >= selectionTop) {
              const items = this.controlItems.get(hwnd) ?? [];
              const index = Math.floor((clientY - selectionTop) / Math.max(1, combo.itemHeight));
              if (index >= 0 && index < items.length) {
                this.controlSelections.set(hwnd, index);
                notifyParent(message, 1); // CBN_SELCHANGE
              }
              this.setComboDropped(hwnd, false);
              if (this.captureWindow === hwnd) this.captureWindow = 0;
            } else if (clientY < selectionTop) {
              const dropped = !combo.dropped;
              this.setComboDropped(hwnd, dropped);
              this.focusWindow = hwnd;
              this.captureWindow = dropped ? hwnd : 0;
            }
            continue;
          }
          if (className === 'listbox' && message.message === 0x0202) {
            const items = this.controlItems.get(hwnd) ?? [];
            const index = Math.floor((message.lParam >> 16) / (this.controlItemHeights.get(hwnd) ?? 16));
            if (index >= 0 && index < items.length) {
              this.controlSelections.set(hwnd, index);
              notifyParent(message, 1); // LBN_SELCHANGE
              this.invalidateWindow(hwnd);
            }
            continue;
          }
          if (
            className === 'msctls_trackbar32' &&
            (message.message === 0x0200 || message.message === 0x0201 || message.message === 0x0202)
          ) {
            const dragging = message.message !== 0x0200 || (message.wParam & 1) !== 0;
            if (dragging) {
              const state = this.trackbarStates.get(hwnd) ?? { min: 0, max: 100, pos: 0 };
              this.trackbarStates.set(hwnd, state);
              const width = Math.max(1, (this.windowRects.get(hwnd)?.width ?? 1) - 1);
              const x = Math.max(0, Math.min(width, (message.lParam << 16) >> 16));
              state.pos = state.min + Math.round((x * (state.max - state.min)) / width);
              this.invalidateWindow(hwnd);
              if (message.message === 0x0202) notifyParent(message, ((state.pos & 0xffff) << 16) | 4, 0x0114);
            }
            continue;
          }
          if (className === 'button' && message.message === 0x0201) {
            const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
            if ((style & 0x0800_0000) === 0) {
              this.focusWindow = hwnd;
              this.captureWindow = hwnd;
              this.pressedButton = hwnd;
            }
            continue;
          }
          if (className === 'button' && message.message === 0x0202) {
            const x = (message.lParam << 16) >> 16;
            const y = message.lParam >> 16;
            const rect = this.windowRects.get(hwnd);
            const clicked =
              this.pressedButton === hwnd && !!rect && x >= 0 && y >= 0 && x < rect.width && y < rect.height;
            if (this.captureWindow === hwnd) this.captureWindow = 0;
            if (this.pressedButton === hwnd) this.pressedButton = 0;
            if (!clicked) continue;
            this.activateButton(hwnd);
            notifyParent(message, 0); // BN_CLICKED
            continue;
          }
          this.defaultControlProc(hwnd, message.message, message.wParam, message.lParam);
          continue;
        }
        if (callback) {
          dispatches.push({ ...delivered, hwnd, callback });
        }
      }
      this.hostInputDispatchCount += pending.length;
      if (!dispatches.length) return { eax: 0 };

      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp,esp
      for (const message of dispatches) {
        push(message.lParam);
        push(message.wParam);
        push(message.message);
        push(message.hwnd);
        code.push(0xb8);
        emit32(message.callback);
        code.push(0xff, 0xd0); // call eax
        code.push(0x89, 0xec); // mov esp,ebp
      }
      code.push(0x31, 0xc0); // xor eax,eax：PeekMessageA 返回 FALSE
      code.push(0x89, 0xec, 0x5d); // mov esp,ebp; pop ebp
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      if (code.length > CALLBACK_STRIDE) throw new Error(`鼠标批量桥超出槽位: ${code.length}`);
      const first = dispatches[0]!;
      this.lastCallbackState = {
        hwnd: first.hwnd,
        message: first.message,
        callback: first.callback,
        callStack: call.stack,
        originalReturn,
        trampoline,
        depth,
      };
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return { eax: 0 };
    }

    protected queueMessage(
      message: number,
      wParam: number,
      lParam: number,
      hwnd: number,
      generatedPaint = false,
    ): void {
      const queued: MessageState = {
        hwnd,
        message,
        wParam: wParam >>> 0,
        lParam: lParam >>> 0,
        time: this.clock.now() >>> 0,
        x: this.cursorX,
        y: this.cursorY,
      };
      if (generatedPaint) this.generatedPaintMessages.add(queued);
      this.enqueueMessage(this.messages, queued);
    }
    protected enqueueMessage(queue: MessageState[], message: MessageState): void {
      this.invalidateFastPeek();
      // 鼠标移动可能比客体消息泵快，只保留最新一条 WM_MOUSEMOVE。
      const tail = queue.at(-1);
      if (message.message === 0x0200 && tail?.message === message.message && tail.hwnd === message.hwnd) {
        queue[queue.length - 1] = message;
      } else {
        queue.push(message);
      }
    }
    protected markInputReady(): void {
      if (this.inputReady) return;
      // 片头 MCIWnd 有自己的内层泵；窗口关闭后遇到的第一个消息 API 才是主消息泵。
      if (this.mciWindows.size) return;
      this.inputReady = true;
      // CreateWindow/ShowWindow 在真实 Win32 上会先产生初始位置与客户区尺寸消息。
      // 原版 WndProc 用它们建立最终 Blt 的目标 RECT（0x4af0fc）。
      this.queueMessage(0x0003, 0, 0, this.primaryWindow); // WM_MOVE: (0, 0)
      this.queueMessage(
        0x0005,
        0,
        ((this.displayHeight & 0xffff) << 16) | (this.displayWidth & 0xffff),
        this.primaryWindow,
      ); // WM_SIZE: SIZE_RESTORED, 800×600
      // Win32 顶层窗口激活时会收到这条消息；原版用它打开输入门控。
      this.queueMessage(0x001c, 1, 0, this.primaryWindow); // WM_ACTIVATEAPP
      for (const message of this.pendingHostMessages.splice(0)) this.enqueueMessage(this.messages, message);
    }
    protected setTimer(args: number[]): number {
      const hwnd = args[0] ?? 0;
      const id = args[1] || 1;
      const interval = Math.max(10, args[2] || 10);
      if (shimTraceEnabled('VM_TRACE_TIMER'))
        console.log(
          `⏲️ SetTimer hwnd=0x${hwnd.toString(16)} id=${id} interval=${interval} callback=0x${(args[3] ?? 0).toString(16)}`,
        );
      this.timers.set(this.timerKey(hwnd, id), {
        hwnd,
        id,
        interval,
        callback: args[3] ?? 0,
        next: this.clock.now() + interval,
      });
      this.invalidateFastPeek();
      return id;
    }
    protected timerKey(hwnd: number, id: number): string {
      return `${hwnd >>> 0}:${id >>> 0}`;
    }
    protected peekMessage(args: number[]): boolean {
      const messagePtr = args[0] ?? 0;
      const hwndFilter = args[1] ?? 0;
      const min = args[2] ?? 0;
      const max = args[3] ?? 0;
      const remove = ((args[4] ?? 0) & 1) !== 0;
      this.enqueueDueMultimediaTimers(this.clock.now());
      const queued = this.findQueuedMessage(hwndFilter, min, max);
      if (queued >= 0 && messagePtr) {
        const message = this.messages[queued]!;
        this.applyQueuedInputState(message);
        this.writeMessage(messagePtr, message);
        if (remove) this.messages.splice(queued, 1);
        return true;
      }
      const now = this.clock.now();
      const timer = [...this.timers.values()].find(
        (candidate) =>
          candidate.next <= now &&
          (!hwndFilter || candidate.hwnd === hwndFilter) &&
          (!min || 0x0113 >= min) &&
          (!max || 0x0113 <= max),
      );
      if (!timer || !messagePtr) return false;
      this.wmTimerDispatchCount++;
      this.writeMessage(messagePtr, {
        hwnd: timer.hwnd,
        message: 0x0113,
        wParam: timer.id,
        lParam: timer.callback,
        time: now >>> 0,
        x: this.cursorX,
        y: this.cursorY,
      });
      if (remove) timer.next = now + timer.interval;
      return true;
    }
    protected peekTimerDelay(): number {
      const now = this.clock.now();
      let guestDelay = Number.POSITIVE_INFINITY;
      for (const timer of this.timers.values()) guestDelay = Math.min(guestDelay, timer.next - now);
      for (const timer of this.multimediaTimers.values()) guestDelay = Math.min(guestDelay, timer.next - now);
      if (!Number.isFinite(guestDelay)) return 0;
      return Math.max(1, Math.min(10, this.clock.toHostDelay(Math.max(0, guestDelay))));
    }
    protected getMessage(args: number[]): Win32Result {
      const messagePtr = args[0] ?? 0;
      const hwndFilter = args[1] ?? 0;
      const min = args[2] ?? 0;
      const max = args[3] ?? 0;
      this.enqueueDueMultimediaTimers(this.clock.now());
      const queued = this.findQueuedMessage(hwndFilter, min, max);
      if (queued >= 0 && messagePtr) {
        const message = this.messages.splice(queued, 1)[0]!;
        this.applyQueuedInputState(message);
        this.writeMessage(messagePtr, message);
        return { eax: message.message === 0x0012 ? 0 : 1 };
      }
      const now = this.clock.now();
      const timer = [...this.timers.values()].find(
        (candidate) =>
          (!hwndFilter || candidate.hwnd === hwndFilter) && (!min || 0x0113 >= min) && (!max || 0x0113 <= max),
      );
      if (!timer || !messagePtr) return { eax: 1, delayMs: this.clock.toHostDelay(50) };
      const delayMs = Math.max(0, timer.next - now);
      this.writeMessage(messagePtr, {
        hwnd: timer.hwnd,
        message: 0x0113,
        wParam: timer.id,
        lParam: timer.callback,
        time: (now + delayMs) >>> 0,
        x: this.cursorX,
        y: this.cursorY,
      });
      timer.next = now + delayMs + timer.interval;
      return { eax: 1, delayMs: this.clock.toHostDelay(delayMs) };
    }
    protected findQueuedMessage(hwnd: number, min: number, max: number): number {
      return this.messages.findIndex(
        (message) =>
          (!hwnd || message.hwnd === hwnd || message.message === 0x0012) &&
          (!min || message.message >= min) &&
          (!max || message.message <= max),
      );
    }
    /**
     * Win32 的键态与消息队列按同一时间线推进。浏览器/worker 可能在客体取出
     * WM_MOUSE* 前已收到后续 pointerup/keyup；以当前宿主键态回答
     * GetAsyncKeyState 会让快速单击或 Ctrl+点击丢失。消息出队时恢复该消息
     * 携带的鼠标键与修饰键，再由后续消息清除。
     */
    protected applyQueuedInputState(
      message: Pick<MessageState, 'message' | 'wParam'> & Partial<Pick<MessageState, 'lParam' | 'modifierKeyState'>>,
    ): void {
      if (message.message >= 0x0200 && message.message <= 0x020e) {
        const shift = (message.wParam & 0x0004) !== 0;
        const control = (message.wParam & 0x0008) !== 0;
        const snapshot = message.modifierKeyState ?? 0;
        this.keyStates.set(0x01, (message.wParam & 0x0001) !== 0); // VK_LBUTTON / MK_LBUTTON
        this.keyStates.set(0x02, (message.wParam & 0x0002) !== 0); // VK_RBUTTON / MK_RBUTTON
        this.keyStates.set(0x04, (message.wParam & 0x0010) !== 0); // VK_MBUTTON / MK_MBUTTON
        this.keyStates.set(0x10, shift); // VK_SHIFT / MK_SHIFT
        this.keyStates.set(0x11, control); // VK_CONTROL / MK_CONTROL
        this.keyStates.set(0xa0, shift && ((snapshot & 0x03) === 0 || (snapshot & 0x01) !== 0));
        this.keyStates.set(0xa1, shift && (snapshot & 0x02) !== 0);
        this.keyStates.set(0xa2, control && ((snapshot & 0x0c) === 0 || (snapshot & 0x04) !== 0));
        this.keyStates.set(0xa3, control && (snapshot & 0x08) !== 0);
        return;
      }
      if (message.message === 0x0100 || message.message === 0x0104) {
        const vk = message.wParam & 0xff;
        this.keyStates.set(vk, true);
        if (vk === 0x11) {
          this.keyStates.set(((message.lParam ?? 0) & 0x0100_0000) !== 0 ? 0xa3 : 0xa2, true);
        }
        if (vk === 0x10) {
          this.keyStates.set((((message.lParam ?? 0) >>> 16) & 0xff) === 0x36 ? 0xa1 : 0xa0, true);
        }
      } else if (message.message === 0x0101 || message.message === 0x0105) {
        const vk = message.wParam & 0xff;
        this.keyStates.set(vk, false);
        if (vk === 0x11) {
          this.keyStates.set(((message.lParam ?? 0) & 0x0100_0000) !== 0 ? 0xa3 : 0xa2, false);
          this.keyStates.set(0x11, !!(this.keyStates.get(0xa2) || this.keyStates.get(0xa3)));
        }
        if (vk === 0x10) {
          this.keyStates.set((((message.lParam ?? 0) >>> 16) & 0xff) === 0x36 ? 0xa1 : 0xa0, false);
          this.keyStates.set(0x10, !!(this.keyStates.get(0xa0) || this.keyStates.get(0xa1)));
        }
      }
    }
    protected waitMessage(): Win32Result {
      const now = this.clock.now();
      this.enqueueDueMultimediaTimers(now);
      if (this.messages.length) return { eax: 1 };
      let delayMs = 50;
      for (const timer of this.timers.values()) delayMs = Math.min(delayMs, Math.max(1, timer.next - now));
      for (const timer of this.multimediaTimers.values()) {
        delayMs = Math.min(delayMs, Math.max(1, timer.next - now));
      }
      return { eax: 1, delayMs: this.clock.toHostDelay(delayMs) };
    }
    protected enqueueDueMultimediaTimers(now: number): void {
      for (const timer of [...this.multimediaTimers.values()]) {
        if (!timer.callback || timer.next > now) continue;
        const alreadyQueued = this.messages.some(
          (message) =>
            message.hwnd === 0 &&
            message.message === 0x0113 &&
            message.wParam === timer.id &&
            message.lParam === timer.callback,
        );
        if (!alreadyQueued) {
          if (shimTraceEnabled('VM_TRACE_TIMER'))
            console.log(`⏲️ 定时器触发 id=${timer.id} callback=0x${timer.callback.toString(16)} now=${now}`);
          this.queueMessage(0x0113, timer.id, timer.callback, 0);
        }
        if (timer.periodic) {
          // 如果页面曾经挂起，不追补成千上万个过期 tick。
          timer.next = now + timer.interval;
        } else {
          timer.next = Number.POSITIVE_INFINITY;
        }
      }
    }
    protected writeMessage(ptr: number, message: MessageState): void {
      this.zero(ptr, 28);
      this.writeU32(ptr, message.hwnd);
      this.writeU32(ptr + 4, message.message);
      this.writeU32(ptr + 8, message.wParam);
      this.writeU32(ptr + 12, message.lParam);
      this.writeU32(ptr + 16, message.time);
      this.writeU32(ptr + 20, message.x);
      this.writeU32(ptr + 24, message.y);
    }
    protected dispatchMessage(call: Win32Call, messagePtr: number): number {
      if (!messagePtr) return 0;
      const hwnd = this.readU32(messagePtr);
      const message = this.readU32(messagePtr + 4);
      const wParam = this.readU32(messagePtr + 8);
      const lParam = this.readU32(messagePtr + 12);
      if (message === 0x000f && this.discardInactivePaint(hwnd)) return 0;
      // 客体可能在真正 Dispatch 前继续查看队列；WndProc 内查询的键态应与
      // 当前 MSG 一致，而不是后续物理 keyup 的状态。RA2 强制攻击依赖此顺序。
      this.applyQueuedInputState({ message, wParam });
      // 标准控件通常由 BeginPaint 清除更新区；RA2 的自绘控件绕过 GDI，直接
      // 写 DirectDraw。把已取出的 WM_PAINT 视为本轮验证边界，保证下一次布局
      // 或动画失效能重新产生 WM_PAINT，而不是被永久合并。
      const multimediaTimer = message === 0x0113 && hwnd === 0 ? this.multimediaTimers.get(wParam) : undefined;
      const callback =
        multimediaTimer?.callback === lParam
          ? multimediaTimer.callback
          : message === 0x0113 && lParam
            ? lParam
            : (this.windows.get(hwnd) ?? 0);
      if (!callback) {
        const result = this.dispatchDefaultControl(call, hwnd, message, wParam, lParam).eax;
        if (message === 0x000f) this.invalidatedWindows.delete(hwnd);
        return result;
      }
      if (message === 0x000f) this.pendingPaintValidations.add(hwnd);

      const callbackArgs =
        multimediaTimer?.callback === lParam
          ? [multimediaTimer.id, 0, multimediaTimer.user, 0, 0]
          : message === 0x0113 && lParam
            ? [hwnd, message, wParam, this.clock.now() >>> 0]
            : [hwnd, message, wParam, lParam];
      if (multimediaTimer && !multimediaTimer.periodic) this.multimediaTimers.delete(multimediaTimer.id);

      const originalReturn = this.readU32(call.stack);
      // 回调可能再次进入消息泵；每层使用独立桥，避免覆盖外层的返回地址。
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      this.lastCallbackState = { hwnd, message, callback, callStack: call.stack, originalReturn, trampoline, depth };
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55); // push ebp
      code.push(0x89, 0xe5); // mov ebp, esp；保存回调前的栈顶
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      for (let i = callbackArgs.length - 1; i >= 0; i--) push(callbackArgs[i]!);
      code.push(0xb8);
      emit32(callback);
      code.push(0xff, 0xd0); // call eax
      code.push(0x89, 0xec); // mov esp, ebp；兼容 stdcall/cdecl 回调的参数清理差异
      code.push(0x5d); // pop ebp
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return 0;
    }
    /** 浏览器输入和 host 事件通过同一条 Win32 消息队列进入原版 WndProc。 */
    getHostInputDispatchCount(): number {
      return this.hostInputDispatchCount;
    }

    /** 返回 false 表示宿主输入已直接消费，无需等待客体派发（如弹窗关闭后的抬起）。 */
    postMessage(message: number, wParam = 0, lParam = 0, hwnd = this.primaryWindow): void | false {
      if (message >= 0x0100 && message <= 0x0108) {
        this.lastHostKeyMessage = message;
        this.lastHostKeyVirtualKey = wParam & 0xff;
      }
      const globalModifier =
        this.gameProfile.shell?.globalModifierKeys &&
        message >= 0x0100 &&
        message <= 0x0108 &&
        [0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5].includes(wParam & 0xff);
      if (
        !globalModifier &&
        message >= 0x0100 &&
        message <= 0x0108 &&
        hwnd === this.primaryWindow &&
        this.focusWindow
      ) {
        if (this.isWindowTreeEnabled(this.focusWindow) && this.isWindowTreeVisible(this.focusWindow)) {
          hwnd = this.focusWindow;
        } else this.focusWindow = 0;
      }
      // 真实 Windows 在投递 WM_MOUSEMOVE 前先向命中窗口同步发送 WM_NCHITTEST
      // （屏幕坐标）。Westwood 菜单对话框在该分支用 ChildWindowFromPointEx 追踪
      // 子控件 enter/leave——Campaign 徽标 hover 动画与音效由此驱动；只投
      // WM_MOUSEMOVE 时该分支永远不会执行。
      let hitTest: { hwnd: number; lParam: number } | null = null;
      if (message >= 0x0200 && message <= 0x020e && hwnd === this.primaryWindow) {
        const screenX = (lParam << 16) >> 16;
        const screenY = lParam >> 16;
        if (message === 0x0201) this.hostPointerCapture = 0;
        const latchedTarget = message === 0x0202 ? this.hostPointerCapture : 0;
        if (latchedTarget) {
          this.hostPointerCapture = 0;
          if (!this.windows.has(latchedTarget) || !this.isActiveShellWindow(latchedTarget)) {
            // 对应弹窗已在按下期间消失；不能把这次抬起重新命中到底层控件，
            // 但必须同步释放宿主的 VK_LBUTTON，避免后续输入被视为拖动。
            this.applyQueuedInputState({ message, wParam });
            return false;
          }
        }
        if (this.captureWindow && !this.isWindowTreeEnabled(this.captureWindow)) this.captureWindow = 0;
        // 可见标准控件保持原生窗口命中；落在 DirectDraw 容器上的 RA2 输入统一
        // 到当前 shell 页坐标系，避免嵌套对话框让 Gadget 把 lParam 解释错位。
        const nativeTarget = latchedTarget || this.hitTestWindow(screenX, screenY, this.primaryWindow, true);
        // Westwood 的弹层与滚动条是同一父窗口下相邻的两个 HWND。
        // 弹层持续捕获鼠标；滚动条区域仍须交给原生控件，否则按箭头会选中末行。
        const dropScrollbar =
          this.windowClassNames.get(this.captureWindow)?.toLowerCase() === 'combodropwin' &&
          this.windowClassNames.get(nativeTarget)?.toLowerCase() === 'scrollbar' &&
          this.scrollbarOwner(nativeTarget) === this.captureWindow
            ? nativeTarget
            : 0;
        // Campaign 的 owner-draw Static 与真实 Win32 一样保持 HTTRANSPARENT。
        // 父对话框在 WM_NCHITTEST 分支用 ChildWindowFromPointEx 判断 1770..1772，
        // 并启动徽标动画和 hover 音效；直接改投 Static 会绕开该分支。
        const target =
          latchedTarget ||
          this.scrollbarDrag?.hwnd ||
          dropScrollbar ||
          this.captureWindow ||
          (this.gameProfile.shell?.retargetDialogChrome &&
          this.windowClassNames.get(nativeTarget)?.toLowerCase() === '#32770'
            ? this.hitTestShellPage(screenX, screenY, this.primaryWindow)
            : nativeTarget);
        if (target) {
          if (
            message === 0x0201 &&
            ['combodropwin', 'scrollbar'].includes(this.windowClassNames.get(target)?.toLowerCase() ?? '')
          ) {
            this.hostPointerCapture = target;
          }
          hwnd = target;
          const origin = this.screenOrigin(target);
          const clientX = screenX - origin.x;
          const clientY = screenY - origin.y;
          if (shimTraceEnabled('VM_TRACE_GADGET')) {
            console.log(
              `🧭 host mouse screen=(${screenX},${screenY}) native=0x${nativeTarget.toString(16)}:${this.windowClassNames.get(nativeTarget) ?? ''} target=0x${target.toString(16)}:${this.windowClassNames.get(target) ?? ''} client=(${clientX},${clientY})`,
            );
          }
          lParam = (((clientY & 0xffff) << 16) | (clientX & 0xffff)) >>> 0;
          // 子窗口变化才合成 WM_NCHITTEST，与对话框内部的 last-id 去重一致，
          // 也保住同一子窗口内移动消息的合并。NCHITTEST 的 lParam 是屏幕坐标。
          // 输入未就绪（MCI 内层泵）时不合成：缓存的移动并入主队列后，就绪后的
          // 第一次移动会重新识别边沿并补发。
          if (message === 0x0200 && this.inputReady) {
            const child = this.childWindowFromPoint(target, clientX, clientY, 1); // CWP_SKIPINVISIBLE
            if (child !== this.lastHitTestChild) {
              this.lastHitTestChild = child;
              hitTest = {
                hwnd: target,
                lParam: (((screenY & 0xffff) << 16) | (screenX & 0xffff)) >>> 0,
              };
              // 诊断计数：Campaign 页徽标 enter-edge（浏览器冒烟断言 hover 只触发一次）。
              const menu = this.campaignMenu();
              const childId = this.controlIds.get(child) ?? 0;
              if (menu && childId >= menu.badgeControlIdRange[0] && childId <= menu.badgeControlIdRange[1]) {
                this.campaignHoverDispatchCount++;
              }
            }
          }
        }
      }
      message = this.translatePointerDoubleClick(hwnd, message, lParam);
      const queued: MessageState = {
        hwnd,
        message,
        wParam: wParam >>> 0,
        lParam: lParam >>> 0,
        time: this.clock.now() >>> 0,
        x: this.cursorX,
        y: this.cursorY,
        ...(message >= 0x0200 && message <= 0x020e
          ? {
              modifierKeyState:
                (this.keyStates.get(0xa0) ? 0x01 : 0) |
                (this.keyStates.get(0xa1) ? 0x02 : 0) |
                (this.keyStates.get(0xa2) ? 0x04 : 0) |
                (this.keyStates.get(0xa3) ? 0x08 : 0),
            }
          : {}),
      };
      if (message >= 0x0200 && message <= 0x020e) {
        this.hostInputTrace.push({
          phase: 'post',
          hwnd,
          message,
          callback: this.windows.get(hwnd) ?? 0,
          className: this.windowClassNames.get(hwnd)?.toLowerCase() ?? '',
          lParam,
        });
        if (this.hostInputTrace.length > 24) this.hostInputTrace.splice(0, this.hostInputTrace.length - 24);
      }
      // WM_NCHITTEST 是同步语义（send 而非 post）：先于本次移动在下一 API 边界
      // 送入命中窗口，保证对话框先记录 hover 子控件、再处理随后的 WM_MOUSEMOVE。
      const enqueueInput = (queue: MessageState[]) => {
        if (hitTest) {
          this.enqueueMessage(this.pendingHostDispatches, {
            hwnd: hitTest.hwnd,
            message: 0x0084, // WM_NCHITTEST
            wParam: 0,
            lParam: hitTest.lParam,
            time: this.clock.now() >>> 0,
            x: this.cursorX,
            y: this.cursorY,
          });
        }
        this.enqueueMessage(queue, queued);
      };
      // RA2 在 PeekMessageA 取出 MSG 后先交给 Westwood Gadget 预处理器，只有
      // 未消费的消息才会 DispatchMessageA。直接调用命中 HWND 的 WndProc 会绕过
      // 国家下拉、玩家名等 Gadget；RA2 必须保留真实消息队列路径。
      if (this.inputReady && this.gameProfile.shell?.mouseViaMessageQueue && message >= 0x0200 && message <= 0x020e) {
        enqueueInput(this.messages);
        return;
      }
      // 其他现有游戏的 shell 内层泵只 Peek 不 Dispatch，继续在下一 API 边界
      // 同步送入命中的控件过程。
      if (this.inputReady && message >= 0x0200 && message <= 0x020e) {
        enqueueInput(this.pendingHostDispatches);
        return;
      }
      // MCI 初始化期间也有内层消息泵。在原版主消息泵就绪前缓存 host 输入，
      // 否则用户加载时移动鼠标就会让 MCI 提前调用主 WndProc。
      enqueueInput(this.inputReady ? this.messages : this.pendingHostMessages);
    }

    /**
     * 双击由 USER32 按目标窗口类的 CS_DBLCLKS 生成；浏览器只上报两次物理按下。
     * 未声明该类样式的 DirectDraw/Gadget 窗口必须继续收到第二个 WM_*BUTTONDOWN。
     */
    protected translatePointerDoubleClick(hwnd: number, message: number, lParam: number): number {
      if (message !== 0x0201 && message !== 0x0204 && message !== 0x0207) return message;
      const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
      if (((this.windowClassStyles.get(className) ?? 0) & 0x0008) === 0) return message;
      const now = this.clock.now();
      const x = (lParam << 16) >> 16;
      const y = lParam >> 16;
      const previous = this.lastPointerDown;
      const isDouble =
        previous?.hwnd === hwnd &&
        previous.message === message &&
        now - previous.time <= 500 &&
        Math.abs(previous.x - x) <= 4 &&
        Math.abs(previous.y - y) <= 4;
      this.lastPointerDown = isDouble ? null : { hwnd, message, time: now, x, y };
      return isDouble ? message + 2 : message;
    }

    /** 当前最上层、可见且包含坐标的 shell 页；叶子控件由客体 Gadget 自己命中。 */
    protected hitTestShellPage(x: number, y: number, root: number): number {
      let page = 0;
      for (const hwnd of this.windowZOrder) {
        if (
          this.windowClassNames.get(hwnd)?.toLowerCase() !== '#32770' ||
          this.windowParents.get(hwnd) !== root ||
          !this.isWindowVisible(hwnd) ||
          (this.activeShellPage !== 0 && hwnd !== this.activeShellPage)
        )
          continue;
        const rect = this.screenRect(hwnd);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          x >= rect.x &&
          y >= rect.y &&
          x < rect.x + rect.width &&
          y < rect.y + rect.height
        )
          page = hwnd;
      }
      return page || root;
    }

    /** Win32 ChildWindowFromPoint[Ex] 只检查 parent 的直接子窗口，不递归。
     * 非 Ex 版本不会自动忽略隐藏或禁用子窗口；Ex 版本由 CWP_* flags 决定。 */
    protected childWindowFromPoint(parent: number, x: number, y: number, flags: number): number {
      if (!parent || !this.windows.has(parent)) return 0;
      const children = this.windowZOrder.filter((hwnd) => this.windowParents.get(hwnd) === parent).reverse();
      for (const hwnd of children) {
        const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
        const exStyle = this.windowLongs.get(`${hwnd}:-20`) ?? 0;
        if ((flags & 0x0001) !== 0 && (style & 0x10000000) === 0) continue; // CWP_SKIPINVISIBLE
        if ((flags & 0x0002) !== 0 && (style & 0x08000000) !== 0) continue; // CWP_SKIPDISABLED
        if ((flags & 0x0004) !== 0 && (exStyle & 0x00000020) !== 0) continue; // CWP_SKIPTRANSPARENT
        const rect = this.windowRects.get(hwnd);
        if (!rect || x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) continue;
        return hwnd;
      }
      return parent;
    }

    /** 原生窗口管理器会在入队前对子窗口做命中；Button/编辑框等吃鼠标，
     * Static 背景按 HTTRANSPARENT 处理，避免盖住整张主菜单。 */
    protected hitTestWindow(x: number, y: number, root: number, interactiveOnly: boolean): number {
      let best = root;
      let bestRank = -1;
      for (const hwnd of this.windowZOrder) {
        if (hwnd === root) continue;
        const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
        if (!this.isWindowVisible(hwnd) || !this.isActiveShellWindow(hwnd)) continue;
        let parent = this.windowParents.get(hwnd) ?? 0;
        let depth = 0;
        let descendant = false;
        const seen = new Set<number>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          depth++;
          if (parent === root) {
            descendant = true;
            break;
          }
          parent = this.windowParents.get(parent) ?? 0;
        }
        if (!descendant) continue;
        if (interactiveOnly) {
          // Static 在 Win32 命中测试中默认是 HTTRANSPARENT。Campaign 的父对话框
          // 会在 WM_MOUSEMOVE/DOWN/UP 中用 ChildWindowFromPoint 找到盟军/苏军徽标；
          // 如果提前把消息改投给 SS_OWNERDRAW Static，父过程永远收不到点击。
          // #32770 对话框本身则必须作为空白区域的输入目标。
          if (
            ![
              '#32770',
              'button',
              'edit',
              'listbox',
              'combobox',
              'combodropwin',
              'scrollbar',
              'msctls_trackbar32',
            ].includes(className)
          )
            continue;
        }
        if (interactiveOnly && !this.isWindowTreeEnabled(hwnd)) continue;
        const rect = this.screenRect(hwnd);
        const combo =
          this.windowClassNames.get(hwnd)?.toLowerCase() === 'combobox' ? this.comboStates.get(hwnd) : undefined;
        // 展开中的下拉按弹出区域参与命中（真实 Win32 弹层浮于所有平级控件之上，
        // 且优先于其下的兄弟行）。缺了这一步，点弹层条目会命中弹层底下的相邻行
        // 控件——Skirmish 设置页"第 2 行下拉选完，第 4 行被误翻开"就由此而来。
        if (combo?.dropped) rect.height = Math.max(rect.height, combo.droppedHeight);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          x < rect.x ||
          y < rect.y ||
          x >= rect.x + rect.width ||
          y >= rect.y + rect.height
        )
          continue;
        const rank = (depth << 1) | (combo?.dropped ? 1 : 0);
        if (rank >= bestRank) {
          best = hwnd;
          bestRank = rank;
        }
      }
      return best;
    }

    /** 禁用父窗口会隐式阻止全部后代接收输入，即使子 HWND 自身没有 WS_DISABLED。 */
    protected isWindowTreeEnabled(hwnd: number): boolean {
      const seen = new Set<number>();
      while (hwnd && !seen.has(hwnd)) {
        seen.add(hwnd);
        if (((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x08000000) !== 0) return false;
        hwnd = this.windowParents.get(hwnd) ?? 0;
      }
      return true;
    }

    protected isWindowInTree(hwnd: number, root: number): boolean {
      if (!hwnd || !root) return false;
      const seen = new Set<number>();
      while (hwnd && !seen.has(hwnd)) {
        if (hwnd === root) return true;
        seen.add(hwnd);
        hwnd = this.windowParents.get(hwnd) ?? 0;
      }
      return false;
    }
  };
}
