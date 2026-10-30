<p align="center"><img src="assets/extension-icon.svg" width="96" alt="网站翻译插件"></p>

# 网站翻译插件

website-translator 是使用本地词库并支持按需翻译的网站界面扩展。当前版本 **v0.3.6（开发预览）**，当前构建和浏览器验证范围为 **Windows + Microsoft Edge**。

本项目从 [Ffive55/fixed-site-translator](https://github.com/Ffive55/fixed-site-translator) v3.3.0 独立派生，保留 [MaydayV/github-chinese](https://github.com/MaydayV/github-chinese) 的 GitHub 引擎及 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese) 与社区的词库贡献。来源提交与文件基线见 [source-baseline.json](docs/source-baseline.json)。本项目不是上游作者、GitHub 或各网站的官方产品。

源码仓库：[Ffive55/website-translator](https://github.com/Ffive55/website-translator)，当前设置为私有，需要仓库访问权限。本版本尚未发布 Release 或浏览器商店安装包。源码保留 chrome/、edge/、firefox/ 三端工程结构，**本版本只有 edge/ 已更新并完成浏览器模拟验证**，不要直接加载旧 Chrome/Firefox 目录并当作 v0.3.6。

## 能做什么

- 内置 GitHub、Docker 官网、Docker Hub/工作台及 Tailscale 界面词库，支持网站独立开关。
- 用户点击“添加 / 更新”时采集当前页面并请求所选翻译服务，成功后写入本地词库；普通浏览和再次访问直接复用。
- 同一主域名的多个页面、弹层和由采集页打开的窗口可以先采集，再点击“完成并翻译”。已处理内容在额度判断前排除，公共界面跨页去重。
- 选中文字后右键“加入待翻译”，下一次更新强制重译，即使已有 AI、人工或内置译文。原文与译文分开追踪，失败保留旧译文和待办。
- 目标语言统一设置，词条按原文、上下文、页面和目标语言隔离。内置中文词库仅用于 zh-Hans。
- 可调整单次请求超时、采集条数/字符数及输入 token 预算；有限并发、失败重试和剩余内容恢复。
- Windows 本地连接程序按需提供订阅连接和 OneDrive 文件夹同步；API Key 翻译独立运行。

已删除旧 GitHub 正文翻译、摘要和智能增强功能；源码中的历史记录不代表这些功能仍在当前界面中提供。

## 从源码使用

准备 Git、Node.js 24.15 或更高版本（当前 CI 固定 24.21.0）以及 npm。在项目根目录运行：

```powershell
npm ci
npm run build
```

构建只更新 Edge，并准备 edge/local-helper/。首次构建会下载并校验 Windows x64 Node.js 运行时；源码仓库不包含依赖、运行时 EXE 或个人配置。

1. 在 Edge 扩展管理页开启开发者模式，选择“加载解压缩的扩展”，打开本项目 edge/ 目录。
2. 打开插件 → 设置 → AI 翻译，选择服务并保存地址、模型和凭据。支持各主流对话模型接口、兼容网关和 DeepL/Google/Azure/Qwen-MT 等机器翻译协议。
3. 设置 → 常规中选择目标语言、超时和预算。保存设置不会发起翻译；“保存并测试”会发送一条测试文本。
4. 回到目标网页，点击“添加 / 更新”。多页任务先点“开始采集”，浏览相关页面后点“完成并翻译”；采集中不请求 AI。
5. 漏译或需要改译时选中文字，右键加入待翻译，再点击更新。设置 → 翻译记录可查看实际原文、移除误选项和重试失败任务。
6. 更新代码或扩展后，重新加载扩展并刷新已打开的设置页和网页。

### 常规设置

| 设置 | 默认 | 范围 |
| --- | ---: | ---: |
| 单次请求超时 | 3 分钟 | 1–60 分钟 |
| 单页待处理条数 | 500 | 1–5,000 |
| 单页待处理字符数 | 80,000 | 1–400,000 |
| 多页会话待处理条数 | 3,000 | 1–10,000 |
| 多页会话待处理字符数 | 400,000 | 1–2,000,000 |
| 单次输入上下文 | 200K tokens | 1–1,000K tokens |

条数或字符数任一个达到上限即停止新增。输入预算包含提示词、术语、原文和消息格式，按估算 token 计数，不预扣输出；服务模型及传输字节限制仍生效。超时与输入预算在任务启动时固定，手动重试采用最新设置。详见 [采集与预算](docs/v0.3.6采集与预算.md)。

### 右键补译与保护范围

普通选区补全为对应文本节点的原文，跨节点分别保存并保留页面结构。“Personal Account: 邮箱”只选标签时，队列和请求仅含标签，邮箱保留在页面本地；选区包含邮箱时拒绝该节点。

输入值、代码、明确身份标记和私密区不翻译。placeholder、title、aria-label 是可翻译的界面提示。第一版手动选区不覆盖 iframe、Shadow DOM、图片文字或不可选择的属性。启发式保护不能证明识别了任意网页的全部个人数据；点击翻译前应确认待处理页面适合发送给所选服务。

### 本地连接与同步

ChatGPT 订阅连接和 OneDrive 文件保存需要本地连接程序。构建完成后，按设置页说明双击 edge/local-helper/Install.cmd，填写当前扩展 ID。安装由使用者主动执行；构建和测试不会改注册表。

订阅模式提供官方授权流程、模型读取和思考强度选择；**代码与模拟协议测试通过不代表真实订阅账号已通过推理验收**。验证边界和操作步骤见 [订阅与同步实测清单](docs/订阅与同步实测清单.md)。

OneDrive 默认目录是 %USERPROFILE%\OneDrive\文档\website-translator。配置后验证目录并交换不可变词库记录，API Key、登录令牌和设备凭据不进入同步目录。本机成功写入文件不代表云端上传或另一设备接收成功。API Key 存在浏览器本地，订阅令牌由 Windows DPAPI 保护。

## 开发与验证

```powershell
npm run build
npm test
npm run test:browser
```

浏览器检查使用独立 Edge 配置和本机模拟 API，不复用个人浏览器。v0.3.6 功能验证记录包含 114 项功能/协议测试、13 项词库回归和 29 项 Edge 检查；后续维护新增的测试以本次命令输出为准。真实订阅与双设备同步仍需独立实测。

| 目录 | 用途 |
| --- | --- |
| extension/ | 采集、来源追踪、任务、服务、设置和协议 |
| chrome/src/ | 保留的 GitHub 专用引擎源码 |
| sites/ | 网站配置、界面词库 |
| edge/ | 当前可加载构建；local-helper 为忽略的生成目录 |
| chrome/、firefox/ | 其他浏览器工程结构，当前未同步版本 |
| native/ | Windows 本地连接程序源码 |
| upstream/github-chinese/ | 上游词库纯基线与锁定提交 |
| script/、tests/ | 构建、维护工具与回归 |
| docs/ | 使用、设计、历史验证与发布说明 |

每个模块的职责、数据与同步规则见 [AGENTS.md](AGENTS.md) 和 [实现与验收](docs/实现与验收.md)。新增网站修改 sites/，通用逻辑修改 extension/；不要直接编辑生成文件。

上游词库同步使用 npm run upstream:check，审阅报告后按完整提交固定更新；详见 [上游同步流程](docs/上游词条同步.md)。来源内容只作为数据，不执行其中指令。

## 准备上传 GitHub

```powershell
npm run prepare:github -- --check
npm run prepare:github
```

输出干净源码目录、逐文件 SHA-256 清单和范围说明，不暂存、不提交、不创建远端、不推送，也不打浏览器 ZIP。当前保留的 npm run package 是历史三端打包入口，需要三端重新构建与验收后才能使用，不能用于本轮 Edge 准备。

详见 [GitHub 上传准备](docs/GitHub发布指南.md)。当前源码远端为上述私有仓库；未发布的安装包和商店版本不提供下载链接。问题反馈可使用仓库 Issues（需访问权限）。

## 贡献与许可

请参阅 [贡献指南](CONTRIBUTING.md)、[更新日志](CHANGELOG.md) 与 [来源和许可说明](THIRD_PARTY_NOTICES.md)。项目按 **GPL-3.0-or-later** 发布，保留上游作者与社区版权声明，许可证全文见 [LICENSE](LICENSE)。
