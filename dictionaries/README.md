# 网站词库

这里是从旧词库静态转换并供 GitHub 分发的统一数据。当前 Edge 已从本地下载缓存读取，正常构建不把这些词库嵌入加载包。初始词库已于 2026-10-31 发布到 main，初始提交为 5c4b8f57d6f655692e8b95e9fc6f001211469bb0。私有仓库需在每台设备配置读取凭据。

```powershell
npm run build:dictionaries
npm run test:dictionaries
```

`npm run build` 同时更新候选数据和 Edge 解压目录，不生成 ZIP、不上传。`node script/build-dictionaries.cjs --check` 校验可重现产物。当前阶段由 `chrome/locals.js` 和 `sites/*/site.json` 生成，不手改候选文件；插件上传的新增/修改存放在受校验的增量包中；构建保留已发布的增量、其他语言和自定义分组。

- `index.json` 列出分组清单、各语言修订、字节数和 SHA-256。
- `<group>/manifest.json` 明确列出语言、完整 origin、文件及依赖。
- `<group>/zh-Hans/*.json` 包含静态数据及固定本地处理器 ID，没有远程函数或脚本。
- `shared-docker.json` 仅限 Docker 官网的两个网址，`shared-docker-hub.json` 仅限工作台/Hub 两个网址；即使同属 docker.com 也不合并适用范围。Tailscale 共享文件只含原适配器明确列出的四个网址。
- GitHub、Gist、Skills、Education 和 GitHub Status 保留独立页面范围；githubstatus.com 独立归组。现阶段不为未配置网站或不存在的语言生成数据。

协议详见 [GitHub词库协议](../docs/GitHub词库协议.md)，清点与来源见 [机器可读转换报告](../docs/github-dictionary-conversion.json)，剩余工作见 [实施计划](../docs/GitHub词库迁移实施计划.md)。转换报告记录生成时的状态，不代表当前客户端或远端发布状态。所有数据文件按固定提交统一读取；源码版本和词库修订彼此独立。

这些词库来自 MaydayV/github-chinese、maboloshi/github-chinese、52cik 及社区，以及本项目的网站适配。适用 **GPL-3.0-or-later**；请保留 [LICENSE](../LICENSE)、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)、上游锁定提交与原文件版权头。由 JSON 转换不会改变许可和来源要求。迁移报告不是浏览器设备数据，不含 API Key 或运行凭据。

插件后续上传可以增加其他主域名和语言，当前可用数据以 index.json 为准。源码构建保留这些已发布数据，不清空用户新增词库。
