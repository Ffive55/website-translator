# GitHub 源码发布与复现

当前版本 v0.3.25，公开源码仓库为 [Ffive55/website-translator](https://github.com/Ffive55/website-translator)。当前只构建和验证 Windows + Edge，不修改或覆盖来源项目 fixed-site-translator。

2026-10-31：用户已将 v0.3.25 提交 Edge 商城审核，状态为 In review、简体中文、Productivity、Hidden，尚未上架；随后明确要求将完整源码和 README 等说明上传到本仓库。状态依据用户提供的 Partner Center 页面，详见 [商城发布状态](Edge商城发布状态.md)。

## 获取完整源码

在可用的终端运行：

```powershell
git clone https://github.com/Ffive55/website-translator.git
cd website-translator
npm ci
npm run build
npm test
```

Node.js 至少 24.15.0，CI 固定 24.21.0。构建会校验 Windows x64 Node.js 运行时并生成忽略的 edge/local-helper/，不执行安装、不改注册表。随后在 Edge 扩展管理页启用开发者模式，加载 edge/。其他浏览器目录保留来源结构，不作为 v0.3.25 当前可用包宣传。

仓库包含 extension/、native/、sites/、dictionaries/、script/、tests/、docs/、store/、上游基线和生成的 Edge 运行资源；保留 LICENSE、THIRD_PARTY_NOTICES.md、来源记录与原作者致谢。不包含 node_modules、缓存、个人浏览器数据、API Key、令牌、运行日志、原生二进制或本地生成依赖。

## 词库搜索与商城搜索

词库搜索在扩展设置的网站管理底部。留空列出当前目标语言未完整下载的主域名；输入域名或网址可筛选，下载按主域名包含已发布子域名。不存在目标语言词库时应切换语言或选择提供该词库的仓库，不把其他语言译文当作当前语言。

GitHub 可搜索 website-translator 或“网站翻译插件”获取公开源码。商城提交目前为 Hidden，审核通过后仅通过直接链接访问，不在商城搜索或分类浏览中展示。若要公开搜索，需发布者以后将 Visibility 改为 Public，并核实实际生效。尚未上架时不填写虚构安装链接。

## 打包和审核资料

```powershell
npm run store:screenshots
npm run package:edge-store
```

分别生成 edge-store.zip、独立 Windows x64 helper.zip、source.zip 和审核资料目录/ZIP。上传商城时只选择 edge-store.zip，不上传审核总包。商城 ZIP 不含原生安装程序或嵌套压缩资源，带 zh_CN 默认语言及完整 _locales 消息文件。

本地程序仅用于已安装者的可选 ChatGPT 订阅路径，当前不提供公开下载；API 和词库无需安装。安装由用户手动运行，商城提交不会自动安装本地程序。公开隐私政策为仓库根目录 PRIVACY.md，发布者为 Ffive55，公开联系邮箱 ffive@foxmail.com。

## 白名单源码导出

```powershell
npm run prepare:github -- --check
npm run prepare:github
```

该命令只在 .cache/github-ready/ 导出新候选目录，不暂存、提交或推送。包含逐文件 SHA-256 的 inventory.json、filelist.txt 和准备说明；sourceCommit 为 null 时表示该导出尚未建立提交。敏感信息检查只显示路径和规则，不输出匹配内容；规则扫描不能代替审阅。

## 本次上传方法与范围

原工作区保留未提交文件及索引。使用远端 main 的独立 Git 目录，审阅与本地基线相比的远端变更，保留先前 PRIVACY.md 提交；只将审查后的白名单源码应用到候选目录，逐项暂存差异并核对树。推送是普通 main 快进，不强推，不重置原目录。

提交前验证候选版本、Edge 构建、测试和生成文件一致性；推送前再次读取远端分支，存在新变化则重新审阅。推送后核对远端提交及候选文件。授权仅覆盖完整 v0.3.25 源码和相关说明，不创建 Release、标签或再次提交商城。

## GitHub Actions 与验收边界

CI 使用 Windows、固定 Node.js 24.21.0、锁定 npm 依赖，检查 Edge 构建、完整测试和源码清单；工作流仅有读取仓库权限。手动 Prepare source snapshot 导出候选和清单到 Actions artifact，不发布 Release 或推送。

自动化和模拟浏览器测试不代表真实付费服务、订阅权限或真实账号双设备同步验收。商城已提交审核与审核通过、Hidden 与 Public、源码公开与商店上线均分别记录。

## 来源及隐私

保留 MaydayV/github-chinese、maboloshi/github-chinese、docs/source-baseline.json 和 upstream/github-chinese/ 来源追溯。本项目是独立派生版本，遵循 GPL-3.0-or-later。公开联系邮箱由用户明确指定；其他个人信息、凭据或日志不进入提交。
