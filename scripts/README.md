# 开发工具

日常命令以根 `package.json` 为入口；测试放在 `tests/`，此目录只保留开发和维护工具。

| 目录           | 用途                                                  |
| -------------- | ----------------------------------------------------- |
| `ci/`          | CI 编排、进程清理、可信资源下载与校验                 |
| `resources/`   | 准备主程序、本地 ZIP 留档和下载共用模块               |
| `assets/`      | 从游戏原始资源提取图标和卷轴精灵，保留来源与像素依据  |
| `reverse/`     | PE 地址、导入、调用和写入检索；需自备 EXE，原文件只读 |
| `benchmarks/`  | 固定工作量的宿主微基准，不代表整局 FPS                |
| `experiments/` | 离线模型转换和画质比较，不进入生产和 Basic CI         |
| `deploy.sh`    | 显式调用的站点部署命令，配置由调用者提供              |

格式直接使用 Prettier：`pnpm run format` 写入，`pnpm run format:check` 校验。
不再维护自制格式脚本或游戏包 Blob 上传入口。游戏原始包由前端直接导入；
CI 使用同一提取器，历史裁剪依据保留在 [资源证据](../docs/RESOURCE_PACKAGE_EVIDENCE.md)。

逆向工具以 EXE 路径和十六进制地址为参数，例如：

```bash
pnpm exec tsx scripts/reverse/ra2Imports.mts "$GAME_EXE"
pnpm exec tsx scripts/reverse/ra2Dis.mts "$GAME_EXE" 400000 40
```

第二个命令输出原始字节，调用者可将其交给 NASM 的 ndisasm 解码；命中结果需要结合
实际指令边界复核，不能据此直接对未知版本打补丁。

## 画面与资源诊断

- `experiments/probeReShadeUi.mts` 验证真实 RA2 的效果开关与同帧恢复；
  `experiments/probeReshadeRender.mts` 需要自备 FX 编译输出，边界见
  [ReShade 适配](../docs/RESHADE_ADAPTATION.md)。
- `experiments/captureSrBattle.mts` 保留原始战役截图采样工具；需自备 RA2 素材，
  默认输出 `.tmp-sr-battle`，通过 `RA2_SR_OUTPUT` 指定新目录。该脚本依赖原版菜单
  布局和剧情推进，不属于公共准入，不能用生成了图片代替战场验收。
- `ci/prepareGameProcess.mts <ra2|yr> <绝对资源目录>` 是独立资源准备子进程入口，
  配合 `ci/memory.ts` 记录 RSS、容器内存和 OOM 计数；当前尚未替换 CI 的主入口。
  与 `ci/prepareGame.ts` 使用不同模块名，避免扩展名解析把库导入误当 CLI 执行。
