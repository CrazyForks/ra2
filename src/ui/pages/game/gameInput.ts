import type { VmShell } from '../../../adapter/runtime';
import { keyLParam, normalizePointerButton, rescaleLogicalPointer, virtualKey, win32CharacterCode } from './input';
import { calculateCanvasFit } from './canvasFit';
import { installFullscreenKeyboardLock, type KeyboardLockState } from './keyboardLock';

let canvasFitObserver: ResizeObserver | null = null;
let canvasDprQuery: MediaQueryList | null = null;
let canvasDprFitListener: (() => void) | null = null;
let canvasFullscreenFitListener: (() => void) | null = null;

/** 页面级快捷键：这些按键不注入游戏（installGameInput 的 keydown/keyup 直接放行），
 *  由本页统一消费。数字/字母键留给原版游戏热键，不占用。 */
const UI_SHORTCUT_KEYS = new Set(['`', 'F11', '?', '[', ']']);

/** canvas CSS 盒缓存：installCanvasFit 在每次 fit 后（含全屏切换）刷新。
 *  mousemove 高频读取不再逐次 getBoundingClientRect（布局读取）。 */
let canvasRectCache: { left: number; top: number; width: number; height: number } | null = null;

function refreshCanvasRect(canvas: HTMLCanvasElement): { left: number; top: number; width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  canvasRectCache = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return canvasRectCache;
}

function currentCanvasRect(canvas: HTMLCanvasElement): { left: number; top: number; width: number; height: number } {
  return canvasRectCache ?? refreshCanvasRect(canvas);
}

/** 全屏画面及其锁定提示，不包含工具栏/调试层；键盘锁由输入生命周期管理。 */
export async function toggleImmersiveFullscreen(canvas: HTMLCanvasElement): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    try {
      await (canvas.parentElement ?? canvas).requestFullscreen({ navigationUI: 'hide' });
    } catch (error) {
      console.warn('[VM UI] 全屏请求被拒绝', error);
    }
  }
}

import { controlsCollapsed } from './state/uiState';

/** 输入只发布折叠意图，工具栏的 class 与按钮文字由 React 管理。 */
export function setControlsCollapsed(collapsed: boolean): void {
  controlsCollapsed.set(collapsed);
}

/**
 * 画布视觉上放大到窗口允许的最大等比尺寸：CSS 盒按实际窗口精确填满，
 * 物理 backing 一律取整数档（≥1× 向上取整、上限 2×，<1× 按精确比例缩小）——
 * 光栅管线只有三种形态：1:1 直放、整数 N× 最近邻单趟、缩小单趟双线性，
 * 每帧最多一趟画布重采样。分数倍率全部交给浏览器合成器（backing→CSS 盒，
 * Skia 缩放，GPU 上近乎免费；向上取整=超采样，合成器缩小比放大更锐利）——
 * 分数 backing 会走两趟重采样，软渲染下 1920×1080 主菜单实测只有 32fps
 * （1.8× 中间缓冲爆量），整数档同窗口 60fps。上限 2×：更大倍率在软渲染下
 * 最近邻也要 25ms+。
 * 指针坐标按 getBoundingClientRect 比例映射回当前客体帧逻辑坐标。
 */
export interface GameFrameSize {
  width: number;
  height: number;
}

export type GameFrameSizeProvider = () => GameFrameSize;

