import { installNavigationGuard } from './ui/pages/game/navGuard';
import { preloadThirdPartyFiles } from './adapter/thirdPartyFiles';
import { GAME_MANIFESTS } from './games/manifest';
import { createElement } from 'react';
import { AppShell } from './ui/pages/game/AppShell';
import { createRoot } from 'react-dom/client';
import { UiErrorBoundary } from './ui/shared/components/UiErrorBoundary';

// 与页面模块初始化并行，不等待玩家选包；启动时复用缓存或同一条在途请求。
void preloadThirdPartyFiles(Object.values(GAME_MANIFESTS));

// 页面生命周期级导航护栏：后退/前进、鼠标侧键、Alt+← 等误触一律留在本页
// （开发调试可用 ?nav-guard=0 关闭）。安装一次，与 VM 生命周期无关。
installNavigationGuard();

// PWA：生产环境注册服务线程（浏览器「安装」的必要条件）。开发服务器不注册，
// 避免与禁缓存/手动刷新策略打架；load 后注册，不与首次启动资源加载竞争。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
      console.warn('[PWA] 服务线程注册失败', error);
    });
  });
}

// 整个应用只有一个根，VM 在组件提交后通过 canvas ref 接入，不需要 flushSync。
const root = createRoot(document.getElementById('root')!);
root.render(createElement(UiErrorBoundary, null, createElement(AppShell)));
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
