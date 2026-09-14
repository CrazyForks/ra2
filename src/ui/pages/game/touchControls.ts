import { syntheticKeyStroke, type KeyStrokeTarget } from './input';

/**
 * 触屏虚拟按键栏：Esc/Enter/空格/方向键 + 折叠切换。
 *
 * 容器挂在 document.body（startVmPage 会反复 ui.replaceChildren()，挂 #ui 会被清掉）。
 * 折叠状态存 localStorage，折叠后保留 ⌨ 切换按钮以便重新展开。
 */

const STORAGE_KEY = 'ra2-vm-touch-controls-hidden';

/** 根据画布上的实际输入显示触屏控件；设备能力不代表玩家正在用触屏。 */
export function installAdaptiveTouchControls(canvas: HTMLElement, vm: KeyStrokeTarget): () => void {
  let cleanupTouch: (() => void) | undefined;
  const hide = () => {
    cleanupTouch?.();
    cleanupTouch = undefined;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') cleanupTouch ??= installTouchControls(vm);
    else if (event.pointerType === 'mouse') hide();
  };
  const onPointerMove = (event: PointerEvent) => {
    // 零位移的重新命中事件不代表鼠标操作，避免布局变化时收起刚出现的按键。
    if (event.pointerType === 'mouse' && (event.movementX || event.movementY)) hide();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    hide();
  };
}

