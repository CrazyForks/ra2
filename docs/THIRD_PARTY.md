# 许可证与第三方内容

项目原创代码采用 GPL-3.0-or-later。根 LICENSE 和 relay 包 LICENSE 为 GPL 第 3 版全文，
package.json 的 SPDX 标识指定第 3 版或后续版本。第三方版权和许可不被本声明替换。

| 内容                                                | 来源与维护入口                                                           | 适用边界                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| v86、React、7z-wasm、fflate、onnxruntime-web 等依赖 | package.json、pnpm-lock.yaml、各依赖 LICENSE                             | 保留各依赖的原始许可                                          |
| relay 的 ws 依赖                                    | packages/relay/package.json；服务构建输出 licenses/ws/                   | 分发时保留版权与许可证                                        |
| LZMA-JS（lzma npm v2.3.2）                          | src/utils/archive/vendor/lzma-worker.js 与同目录 lzma-worker.LICENSE.txt | Nathan Rugg 的 MIT 许可；保留本地补丁说明                     |
| Anime4K shader                                      | src/ui/pages/game/vendor/README.md 与 shader 文件头                      | 原文件中的 MIT 声明保持完整                                   |
| 当前启动页背景                                      | PR #17，提交 9ae5cb6；public/backgrounds/ra2vm-launcher-background.jpg   | 按用户选择接入；上游 patch 未附独立素材许可，不据此推定为 GPL |
| game.exe、gamemd.exe、MIX、地图、音视频等游戏文件   | 游戏清单和玩家提供的资源                                                 | 不属于本项目 GPL 代码，不随源码仓库提供                       |

来源说明不能替代完整的授权记录；发布者需要单独核对这些素材的
分发范围。添加 GPL 不代表这些素材已经完成许可核验。主程序的获取配置同样不改变
程序本身的权属或许可。更新依赖和素材时保留来源、版本、原始版权和许可文本。
