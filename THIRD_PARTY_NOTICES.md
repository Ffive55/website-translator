# 来源与许可说明

本项目是独立维护的派生版本，不是 GitHub、Tailscale 或上游作者发布的官方产品。

- 直接来源：[Ffive55/fixed-site-translator](https://github.com/Ffive55/fixed-site-translator)，版本 v3.3.0，提交 `74c1791cef46637991625de0407e5fba836cd303`。网站翻译插件（website-translator）在独立目录开发，来源项目的词库、维护历史和许可证继续保留。
- 扩展基础：[MaydayV/github-chinese](https://github.com/MaydayV/github-chinese)，初始版本 v3.1.2，chrome 分支，提交 `fa48c902e1858627a56d3c552066b11499b31af2`。
- GitHub 词库：[maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)，由 52cik、maboloshi 及社区维护。
- 原词库文件中的版权声明与许可头已保留，源码沿用 GPL-3.0-or-later，许可证全文见 [LICENSE](LICENSE)。
- `dictionaries/` 的 JSON 迁移候选沿用原词库 GPL-3.0-or-later；来源提交与原文件 SHA-256 见 `docs/github-dictionary-conversion.json`。`extension/github-dictionary-handlers.js` 中的 53 个固定处理器来自原 GitHub 词库，保留原版权及“第 3 版或更新版本”许可头。
- 本项目新增多网站适配层、Tailscale 词库、独立网站开关、构建和上游同步工具，按相同许可证发布。
- 新版扩展图标源文件为 `assets/extension-icon.svg`，由本项目绘制，不再使用上游旧图标。
- tldts（MIT）及其 Public Suffix List 数据用于主域名与公共托管租户分组，构建时打入扩展的 managed/tldts.js；完整许可见包内 managed/TLDTS-LICENSE。来源：https://github.com/remusao/tldts 。
- jose（MIT）用于本地连接程序校验 OpenAI ID Token，随 Edge 的 local-helper 目录提供；完整许可为 local-helper/node_modules/jose/LICENSE.md。来源：https://github.com/panva/jose 。
- Windows x64 Node.js 24.21.0 运行时随 local-helper/runtime/node.exe 提供，来源为 Node.js 官方发行文件；发行归档 SHA-256 见 local-helper/runtime/source.json。完整 Node.js 及其内含第三方组件许可证为 local-helper/runtime/LICENSE.txt。来源：https://nodejs.org/dist/v24.21.0/ 。
- 其余 Node 开发依赖仅用于构建、测试、打包；各依赖许可随 npm 包提供。
- Acorn 8.19.0（MIT）仅用于构建时静态解析旧词库，不随浏览器运行代码加载；完整许可位于开发依赖 `node_modules/acorn/LICENSE`。来源：https://github.com/acornjs/acorn 。

上游的浏览器商店链接不代表本派生版。当前测试阶段只更新本地 Edge 解压目录，不生成新发布包。