export function installTouchControls(vm: KeyStrokeTarget): () => void {
  const container = document.getElementById('vm-touch-controls') as HTMLElement | null;
  if (!container) return () => {};
  container.hidden = false;

  const keys = [...container.querySelectorAll<HTMLButtonElement>('[data-code]')];
  const collapse = container.querySelector<HTMLButtonElement>('[data-role="collapse"]');
  const held = new Map<number, string>();
  const removers: Array<() => void> = [];

  const on = <K extends keyof (HTMLElementEventMap & WindowEventMap & DocumentEventMap)>(
    target: EventTarget,
    type: K,
    listener: (event: (HTMLElementEventMap & WindowEventMap & DocumentEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener as EventListener, options);
    removers.push(() => target.removeEventListener(type, listener as EventListener, options));
  };

  const releaseAll = () => {
    for (const [pointerId, code] of held) {
      held.delete(pointerId);
      syntheticKeyStroke(vm, code, false);
    }
  };
  const releasePointer = (pointerId: number) => {
    const code = held.get(pointerId);
    if (code === undefined) return;
    held.delete(pointerId);
    syntheticKeyStroke(vm, code, false);
  };

  const setCollapsed = (collapsed: boolean) => {
    container.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '');
    } catch {
      // 隐私模式等场景 localStorage 不可用；折叠状态只影响本次会话。
    }
  };
  let initialCollapsed = false;
  try {
    initialCollapsed = localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // 隐私模式等场景 localStorage 不可用；折叠状态只影响本次会话。
  }
  setCollapsed(initialCollapsed);
  if (collapse) {
    on(collapse, 'click', () => {
      setCollapsed(!container.classList.contains('collapsed'));
    });
  }

  for (const key of keys) {
    const code = key.dataset.code!;
    key.type = 'button';
    on(
      key,
      'pointerdown',
      (event) => {
        event.preventDefault();
        // 把本指针的后续事件锁定在按键上；pointerup 时浏览器自动释放 capture。
        try {
          key.setPointerCapture(event.pointerId);
        } catch {
          // 指针可能已被浏览器取消；后续 pointercancel 路径会兜底释放。
        }
        held.set(event.pointerId, code);
        syntheticKeyStroke(vm, code, true);
      },
      { passive: false },
    );
    const release = (event: PointerEvent) => releasePointer(event.pointerId);
    on(key, 'pointerup', release);
    on(key, 'pointercancel', release);
    on(key, 'lostpointercapture', release);
  }

  // 防止切后台/失焦后客体按键卡住（镜像 page.ts releaseInput 的语义）。
  on(window, 'blur', releaseAll);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAll();
  });

  // —— 虚拟摇杆：透明悬浮层（独立于按键栏，不占布局、不挤游戏画面）。
  // 倾斜摇杆 = 按住对应方向键并高频连发 keydown（原版每记 keydown 滚一步，
  // 高频连发即连续平滑卷动）；不移动光标，绝不触发游戏的框选/拖拽判定。
  const joystick = document.getElementById('vm-touch-joystick') as HTMLButtonElement | null;
  const knob = joystick?.querySelector<HTMLSpanElement>('.joystick-knob');
  if (joystick && knob) {
    joystick.hidden = false;
    const RADIUS = 34; // 摇杆最大位移（px）
    const DEAD = 10; // 死区：小于此不触发方向
    const REPEAT_MS = 50; // 按住方向时的 keydown 连发间隔（20 次/秒）
    let joystickPointer = -1;
    let heldCodes: readonly string[] = [];
    let repeatTimer: number | undefined;

    const directionFor = (dx: number, dy: number): readonly string[] => {
      if (Math.hypot(dx, dy) < DEAD) return [];
      const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)); // 右=0，顺时针每 45° 一扇区
      const sectors: ReadonlyArray<readonly string[]> = [
        ['ArrowRight'],
        ['ArrowRight', 'ArrowDown'],
        ['ArrowDown'],
        ['ArrowLeft', 'ArrowDown'],
        ['ArrowLeft'],
        ['ArrowLeft', 'ArrowUp'],
        ['ArrowUp'],
        ['ArrowRight', 'ArrowUp'],
      ];
      return sectors[((sector % 8) + 8) % 8]!;
    };

    const stopHeld = () => {
      if (repeatTimer !== undefined) {
        window.clearInterval(repeatTimer);
        repeatTimer = undefined;
      }
      for (const code of heldCodes) syntheticKeyStroke(vm, code, false);
      heldCodes = [];
    };
    const startHeld = (codes: readonly string[]) => {
      heldCodes = codes;
      for (const code of codes) syntheticKeyStroke(vm, code, true);
      repeatTimer = window.setInterval(() => {
        for (const code of heldCodes) syntheticKeyStroke(vm, code, true);
      }, REPEAT_MS);
    };
    const applyDirection = (codes: readonly string[]) => {
      const key = codes.join('+');
      if (heldCodes.join('+') === key) return;
      stopHeld();
      if (codes.length) startHeld(codes);
    };
    const resetJoystick = () => {
      joystickPointer = -1;
      stopHeld();
      knob.style.transform = 'translate(0px, 0px)';
    };

    on(joystick, 'pointerdown', (event) => {
      event.preventDefault();
      joystickPointer = event.pointerId;
      try {
        joystick.setPointerCapture(event.pointerId);
      } catch {
        // 指针可能已被浏览器取消；pointercancel 路径会重置。
      }
    });
    const track = (event: PointerEvent) => {
      if (event.pointerId !== joystickPointer) return;
      const rect = joystick.getBoundingClientRect();
      let dx = event.clientX - (rect.left + rect.width / 2);
      let dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      if (distance > RADIUS) {
        dx = (dx * RADIUS) / distance;
        dy = (dy * RADIUS) / distance;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      applyDirection(directionFor(dx, dy));
      event.preventDefault();
    };
    on(joystick, 'pointermove', track, { passive: false });
    const release = (event: PointerEvent) => {
      if (event.pointerId !== joystickPointer) return;
      resetJoystick();
    };
    on(joystick, 'pointerup', release);
    on(joystick, 'pointercancel', release);
    on(joystick, 'lostpointercapture', release);

    // 折叠/切后台时停平移并复位光标，绝不留无手指触发的滚动。
    on(window, 'blur', resetJoystick);
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') resetJoystick();
    });
    removers.push(resetJoystick);
  }

  return () => {
    releaseAll();
    removers.splice(0).forEach((remove) => remove());
    container.hidden = true;
    if (joystick) joystick.hidden = true;
  };
}
