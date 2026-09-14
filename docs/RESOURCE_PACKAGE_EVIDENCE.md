# 历史资源裁剪依据

本文保留旧打包工具中被清单引用的兼容证据。基线为早期 RA2 联机精简包和 YR 原始
资源目录；它不代表当前 CI 已验收所有战役、MOD 或任意安装包。当前文件契约以
`src/games/manifest.ts` 为准，真实验收入口见 [CI 配置](REAL_GAME_CI.md)。

## YR 基包

旧工具按原始 EXE 启动与逐项缺件验证记录了以下基包文件：

- `gamemd.exe`、`ra2.mix`、`ra2md.mix`、`langmd.mix`、`language.mix`
- `thememd.mix`、`MULTIMD.MIX`、`expandmd01.mix`
- `game.fnt`、`00000409.016`、`00000409.256`
- `BINKW32.DLL`、`Blowfish.dll`，以及 `Taunts/` 目录

该列表包含当时打包保留的可选字体和嘲讽音频，并非每项都是当前启动硬依赖。
`Blowfish.dll` 会被读取，缺失或零字节不能当作完整资源。`MAPSMD03.MIX` 是战役地图，
`movmd03.mix` 与 `subtitlemd.txt` 是电影及字幕；缺少这些文件时早期 boot 基线仍能进入
主菜单，不证明对应战役可玩。启动回归为 `tests/real-game/yr/boot.test.ts`。

## RA2 战役与语言包

旧联机包内 `MAPS01.MIX` 可能是零字节占位，并且没有 `maps02.mix`；完整原版盟军、
苏军战役分别使用两者。`movies01.mix`、`movies02.mix` 和 `subtitle.txt` 用于过场。
占位与缺失必须保持区别，不能用主菜单启动结果证明战役完整。

旧 NSIS 联机包转换工具曾以 SHA-256
`870c3bcc596e8690c55077a4c651f88d0dbc35f2a786c6c4891df8ffdb9ce192`
约束与当时选用的中文版主程序配套的 `language.mix`。该哈希只描述该历史组合，
不是所有版本语言资源的通用白名单。当前 CI 校验输入整包哈希，不擅自替换语言资源。
