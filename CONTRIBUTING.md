# 贡献指南

欢迎补充网站词库、修复界面适配或改进构建与测试。

## 报告漏译或异常

请提供网站网址/页面路径、浏览器及插件版本、原英文、期望译法和复现步骤。截图请隐藏邮箱、设备地址、令牌等个人信息。注明是否同时开启浏览器自动翻译。

## 修改流程

1. 安装 Node.js 24.15+ 和 Git，执行 `npm ci`。
2. 网站词库修改 `sites/<id>/site.json`，通用逻辑修改 `extension/`。
3. GitHub 引擎修改 `chrome/src/`；GitHub 词库本地修订需保持三端一致。
4. 执行 `npm run build` 与 `npm test`，在独立 Edge 配置中实际检查受影响的页面（当前范围仅 Edge）。
5. 执行 npm run prepare:github -- --check；提交源文件和对应 Edge 生成产物，说明修改原因与验证范围。

不要对所有网站注入同一套词库，不要改写用户输入、代码或业务标识。新增功能应遵守总开关与网站独立开关，并维持最小必要权限。

上游词库更新请使用 [同步流程](docs/上游词条同步.md)，不要直接覆盖整个上游仓库或手动重写基线。

GitHub 集中词库正在分阶段迁移。`dictionaries/` 当前是静态生成的候选，执行 `npm run build:dictionaries` 更新，报告在 `docs/github-dictionary-conversion.json`。新增函数、正则或页面范围需要本地审阅白名单；不得执行下载的 JavaScript。迁移模块尚未接入正常入口，不能据此删除当前内置分发或旧同步流程。开发范围及后续验收见 [实施计划](docs/GitHub词库迁移实施计划.md)。

提交的修改沿用项目 GPL-3.0-or-later 许可证，并保留来源与版权说明。
