# GitHub 上传准备

项目名为“网站翻译插件”，建议仓库名为 website-translator。当前版本 v0.3.16 是开发预览，源码远端已于 2026-10-30 创建为私有仓库 [Ffive55/website-translator](https://github.com/Ffive55/website-translator)。来源仓库不是本项目的上传目标。

2026-10-31 补充：用户已授权发布初始词库（5c4b8f57d6f655692e8b95e9fc6f001211469bb0），随后授权上传全部 v0.3.16 新源码。实际发布使用白名单快照及隔离 Git 工作目录，保留原工作区文件与索引；不打包或创建 Release。下方“不推送”为准备命令自身的边界，实际发布另按当次用户授权执行。

## 当前准备范围

本轮准备源码目录、文档、来源许可、文件清单和自动检查。不建立提交、不修改原工作区索引、不创建 GitHub 仓库、不推送、不打浏览器安装包。本项目首次上传已由用户授权，目标为 Ffive55/website-translator、Private；下列导出命令本身仍不操作远端。

当前仅 Edge 目录为 v0.3.16 的已更新构建；chrome/ 和 firefox/ 保留工程结构与词库，不能作为当前版本安装包宣传。历史文档中“三端同步构建/打包”的步骤不适用于本轮准备。

## 生成干净源码目录

在项目根目录运行：

```powershell
npm ci
npm run build
npm test
npm run prepare:github -- --check
npm run prepare:github
```

prepare:github 只读取白名单，输出到 .cache/github-ready/ 下的新目录，不覆盖上次输出、不改动 Git 索引。每次输出包含：

- website-translator/：候选上传源码。包含 GPL 许可证、来源记录、上游锁定词库、源码、测试、文档和必要的生成文件。
- inventory.json：每个文件的大小与 SHA-256，以及整个清单的摘要。尚未提交时 sourceCommit 保持 null，不伪造提交身份。
- filelist.txt：已审阅范围的相对路径清单。
- PREPARATION.txt：范围与限制。

node_modules、local-helper、缓存、日志、截图、令牌存储、私钥与本机配置不会随源码导出。规则扫描只报告可疑路径和规则，不打印密钥内容；它不替代人工审阅。

源码快照不包含本地连接程序的生成依赖。使用者运行 npm ci 和 npm run build 后生成 edge/local-helper/，安装仍由使用者自行运行。源目录可以保留在本机原位，上传使用候选副本即可。

## 后续明确授权上传时

1. 核实 GitHub 账号、目标仓库名与可见性，查询目标是否已经存在；不要覆盖来源仓库或既有远端。
2. 再次核对候选目录与 inventory.json，记录本轮验证范围。若文件有变更，重新生成清单。
3. 在候选源码根目录建立独立 Git 仓库（如还没有），仅逐项暂存已确认文件，不使用 git add .，不批量重置或清理原目录。
4. 审阅暂存差异，创建初始提交；设置经过核实的真实远端，普通推送，不强推。
5. 读取远端分支和提交，验证与本地一致。只有远端确实存在后，才填写真实 repository、homepage、bugs 链接。

GitHub Release、版本标签、商店提交及安装包属于另外的发布动作。本轮不执行。若未来要求发布三端，需在隔离目录重新构建三端并逐项验证，不能把本轮旧 Chrome/Firefox 目录直接打包成 v0.3.6。

## GitHub Actions

CI 使用 Windows、固定 Node.js 24.21.0、锁定 npm 依赖，检查 Edge 构建、完整测试和源码清单；只有读取仓库权限。手动 Prepare source snapshot 工作流导出源码候选和清单到 Actions artifact，不创建 Release 或推送提交。GitHub 云端工作流需实际上传后才能验证，目前的检查是本地验证。

Action 引用固定为已核对的完整提交，来源为 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node) 和 [upload-artifact](https://github.com/actions/upload-artifact) 官方仓库。

## 许可与数据边界

保留 LICENSE、THIRD_PARTY_NOTICES.md、原版权头、MaydayV/github-chinese 与 maboloshi/github-chinese 致谢，以及 docs/source-baseline.json 和 upstream/github-chinese/。本项目是独立派生版本，未以原作者官方版本身份发布。

公开前确认文档及配置不含真实邮箱、设备名、密钥或个人浏览器数据。真实订阅账号和双设备同步未验收的边界应继续保留。
