# 网站翻译插件词库

本目录提供网站词库数据，使用统一 JSON 协议 1；插件固定引擎和处理器负责执行，不从词库下载脚本。按主域名和目标语言组织，客户端从 index.json 和分组 manifest.json 校验字节数、SHA-256、网址范围和语言后安装。

初始数据包括 docker.com、github.com、githubstatus.com 和 tailscale.com 的 zh-Hans 词库，共 8 个数据包。共享包只适用于声明的完整 origin，不自动安装其他网址。词库更新与插件代码版本独立；读取本目录不会升级插件代码。

数据由 chrome/locals.js 和 sites/*/site.json 静态转换。初始发布时，这些来源文件已存在于仓库提交 839d608fe482cf623f2172100ee102bfce7d6e83，内容与本地生成来源逐字节一致。清点、来源提交及 SHA-256 见 [转换报告](../docs/github-dictionary-conversion.json)；该报告记录生成时状态，不表示服务器或客户端的当前运行状态。

词库来自 MaydayV/github-chinese、maboloshi/github-chinese、52cik 及社区，以及本项目的网站适配，适用 GPL-3.0-or-later。保留 [LICENSE](../LICENSE)、[来源与版权](../THIRD_PARTY_NOTICES.md)、来源文件中的版权头及上游锁定记录。
