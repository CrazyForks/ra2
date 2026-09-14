/**
 * 导航护栏：把浏览器的「后退/前进」挡在本页外，防止游戏时误触。
 *
 * 三个来源分别封堵：
 * - 鼠标侧键（XButton1/XButton2）——游戏鼠标握持时最容易误触，浏览器默认后退/前进；
 * - Alt+← / Alt+→ / Alt+Home 快捷键——焦点不在 canvas 时 page.ts 的按键拦截不生效；
 * - 历史记录陷阱——后退/前进按钮、触控板横扫后退、Android 返回键都原地落在本页。
 *
 * 注意：Edge 的「鼠标手势」（按住右键拖动=后退/前进，新版本默认开启）是浏览器层
 * 行为，网页无法用 preventDefault 屏蔽，指针锁定也拦不住——右键拖地图会被它截胡，
 * 只能由用户到 edge://settings/appearance 关闭或把本站加进其阻止列表（见下文提示）。
 *
 * 页面生命周期级护栏：安装一次，VM 重启不重装。开发调试可用 ?nav-guard=0 关闭
 * （与 ?fast-files=0 同一 0/1 约定）。iOS Safari 的边缘横扫后退不受网页控制，只
 * 能靠陷阱尽量减少落错页的可能，无法完全禁用。
 */
export function installNavigationGuard(): () => void {
  if (new URLSearchParams(window.location.search).get('nav-guard') === '0') return () => {};

  // Edge 鼠标手势诊断提示：网页层面无从检测该手势何时接管（事件到不了页面），
  // 只能静态提示一次，方便玩家自行关闭。
  if (navigator.userAgent.includes('Edg/')) {
    console.warn(
      '[导航护栏] 检测到 Edge：若右键拖动触发后退/前进，请在 edge://settings/appearance 关闭「鼠标手势」，或把本站加入「配置鼠标手势 → 阻止列表」（该手势是浏览器层行为，网页无法禁用）。',
    );
  }

  // 1. 鼠标侧键：XButton1=后退(3)、XButton2=前进(4)。Chromium 系（Edge/Chrome）
  //    在 mouseup 决定导航，preventDefault 它即可取消；mousedown/auxclick 补漏
  //    （旧 Chromium 允许 mousedown 取消导航，auxclick 兜底其余默认动作）。
  //    capture 保证点在任何区域（canvas、工具栏、黑边）都先于其他处理器拦截。
  const blockMouseNavigation = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };
  window.addEventListener('mousedown', blockMouseNavigation, { capture: true });
  window.addEventListener('mouseup', blockMouseNavigation, { capture: true });
  window.addEventListener('auxclick', blockMouseNavigation, { capture: true });

  // 2. 键盘导航快捷键。page.ts 只在 canvas 聚焦时拦截按键（并转发给客体），
  //    此处无差别压掉浏览器默认动作；不阻断 VM 按键转发，游戏仍能收到按键。
  const blockKeyboardNavigation = (event: KeyboardEvent): void => {
    if (!event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home') event.preventDefault();
  };
  window.addEventListener('keydown', blockKeyboardNavigation, { capture: true });

  // 3. 历史陷阱：本页在历史栈里垫一层同 URL 记录；popstate（用户按后退/前进）
  //    时立即重新垫上，页面原地不动。后退一层垫一层，记录数不增长。
  //    沙箱 iframe 等环境可能拒绝 pushState——护栏其余部分仍生效。
  const guardState = { ra2VmNavGuard: true };
  const repush = (): void => {
    try {
      history.pushState(guardState, '');
    } catch {
      // pushState 被环境拒绝时放弃陷阱；陷阱之外的防护不受影响。
    }
  };
  try {
    // 刷新/bfcache 恢复时当前条目已带护栏状态：只替换不追加，避免每刷一次多垫一层。
    const prior = history.state as { ra2VmNavGuard?: boolean } | null;
    history.replaceState(guardState, '');
    if (!prior?.ra2VmNavGuard) history.pushState(guardState, '');
    window.addEventListener('popstate', repush);
  } catch {
    // replaceState/pushState 被环境拒绝：本页不垫历史层，鼠标/键盘护栏仍生效。
  }

  return () => {
    window.removeEventListener('mousedown', blockMouseNavigation, true);
    window.removeEventListener('mouseup', blockMouseNavigation, true);
    window.removeEventListener('auxclick', blockMouseNavigation, true);
    window.removeEventListener('keydown', blockKeyboardNavigation, true);
    window.removeEventListener('popstate', repush);
  };
}