export function installCanvasFit(
  canvas: HTMLCanvasElement,
  getFrameSize: GameFrameSizeProvider,
  onResized?: () => void,
): ((frameWidth?: number, frameHeight?: number) => void) & { destroy(): void } {
  // 首次 fit() 发生在页面初始化时（此时渲染循环尚未就绪）：静默执行不回调。
  let ready = false;
  const initialFrame = getFrameSize();
  let activeFrameWidth = initialFrame.width;
  let activeFrameHeight = initialFrame.height;
  const fit = (nextFrameWidth = activeFrameWidth, nextFrameHeight = activeFrameHeight) => {
    if (
      !Number.isFinite(nextFrameWidth) ||
      nextFrameWidth <= 0 ||
      !Number.isFinite(nextFrameHeight) ||
      nextFrameHeight <= 0
    )
      return;
    // 先保存帧尺寸，再读取舞台几何。这样首帧恰好在舞台完成布局前到达时，
    // 下一次 ResizeObserver 回调仍会使用最新比例，而不是继续使用 800×600。
    activeFrameWidth = nextFrameWidth;
    activeFrameHeight = nextFrameHeight;
    // 缩放基准：常规布局是 #stage（flex 撑满可用区，rect 即允许的最大面积）；
    // 沉浸式全屏时画面容器被浏览器撑到视口，以视口尺寸为准。
    // #screen-frame 只是包裹 canvas 供指针锁定特效定位，不能当基准。
    const stage = canvas.closest('#stage');
    const isCanvasFullscreen = !!document.fullscreenElement?.contains(canvas);
    if (!stage && !isCanvasFullscreen) return;
    const rect = isCanvasFullscreen
      ? { width: window.innerWidth, height: window.innerHeight }
      : stage!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fit = calculateCanvasFit({
      stageWidth: rect.width,
      stageHeight: rect.height,
      frameWidth: nextFrameWidth,
      frameHeight: nextFrameHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    if (!fit) return;
    const width = fit.backingWidth;
    const height = fit.backingHeight;
    const cssWidth = `${fit.cssWidth}px`;
    const cssHeight = `${fit.cssHeight}px`;
    const aspectRatio = `${activeFrameWidth} / ${activeFrameHeight}`;
    const backingChanged = canvas.width !== width || canvas.height !== height;
    const cssChanged = canvas.style.width !== cssWidth || canvas.style.height !== cssHeight;
    const aspectChanged = canvas.style.aspectRatio !== aspectRatio;
    if (backingChanged) {
      canvas.width = width;
      canvas.height = height;
    }
    if (cssChanged) {
      canvas.style.width = cssWidth;
      canvas.style.height = cssHeight;
    }
    if (aspectChanged) canvas.style.aspectRatio = aspectRatio;
    if (!backingChanged && !cssChanged && !aspectChanged) {
      // 尺寸未变（全屏进出后回到同一倍率等）：跳过重设——给 canvas.width 赋相同值
      // 也会清空位图，无谓闪一帧。只刷新位置可能变化的 rect 缓存。
      refreshCanvasRect(canvas);
      return;
    }
    // 同步刷新 rect 缓存（mousePosition 高频读取，见 currentCanvasRect）：
    // 这里是 canvas 布局盒的唯一变化点（含全屏进出）。
    refreshCanvasRect(canvas);
    // 仅 backing 重设会清空位图，需要立刻重绘当前帧；纯 CSS 缩放不清位图。
    if (backingChanged && ready) onResized?.();
  };
  canvasFitObserver?.disconnect();
  canvasFitObserver = new ResizeObserver(() => fit());
  const stage = canvas.closest('#stage');
  if (stage) canvasFitObserver.observe(stage);
  // 跨屏拖动或浏览器缩放会改变 devicePixelRatio 而 stage CSS 尺寸不变；跟随分辨率查询。
  const fitEnvironmentChange = () => fit();
  if (canvasDprQuery && canvasDprFitListener) {
    canvasDprQuery.removeEventListener('change', canvasDprFitListener);
  }
  canvasDprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  canvasDprQuery.addEventListener('change', fitEnvironmentChange);
  canvasDprFitListener = fitEnvironmentChange;
  // 沉浸式全屏进出：全屏盒的尺寸与常规布局无关，需重新适配。
  if (canvasFullscreenFitListener) document.removeEventListener('fullscreenchange', canvasFullscreenFitListener);
  document.addEventListener('fullscreenchange', fitEnvironmentChange);
  canvasFullscreenFitListener = fitEnvironmentChange;
  fit();
  ready = true;
  const observer = canvasFitObserver,
    query = canvasDprQuery;
  return Object.assign(fit, {
    destroy() {
      ready = false;
      observer.disconnect();
      query.removeEventListener('change', fitEnvironmentChange);
      document.removeEventListener('fullscreenchange', fitEnvironmentChange);
      if (canvasFitObserver === observer) canvasFitObserver = null;
      if (canvasDprQuery === query) {
        canvasDprQuery = null;
        canvasDprFitListener = null;
      }
      if (canvasFullscreenFitListener === fitEnvironmentChange) canvasFullscreenFitListener = null;
    },
  });
}

export interface InstalledGameInput {
  adaptResolution(width: number, height: number): void;
  cleanup(): void;
}

export function installGameInput(
  canvas: HTMLCanvasElement,
  vm: VmShell,
  lockDesktopMouse = true,
  onCursorPresentation?: (x: number, y: number, visible: boolean) => void,
  getFrameSize: GameFrameSizeProvider = () => ({ width: 800, height: 600 }),
): InstalledGameInput {
  // 默认沿用系统鼠标加速/速度手感；原始计数不是系统光标的屏幕位移。
  // 仅显式 ?raw-mouse=1 请求绕过系统调整，不再按 Windows 平台自动开启。
  const rawMouse = new URLSearchParams(window.location.search).get('raw-mouse') === '1';
  // 允许点击后接收键盘，但不让浏览器用 Tab 把焦点框画在游戏画面上。
  canvas.tabIndex = -1;
  canvas.style.outline = 'none';
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  const removers: Array<() => void> = [];
  // RA2 uses the Win32 hardware cursor on its menus. The browser is the hardware
  // cursor in this adapter, so keep it explicit when pointer lock is disabled;
  // inherited page styles or a stale game cursor must not leave the menu cursorless.
  if (!lockDesktopMouse) {
    const previousCursor = canvas.style.getPropertyValue('cursor');
    const previousCursorPriority = canvas.style.getPropertyPriority('cursor');
    canvas.style.setProperty('cursor', 'default', 'important');
    removers.push(() => {
      if (previousCursor) canvas.style.setProperty('cursor', previousCursor, previousCursorPriority);
      else canvas.style.removeProperty('cursor');
    });
  }
  let mouseFlags = 0;
  let lastMouseLParam = 0;
  const initialFrame = getFrameSize();
  let logicalMouseX = initialFrame.width / 2;
  let logicalMouseY = initialFrame.height / 2;
  let logicalFrameWidth = initialFrame.width;
  let logicalFrameHeight = initialFrame.height;
  let pointerLockPending = false;
  let desktopMoveFrame: number | null = null;
  let pendingDesktopMove: { x: number; y: number; lParam: number; wParam: number } | null = null;
  // 首次桌面点击必须在同一种（绝对坐标）模式下完整投递 DOWN/UP。
  // 若在 pointerdown 中立刻锁定，部分 Chromium/Windows 组合会在两者之间
  // 切换到相对坐标，甚至取消 pointerup，导致依赖 WM_LBUTTONUP 的菜单无响应。
  let lockAfterPointerUp = false;
  let lastCtrlPrimaryDispatch: { at: number; lParam: number } | null = null;
  let compatibilityCtrlPrimaryActive = false;
  const hostPlatform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  const normalizedPointerButtons = new Map<number, number>();
  const heldKeys = new Map<string, { vk: number; system: boolean }>();
  // 修饰键可能在画布取得焦点前已按下；pointerdown 时补齐给客体的按下沿，
  // keyup/blur 再按正常路径释放，避免 RA2 自己的键态表与浏览器物理状态脱节。
  const reconciledModifiers = new Map<number, string>();

  // ---- 触屏手势状态机 ----
  // touch 指针的 DOWN 被推迟到手势确定（tap / 拖动 / 长按右键）才发送，保证：
  // 1) 长按 400ms = 右键；2) 双 tap 保留两次完整物理点击；
  // 3) 拖动以按下起点补发左键 DOWN。双击消息由 USER32 根据窗口类样式生成。
  // 双指（触控板语义）：轻点 = 右键；拖拽 = 按住右键跟手平移——原版右键拖动
  // 卷动地图，光标始终跟随主手指，地图 1:1 跟手（松开后光标留在抬起点）。
  // 第二指落下即撤销单指的长按/单击意图；单指已进入拖拽/右键阶段后，第二指只被忽略。
  const TOUCH_LONG_PRESS_MS = 400;
  // 拖动判定阈值见 handleTouchPointerMove：按游戏像素换算，随画布缩放自适应。
  interface TouchGesture {
    pointerId: number;
    phase: 'pending' | 'drag' | 'right' | 'two-pending' | 'two-drag';
    downX: number;
    downY: number;
    downLParam: number;
    downClientX: number;
    downClientY: number;
    /** 进入双指时主手指的 client 位置：双指拖动判定的锚点。 */
    twoClientX: number;
    twoClientY: number;
    modifiers: number;
    timer: number;
  }
  let touchGesture: TouchGesture | null = null;
  const activeTouches = new Set<number>();
  /** Shift+左键：连点 ×10（首对立即投递，后续每 50ms 一对 WM_LBUTTONDOWN/UP）。
   *  连点携带的修饰符去掉 Shift 位——游戏收到的是 10 次普通左键；连点期间
   *  物理 up 被吞掉（每对自带 up），连点结束后的物理 up 照常投递（补发无害）。 */
  const SHIFT_CLICK_COUNT = 10;
  const SHIFT_CLICK_INTERVAL_MS = 50;
  let shiftBurstTimer: number | null = null;
  const cancelShiftBurst = () => {
    if (shiftBurstTimer !== null) {
      window.clearTimeout(shiftBurstTimer);
      shiftBurstTimer = null;
    }
  };
  const startShiftBurst = (lParam: number, modifiers: number) => {
    cancelShiftBurst();
    const mods = modifiers & ~0x0004;
    let remaining = SHIFT_CLICK_COUNT;
    const step = () => {
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, mods | 0x0001, lParam); // WM_LBUTTONDOWN
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, mods, lParam); // WM_LBUTTONUP
      // 点击序列采集：与普通左键同一格式，联机冒烟回放可复现连点。
      console.log(`[click-seq] ${lParam & 0xffff},${(lParam >>> 16) & 0xffff}`);
      remaining -= 1;
      shiftBurstTimer = remaining > 0 ? window.setTimeout(step, SHIFT_CLICK_INTERVAL_MS) : null;
    };
    step();
  };

  /** 按光标形态分派点按：攻击/移动目的地 → 右键，其余（空地/友军/界面）→ 左键。 */
  const dispatchTapClick = (downLParam: number, modifiers: number, right: boolean) => {
    if (right) {
      mouseFlags |= 0x0002;
      vm.setKeyState(0x02, true);
      vm.postMessage(0x0204, modifiers | 0x0002, downLParam); // WM_RBUTTONDOWN
      mouseFlags &= ~0x0002;
      vm.setKeyState(0x02, false);
      vm.postMessage(0x0205, modifiers, downLParam); // WM_RBUTTONUP
    } else {
      mouseFlags |= 0x0001;
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, modifiers | 0x0001, downLParam);
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, modifiers, downLParam); // WM_LBUTTONUP
      // 点击序列采集：本地联机冒烟回放用（建房/加入路线一次采集后全自动化）。
      console.log(`[click-seq] ${downLParam & 0xffff},${(downLParam >>> 16) & 0xffff}`);
    }
  };

  /** 触屏点按映射为普通左键；右键由长按/双指手势显式产生。 */
  const scheduleTapClick = (downLParam: number, modifiers: number) => {
    dispatchTapClick(downLParam, modifiers, false);
  };

  const on = <K extends keyof (HTMLElementEventMap & WindowEventMap)>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: (HTMLElementEventMap & WindowEventMap)[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener as EventListener, options);
    removers.push(() => target.removeEventListener(type, listener as EventListener, options));
  };

  const adaptResolution = (width: number, height: number): void => {
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (width !== logicalFrameWidth || height !== logicalFrameHeight) {
      [logicalMouseX, logicalMouseY] = rescaleLogicalPointer(
        logicalMouseX,
        logicalMouseY,
        logicalFrameWidth,
        logicalFrameHeight,
        width,
        height,
      );
      logicalFrameWidth = width;
      logicalFrameHeight = height;
      cancelDesktopMove();
      const x = Math.floor(logicalMouseX);
      const y = Math.floor(logicalMouseY);
      lastMouseLParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
      // 不等下一次物理 mousemove：SetDisplayMode 后立刻把按比例换算的新坐标
      // 同步给客体及宿主光标层，避免锁定光标仍被旧 800×600 边界钳制。
      vm.setCursorPosition(x, y);
      onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    }
  };

  const updateMousePosition = (event: MouseEvent): [number, number] => {
    // rect 走缓存（installCanvasFit 维护），避免每个 mousemove 触发布局读取。
    const rect = currentCanvasRect(canvas);
    // 映射到客体逻辑坐标，与 backing store 物理尺寸无关。
    const frame = getFrameSize();
    const width = frame.width;
    const height = frame.height;
    adaptResolution(width, height);
    if (document.pointerLockElement === canvas) {
      logicalMouseX = Math.max(0, Math.min(width - 1, logicalMouseX + (event.movementX * width) / (rect.width || 1)));
      logicalMouseY = Math.max(
        0,
        Math.min(height - 1, logicalMouseY + (event.movementY * height) / (rect.height || 1)),
      );
    } else {
      logicalMouseX = Math.max(0, Math.min(width - 1, ((event.clientX - rect.left) * width) / (rect.width || 1)));
      logicalMouseY = Math.max(0, Math.min(height - 1, ((event.clientY - rect.top) * height) / (rect.height || 1)));
    }
    return [Math.floor(logicalMouseX), Math.floor(logicalMouseY)];
  };
  const mousePosition = (event: MouseEvent): [number, number] => {
    const [x, y] = updateMousePosition(event);
    vm.setCursorPosition(x, y);
    onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    return [x, y];
  };
  const mouseLParam = (event: MouseEvent): number => {
    const [x, y] = mousePosition(event);
    lastMouseLParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
    return lastMouseLParam;
  };
  const heldModifier = (genericVk: number): boolean => {
    for (const state of heldKeys.values()) {
      if (
        state.vk === genericVk ||
        (genericVk === 0x10 && (state.vk === 0xa0 || state.vk === 0xa1)) ||
        (genericVk === 0x11 && (state.vk === 0xa2 || state.vk === 0xa3))
      )
        return true;
    }
    return false;
  };
  const modifierFlags = (event: MouseEvent): number => {
    // Pointer Lock 下部分浏览器的 PointerEvent.ctrlKey/shiftKey 会短暂丢失；
    // 键盘监听维护的 heldKeys 才是同一输入序列的权威状态。两者取并集，
    // 保证 Ctrl+点击以 MK_CONTROL 到达原版（强制攻击依赖该位）。
    return (
      mouseFlags |
      (event.shiftKey || heldModifier(0x10) ? 0x0004 : 0) |
      (event.ctrlKey || heldModifier(0x11) ? 0x0008 : 0)
    );
  };

  // 首次移动立即投递，避免客体输入额外等待一帧；同帧后续高频事件合并到帧尾。
  // 相对位移仍逐事件累计，DOWN/UP/WHEEL 前冲刷尾部 MOVE，不能丢距离或倒序。
  const flushDesktopMove = () => {
    if (desktopMoveFrame !== null) cancelAnimationFrame(desktopMoveFrame);
    desktopMoveFrame = null;
    const move = pendingDesktopMove;
    pendingDesktopMove = null;
    if (!move) return;
    vm.setCursorPosition(move.x, move.y);
    vm.postMessage(0x0200, move.wParam, move.lParam);
  };
  const scheduleDesktopMove = (event: PointerEvent) => {
    const [x, y] = updateMousePosition(event);
    const lParam = (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
    lastMouseLParam = lParam;
    // 本地光标立即跟随输入，不能等 VM 消息的 rAF 合并窗口。
    // 客体使用首尾合并，避免高轮询率鼠标堆积 Worker 消息。
    onCursorPresentation?.(x, y, document.pointerLockElement === canvas);
    pendingDesktopMove = {
      x,
      y,
      lParam,
      wParam: modifierFlags(event),
    };
    if (desktopMoveFrame === null) {
      flushDesktopMove();
      desktopMoveFrame = requestAnimationFrame(() => {
        desktopMoveFrame = null;
        flushDesktopMove();
      });
    }
  };
  const cancelDesktopMove = () => {
    if (desktopMoveFrame !== null) cancelAnimationFrame(desktopMoveFrame);
    desktopMoveFrame = null;
    pendingDesktopMove = null;
  };

  const pointerButton = (button: number) => {
    if (button === 0) return { down: 0x0201, up: 0x0202, flag: 0x0001, vk: 0x01 };
    if (button === 1) return { down: 0x0207, up: 0x0208, flag: 0x0010, vk: 0x04 };
    if (button === 2) return { down: 0x0204, up: 0x0205, flag: 0x0002, vk: 0x02 };
    return null;
  };

  const releaseMouseButtons = (lParam = lastMouseLParam) => {
    for (const button of [0, 1, 2]) {
      const info = pointerButton(button)!;
      if (!(mouseFlags & info.flag)) continue;
      mouseFlags &= ~info.flag;
      vm.setKeyState(info.vk, false);
      vm.postMessage(info.up, mouseFlags, lParam);
    }
  };

  const syncKeyState = (code: string, vk: number, down: boolean) => {
    vm.setKeyState(vk, down);
    const modifiers: Record<string, [number, number]> = {
      ShiftLeft: [0x10, 0xa0],
      ShiftRight: [0x10, 0xa1],
      ControlLeft: [0x11, 0xa2],
      ControlRight: [0x11, 0xa3],
      AltLeft: [0x12, 0xa4],
      AltRight: [0x12, 0xa5],
    };
    const pair = modifiers[code];
    if (!pair) return;
    const [generic, sided] = pair;
    vm.setKeyState(sided, down);
    const genericDown = [...heldKeys.keys()].some((heldCode) => modifiers[heldCode]?.[0] === generic);
    vm.setKeyState(generic, genericDown);
  };

  const reconcileMouseModifiers = (event: MouseEvent) => {
    const modifiers: Array<{ active: boolean; generic: number; code: string; scanCode: number }> = [
      { active: event.shiftKey, generic: 0x10, code: 'ShiftLeft', scanCode: 0x2a },
      { active: event.ctrlKey, generic: 0x11, code: 'ControlLeft', scanCode: 0x1d },
    ];
    for (const modifier of modifiers) {
      if (!modifier.active) continue;
      const alreadyForwarded = [...heldKeys.values()].some(
        (state) =>
          state.vk === modifier.generic ||
          (modifier.generic === 0x10 && (state.vk === 0xa0 || state.vk === 0xa1)) ||
          (modifier.generic === 0x11 && (state.vk === 0xa2 || state.vk === 0xa3)),
      );
      if (alreadyForwarded) continue;
      heldKeys.set(modifier.code, { vk: modifier.generic, system: false });
      reconciledModifiers.set(modifier.generic, modifier.code);
      syncKeyState(modifier.code, modifier.generic, true);
      vm.postMessage(0x0100, modifier.generic, 1 | (modifier.scanCode << 16)); // WM_KEYDOWN
    }
  };

  const releaseKeys = () => {
    for (const [code, state] of heldKeys) {
      heldKeys.delete(code);
      syncKeyState(code, state.vk, false);
      vm.postMessage(state.system ? 0x0105 : 0x0101, state.vk, 0xc000_0001);
    }
    reconciledModifiers.clear();
  };

  const clearTouchTimer = () => {
    if (touchGesture) window.clearTimeout(touchGesture.timer);
  };

  /** 触屏手势所有取消路径的统一收口：按当前相位补发 UP，绝不留无手指触发的定时器。 */
  const cancelTouchGesture = (lParam = lastMouseLParam) => {
    const state = touchGesture;
    if (!state) return;
    clearTouchTimer();
    touchGesture = null;
    if (state.phase === 'drag') {
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, state.modifiers, lParam);
    } else if (state.phase === 'right' || state.phase === 'two-drag') {
      mouseFlags &= ~0x0002;
      vm.setKeyState(0x02, false);
      vm.postMessage(0x0205, state.modifiers, lParam);
    }
    // pending / two-pending 相位未按过键，无需补发。
  };

  const touchHoldTimer = () => {
    const state = touchGesture;
    if (!state || state.phase !== 'pending') return;
    state.phase = 'right';
    mouseFlags |= 0x0002;
    vm.setKeyState(0x02, true);
    vm.postMessage(0x0204, state.modifiers | 0x0002, state.downLParam); // WM_RBUTTONDOWN
    if (typeof navigator.vibrate === 'function') navigator.vibrate(40);
  };

  const handleTouchPointerDown = (event: PointerEvent) => {
    // 混合设备上控制栏可能展开着遮住左侧触控区：一碰到画面就自动收起。
    setControlsCollapsed(true);
    canvas.focus({ preventScroll: true });
    activeTouches.add(event.pointerId);
    const state = touchGesture;
    if (!state) {
      // 第一根手指：开始单指手势（其余手指都抬起后才允许新手势，防残指干扰）。
      if (activeTouches.size !== 1) {
        event.preventDefault();
        return;
      }
      const lParam = mouseLParam(event);
      const x = lParam & 0xffff;
      const y = (lParam >>> 16) & 0xffff;
      touchGesture = {
        pointerId: event.pointerId,
        phase: 'pending',
        downX: x,
        downY: y,
        downLParam: lParam,
        downClientX: event.clientX,
        downClientY: event.clientY,
        twoClientX: 0,
        twoClientY: 0,
        modifiers: modifierFlags(event),
        timer: window.setTimeout(touchHoldTimer, TOUCH_LONG_PRESS_MS),
      };
    } else if (state.phase === 'pending') {
      // 第二根手指落下：撤销长按与单击意图，升级为双指手势。
      clearTouchTimer();
      state.phase = 'two-pending';
      state.twoClientX = state.downClientX;
      state.twoClientY = state.downClientY;
    }
    // 单指已进入 drag/right、或双指阶段再有手指落下：忽略。
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 指针可能在事件送达前已被浏览器取消；pointercancel 会统一清理。
    }
    event.preventDefault();
  };

  const handleTouchPointerMove = (event: PointerEvent) => {
    const state = touchGesture;
    if (!state) return;
    const rect = currentCanvasRect(canvas);
    const slopCss = Math.max(3, (5 * (rect.width || 1)) / getFrameSize().width);
    if (state.phase === 'pending') {
      if (event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.downClientX;
      const dy = event.clientY - state.downClientY;
      // 阈值按游戏像素换算（≈5px），不随画布 CSS 缩放变化：放大时不误判拖动、
      // 缩小/手机上也不迟钝。
      if (dx * dx + dy * dy <= slopCss * slopCss) return;
      // 超过拖动阈值：以按下起点补发左键 DOWN；本条 WM_MOUSEMOVE 已由通用路径先行发送。
      clearTouchTimer();
      state.phase = 'drag';
      mouseFlags |= 0x0001;
      vm.setKeyState(0x01, true);
      vm.postMessage(0x0201, state.modifiers | 0x0001, state.downLParam); // WM_LBUTTONDOWN
      return;
    }
    if (state.phase === 'two-pending') {
      // 任一手指移动超过阈值：按下右键进入跟手平移。光标此刻在主手指处
      // （通用路径持续跟随），后续移动即原版右键拖动卷地图。
      const dx = event.clientX - state.twoClientX;
      const dy = event.clientY - state.twoClientY;
      if (dx * dx + dy * dy <= slopCss * slopCss) return;
      state.phase = 'two-drag';
      const lParam = (((logicalMouseY & 0xffff) << 16) | (logicalMouseX & 0xffff)) >>> 0;
      mouseFlags |= 0x0002;
      vm.setKeyState(0x02, true);
      vm.postMessage(0x0204, state.modifiers | 0x0002, lParam); // WM_RBUTTONDOWN
      if (typeof navigator.vibrate === 'function') navigator.vibrate(20);
      return;
    }
    // drag/right/two-drag 相位：光标与按键均由通用路径与收口逻辑处理。
  };

  const handleTouchPointerUp = (event: PointerEvent) => {
    activeTouches.delete(event.pointerId);
    const state = touchGesture;
    if (!state) return;
    const single = state.phase === 'pending' || state.phase === 'drag' || state.phase === 'right';
    if (single) {
      if (event.pointerId !== state.pointerId) return;
      clearTouchTimer();
      // 先清状态再释放 capture：lostpointercapture 的指针守卫发现空手势，不会重复收口。
      touchGesture = null;
      const upLParam = mouseLParam(event);
      const modifiers = modifierFlags(event);
      if (state.phase === 'pending') {
        // 点按序列与桌面鼠标一致：MOVE/DOWN/UP 全部用按下点。手指微移几个
        // 像素不该把点击变成拖动（否则游戏按「起点≠终点」判定为拖拽，
        // 只动光标不响应点击）。双击序列同理，仍发送第二次完整物理点击。
        vm.postMessage(0x0200, modifiers, state.downLParam); // 光标回到按下点
        // 移动端适配：先移动指针到目标点，读内存确认光标形态再按键——
        // 攻击/移动目的地 → 右键，其余（空地/友军/界面）→ 左键。
        scheduleTapClick(state.downLParam, modifiers);
      } else if (state.phase === 'drag') {
        mouseFlags &= ~0x0001;
        vm.setKeyState(0x01, false);
        vm.postMessage(0x0202, modifiers, upLParam);
      } else {
        mouseFlags &= ~0x0002;
        vm.setKeyState(0x02, false);
        vm.postMessage(0x0205, modifiers, upLParam);
      }
    } else {
      // 双指阶段：任一手指导起即收口。
      clearTouchTimer();
      touchGesture = null;
      if (state.phase === 'two-pending') {
        // 双指轻点 = 右键：MOVE/RDOWN/RUP 同用主手指按下点（触控板语义）。
        const modifiers = modifierFlags(event);
        vm.postMessage(0x0200, modifiers, state.downLParam);
        vm.postMessage(0x0204, modifiers | 0x0002, state.downLParam);
        vm.postMessage(0x0205, modifiers, state.downLParam);
      } else {
        // two-drag：平移结束——松开右键，光标留在主手指处（抬起的可能是副手指）。
        const modifiers = modifierFlags(event);
        const upLParam = (((logicalMouseY & 0xffff) << 16) | (logicalMouseX & 0xffff)) >>> 0;
        vm.postMessage(0x0200, modifiers, upLParam);
        mouseFlags &= ~0x0002;
        vm.setKeyState(0x02, false);
        vm.postMessage(0x0205, modifiers, upLParam); // WM_RBUTTONUP
      }
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    event.preventDefault();
  };

  const releaseInput = () => {
    lockAfterPointerUp = false;
    compatibilityCtrlPrimaryActive = false;
    cancelDesktopMove();
    cancelTouchGesture();
    cancelShiftBurst();
    releaseMouseButtons();
    releaseKeys();
    mouseFlags = 0;
  };

  const requestMouseLock = async () => {
    if (pointerLockPending || document.pointerLockElement === canvas) return;
    pointerLockPending = true;
    try {
      // Windows Chromium 不允许同一指针同时处于 Pointer Capture 与 Pointer Lock。
      // 获锁首击会在 pointerup 前释放 capture；锁定后事件本身继续定向 canvas。
      // 显式启用原始计数时请求 unadjustedMovement；平台无法兑现时拒绝请求，
      // 回退重试无选项请求（指针锁定本身仍可用）。
      try {
        await canvas.requestPointerLock(rawMouse ? { unadjustedMovement: true } : undefined);
      } catch (error) {
        if (!rawMouse || !(error instanceof DOMException)) throw error;
        await canvas.requestPointerLock();
      }
    } catch (error) {
      console.warn('[VM input] 浏览器拒绝鼠标锁定', error);
    } finally {
      pointerLockPending = false;
    }
  };

  const finishDesktopPointerUp = (event: PointerEvent, desktopMouse: boolean) => {
    if (!mouseFlags && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!desktopMouse || mouseFlags || !lockAfterPointerUp) return;
    lockAfterPointerUp = false;
    if (document.pointerLockElement === canvas) return;
    // releasePointerCapture 必须先于 Pointer Lock；调用仍处于可信 pointerup
    // 用户手势内，因此 Chromium 允许获取锁定。
    void requestMouseLock();
  };

  on(
    canvas,
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') {
        // 每根手指都进手势机（双指拖动由任一手指触发）；仅主手指经通用路径
        // 发送 WM_MOUSEMOVE（光标跟随主手指）。双指平移时改由边缘光标定时器
        // 驱动位置，这里不跟手，否则会与平移方向打架。
        // 光标始终跟随主手指：双指拖拽时右键已按下，地图随光标跟手平移。
        if (event.isPrimary) vm.postMessage(0x0200, modifierFlags(event), mouseLParam(event));
        handleTouchPointerMove(event);
        event.preventDefault();
        return;
      }
      if (!event.isPrimary) return;
      scheduleDesktopMove(event);
      if (mouseFlags || event.pointerType !== 'mouse') event.preventDefault();
    },
    { passive: false },
  );
  on(
    canvas,
    'pointerdown',
    (event) => {
      // 触屏的每根手指都进手势机（第二指升级为双指手势）。
      if (event.pointerType === 'touch') {
        handleTouchPointerDown(event);
        return;
      }
      if (!event.isPrimary) return;
      const controlDown = event.ctrlKey || heldModifier(0x11);
      const button = normalizePointerButton(event.button, controlDown, hostPlatform, event.buttons);
      const info = pointerButton(button);
      if (!info) return;
      normalizedPointerButtons.set(event.pointerId, button);
      flushDesktopMove();
      canvas.focus({ preventScroll: true });
      reconcileMouseModifiers(event);
      const lParam = mouseLParam(event);
      if (button === 0 && controlDown) {
        lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
      }
      const desktopMouse = event.pointerType === 'mouse';
      if (lockDesktopMouse && desktopMouse && document.pointerLockElement !== canvas) lockAfterPointerUp = true;
      mouseFlags |= info.flag;
      vm.setKeyState(info.vk, true);
      if (desktopMouse && info.vk === 0x01 && event.shiftKey) {
        startShiftBurst(lParam, modifierFlags(event));
      } else {
        vm.postMessage(info.down, modifierFlags(event), lParam);
      }
      // 尚未锁定时一律 Capture，保证首击的 pointerup 在获取 Pointer Lock 前
      // 回到同一画布；已经锁定后事件本身会继续定向 canvas。
      if (!desktopMouse || document.pointerLockElement !== canvas) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // 指针可能在事件送达前已被浏览器取消；后面的 pointercancel 会统一释放状态。
        }
      }
      event.preventDefault();
    },
    { passive: false },
  );
  on(
    canvas,
    'pointerup',
    (event) => {
      // 触屏的每根手指都要进手势机（双指手势由副手指收口）。
      if (event.pointerType === 'touch') {
        handleTouchPointerUp(event);
        return;
      }
      if (!event.isPrimary) return;
      const button =
        normalizedPointerButtons.get(event.pointerId) ??
        normalizePointerButton(event.button, event.ctrlKey || heldModifier(0x11), hostPlatform, event.buttons);
      normalizedPointerButtons.delete(event.pointerId);
      const info = pointerButton(button);
      if (!info) return;
      flushDesktopMove();
      const desktopMouse = event.pointerType === 'mouse';
      if (info.vk === 0x01 && shiftBurstTimer !== null) {
        // Shift 连点进行中：每对 down/up 已由连点器投递，物理 up 只清理状态不再补发。
        mouseFlags &= ~info.flag;
        vm.setKeyState(info.vk, false);
        finishDesktopPointerUp(event, desktopMouse);
        event.preventDefault();
        return;
      }
      const lParam = mouseLParam(event);
      // blur/releaseInput 可能已经补发过 UP；只有仍记录为按下的按钮才再投递。
      if ((mouseFlags & info.flag) !== 0) {
        mouseFlags &= ~info.flag;
        vm.setKeyState(info.vk, false);
        vm.postMessage(info.up, modifierFlags(event), lParam);
      }
      // Pointer Events 对多键鼠标只保证首个 pointerdown 与最后一个 pointerup；
      // 最后抬起的 event.button 可能不是最初记录的按钮，用 buttons=0 统一收口。
      if (event.buttons === 0) releaseMouseButtons(lParam);
      finishDesktopPointerUp(event, desktopMouse);
      event.preventDefault();
    },
    { passive: false },
  );
  // macOS Edge 可能把 Ctrl+主键完全降级为兼容 MouseEvent，网页收不到对应
  // PointerEvent。正常 PointerEvent 路径会先登记 lastCtrlPrimaryDispatch，因此
  // 这里仅在其缺席时补投，避免其他浏览器产生双份 DOWN/UP。
  on(canvas, 'mousedown', (event) => {
    const controlDown = event.ctrlKey || heldModifier(0x11);
    if (!controlDown || normalizePointerButton(event.button, controlDown, hostPlatform, event.buttons) !== 0) return;
    const lParam = mouseLParam(event);
    if (
      lastCtrlPrimaryDispatch &&
      performance.now() - lastCtrlPrimaryDispatch.at < 250 &&
      lastCtrlPrimaryDispatch.lParam === lParam
    ) {
      event.preventDefault();
      return;
    }
    flushDesktopMove();
    canvas.focus({ preventScroll: true });
    reconcileMouseModifiers(event);
    mouseFlags |= 0x0001;
    vm.setKeyState(0x01, true);
    vm.postMessage(0x0201, modifierFlags(event), lParam);
    compatibilityCtrlPrimaryActive = true;
    lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
    event.preventDefault();
  });
  on(canvas, 'mouseup', (event) => {
    if (!compatibilityCtrlPrimaryActive) return;
    compatibilityCtrlPrimaryActive = false;
    const lParam = mouseLParam(event);
    if ((mouseFlags & 0x0001) !== 0) {
      mouseFlags &= ~0x0001;
      vm.setKeyState(0x01, false);
      vm.postMessage(0x0202, modifierFlags(event), lParam);
    }
    event.preventDefault();
  });
  on(
    canvas,
    'pointercancel',
    (event) => {
      if (event.pointerType === 'touch') {
        activeTouches.delete(event.pointerId);
        cancelTouchGesture(mouseLParam(event));
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      if (!event.isPrimary) return;
      normalizedPointerButtons.delete(event.pointerId);
      lockAfterPointerUp = false;
      cancelShiftBurst();
      flushDesktopMove();
      releaseMouseButtons(mouseLParam(event));
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      event.preventDefault();
    },
    { passive: false },
  );
  on(canvas, 'lostpointercapture', (event) => {
    // 触屏手势若处于 pending，必须在此杀掉定时器，否则无手指时也会触发右键。
    if (touchGesture && event.pointerId === touchGesture.pointerId) cancelTouchGesture();
    // Pointer Lock 会主动结束 capture；这不代表玩家已松开按键。
    if (document.pointerLockElement !== canvas) releaseMouseButtons();
  });
  on(canvas, 'dblclick', (event) => {
    // USER32 已依据两次物理点击及窗口类样式生成 Win32 双击；这里只压住浏览器默认动作。
    event.preventDefault();
  });
  on(
    canvas,
    'wheel',
    (event) => {
      if (!event.deltaY) return;
      flushDesktopMove();
      const delta = event.deltaY < 0 ? 120 : -120;
      const wParam = ((delta & 0xffff) << 16) | modifierFlags(event);
      vm.postMessage(0x020a, wParam, mouseLParam(event));
      event.preventDefault();
    },
    { passive: false },
  );
  on(canvas, 'contextmenu', (event) => {
    event.preventDefault();
    // macOS/WebKit 可能把 Ctrl+主键直接升级为 contextmenu，未产生可用的
    // 左键 pointerdown。正常 pointer 路径已经投递时按坐标和时间去重。
    if (!event.ctrlKey || normalizePointerButton(2, true, hostPlatform) !== 0) return;
    const lParam = mouseLParam(event);
    if (
      lastCtrlPrimaryDispatch &&
      performance.now() - lastCtrlPrimaryDispatch.at < 1_000 &&
      lastCtrlPrimaryDispatch.lParam === lParam
    ) {
      // Edge/macOS 在 DOWN 后弹 contextmenu 时可能不再给网页 pointerup。
      // 立即补齐 UP；若真实 pointerup 随后到达，会因 mouseFlags 已清而跳过。
      if ((mouseFlags & 0x0001) !== 0) {
        mouseFlags &= ~0x0001;
        vm.setKeyState(0x01, false);
        vm.postMessage(0x0202, modifierFlags(event), lParam);
      }
      compatibilityCtrlPrimaryActive = false;
      return;
    }
    flushDesktopMove();
    canvas.focus({ preventScroll: true });
    reconcileMouseModifiers(event);
    const modifiers = modifierFlags(event);
    vm.postMessage(0x0200, modifiers, lParam); // WM_MOUSEMOVE
    vm.setKeyState(0x01, true);
    vm.postMessage(0x0201, modifiers | 0x0001, lParam); // WM_LBUTTONDOWN
    vm.setKeyState(0x01, false);
    vm.postMessage(0x0202, modifiers, lParam); // WM_LBUTTONUP
    lastCtrlPrimaryDispatch = { at: performance.now(), lParam };
  });
  on(canvas, 'dragstart', (event) => event.preventDefault());
  on(canvas, 'auxclick', (event) => event.preventDefault());

  on(
    window,
    'keydown',
    (event) => {
      // 页面级快捷键（` 调试 / [ ] 速度 / F11 全屏 / ? 帮助）不注入游戏。
      if (UI_SHORTCUT_KEYS.has(event.key)) return;
      if (document.activeElement !== canvas || event.isComposing) return;
      const vk = virtualKey(event);
      if (!vk) return;
      const wasDown = heldKeys.has(event.code);
      const system = event.altKey || event.code === 'AltLeft' || event.code === 'AltRight';
      heldKeys.set(event.code, { vk, system });
      syncKeyState(event.code, vk, true);
      const lParam = keyLParam(event, false, wasDown);
      vm.postMessage(system ? 0x0104 : 0x0100, vk, lParam); // WM_SYSKEYDOWN / WM_KEYDOWN
      const character = win32CharacterCode(event);
      if (character !== null) vm.postMessage(0x0102, character, lParam); // WM_CHAR
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  on(
    window,
    'keyup',
    (event) => {
      if (UI_SHORTCUT_KEYS.has(event.key)) return;
      const genericModifier =
        event.code === 'ShiftLeft' || event.code === 'ShiftRight'
          ? 0x10
          : event.code === 'ControlLeft' || event.code === 'ControlRight'
            ? 0x11
            : 0;
      const reconciledCode = genericModifier ? reconciledModifiers.get(genericModifier) : undefined;
      const state = heldKeys.get(event.code) ?? (reconciledCode ? heldKeys.get(reconciledCode) : undefined);
      if (document.activeElement !== canvas && !state) return;
      const vk = state?.vk ?? virtualKey(event);
      if (!vk) return;
      const system = state?.system || event.altKey || event.code === 'AltLeft' || event.code === 'AltRight';
      if (reconciledCode) {
        heldKeys.delete(reconciledCode);
        reconciledModifiers.delete(genericModifier);
        syncKeyState(reconciledCode, genericModifier, false);
      }
      heldKeys.delete(event.code);
      syncKeyState(event.code, vk, false);
      vm.postMessage(system ? 0x0105 : 0x0101, vk, keyLParam(event, true, true)); // WM_SYSKEYUP / WM_KEYUP
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
  on(canvas, 'blur', releaseInput);
  on(window, 'blur', releaseInput);
  const visibilityChanged = () => {
    if (document.hidden) releaseInput();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  removers.push(() => document.removeEventListener('visibilitychange', visibilityChanged));

  // 指针锁定特效：锁定期间屏幕外圈琥珀描边 + 四角取景框呼吸闪烁
  // （#screen-frame.pointer-locked），顶部浮出「按 Esc 解锁」胶囊提示，
  // 几秒后自行淡出——浏览器把光标藏掉，边框与角标是持续存在的提示。
  const lockHint = document.createElement('div');
  lockHint.className = 'pointer-lock-hint';
  canvas.parentElement?.appendChild(lockHint);
  removers.push(() => lockHint.remove());
  let keyboardLockState: KeyboardLockState = 'inactive';
  const showLockHint = () => {
    lockHint.textContent =
      keyboardLockState === 'active'
        ? 'Esc 已交给游戏 · 长按 Esc 退出锁定 · F11 退出全屏'
        : keyboardLockState === 'pending'
          ? '正在申请 Esc 捕获权限…'
          : keyboardLockState === 'unavailable'
            ? '浏览器不支持 Esc 捕获，Esc 仍由浏览器优先处理'
            : keyboardLockState === 'denied'
              ? 'Esc 捕获未获授权，Esc 仍由浏览器优先处理'
              : '鼠标已锁定 · Esc 解锁 · 全屏可申请将 Esc 交给游戏';
    lockHint.classList.remove('show');
    void lockHint.offsetWidth;
    lockHint.classList.add('show');
  };
  removers.push(
    installFullscreenKeyboardLock(canvas, (state) => {
      keyboardLockState = state;
      if (state !== 'inactive' || document.pointerLockElement === canvas) showLockHint();
      else lockHint.classList.remove('show');
    }),
  );

  const pointerLockChanged = () => {
    if (document.pointerLockElement === canvas) {
      // 控制栏折叠、分辨率切换和画布 fit 可能发生在没有 stage ResizeObserver
      // 回调的同一布局拍。Pointer Lock 从绝对坐标切到相对坐标前强制读一次真实
      // CSS 盒，避免继续用旧 800×600/旧高度比例，导致越靠边移动越慢且到不了边界。
      refreshCanvasRect(canvas);
      lockAfterPointerUp = false;
      onCursorPresentation?.(Math.floor(logicalMouseX), Math.floor(logicalMouseY), true);
      canvas.focus({ preventScroll: true });
      canvas.parentElement?.classList.add('pointer-locked');
      showLockHint();
    } else {
      onCursorPresentation?.(Math.floor(logicalMouseX), Math.floor(logicalMouseY), false);
      cancelTouchGesture();
      releaseMouseButtons();
      canvas.parentElement?.classList.remove('pointer-locked');
      lockHint.classList.remove('show');
      // 切标签、失焦、脚本退出都会解除 Pointer Lock，不能推断为用户按了 Esc。
      // 游戏按键只来自真实 keyboard 事件；全屏 Keyboard Lock 负责捕获 Esc。
    }
  };
  document.addEventListener('pointerlockchange', pointerLockChanged);
  removers.push(() => document.removeEventListener('pointerlockchange', pointerLockChanged));

  return {
    adaptResolution,
    cleanup() {
      releaseInput();
      removers.splice(0).forEach((remove) => remove());
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    },
  };
}
