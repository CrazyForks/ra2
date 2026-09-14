/* RA2/YR PWA 服务线程：满足浏览器「安装」条件的最小实现。
 * 策略刻意保守：
 *  - 导航请求 network-first，失败回退缓存的 index.html（离线兜底）；
 *  - dist/assets 带内容哈希的静态资源 cache-first + 后台更新；
 *  - 其余同源 GET（皮肤/图标等）network-first，成功才写缓存（不缓存 404）；
 *  - 游戏文件本体由玩家本地导入并保存在浏览器 IndexedDB，不经 SW；
 *  - 开发服务器（localhost:15174）不注册本线程，避免与禁缓存策略打架。 */
const APP_SHELL = 'ra2vm-app-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== APP_SHELL).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // 离线兜底：网络优先，失败回退已缓存的 index.html。
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(APP_SHELL);
          cache.put('/index.html', response.clone()).catch(() => {});
          return response;
        } catch {
          const cached = await caches.match('/index.html');
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // 带内容哈希的构建产物：不可变，缓存优先 + 后台更新。
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        const refresh = fetch(request).then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(APP_SHELL);
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        });
        return cached ?? refresh;
      })(),
    );
    return;
  }

  // 其余同源资源（皮肤、图标等）：网络优先，成功才缓存。
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(APP_SHELL);
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        return cached ?? Response.error();
      }
    })(),
  );
});
