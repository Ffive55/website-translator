# Tailscale 页面检查记录

日期：2026-10-30。目标是工作台全部主导航、已发现的常用子页与标签，以及官网首页主要功能区。

检查方式：在用户已登录的 Edge 中逐页读取实际界面，补充固定词库，然后加载修改后的扩展进行回归。没有修改 Tailscale 网络或账户配置，没有创建凭据，没有提交购买。下表的“已检查”表示实际打开并核对过该视图；不代表所有账号、所有套餐、所有数据状态下的文案均已穷尽。

## 工作台主导航及子页面

路径前缀均为 `https://console.tailscale.com`。

| 区域 | 页面/视图 | 检查路径 | 结果 |
| --- | --- | --- | --- |
| 网络 | 设备列表 | `/admin/machines` | 已检查；补齐横幅、说明、表头及图标提示 |
| 网络 | 设备详情 | `/admin/machines/<设备地址>` | 已检查代表性设备；保留名称、地址、版本、节点公钥和技术属性 |
| 网络 | 设备筛选菜单 | 设备列表弹出菜单 | 已检查 |
| 网络 | 设备操作菜单 | 设备列表弹出菜单 | 已检查，未执行修改操作 |
| 网络 | 路由设置弹窗 | 设备详情“编辑” | 已检查后取消，未更改开关 |
| 网络 | 应用列表 | `/admin/apps` | 已检查；补齐说明、空状态 |
| 网络 | 添加应用 | 应用列表弹窗 | 已检查后取消，未创建应用 |
| 网络 | 已发布服务 | `/admin/services` | 已检查；补齐三步说明 |
| 网络 | 已发现服务 | `/admin/services` 的“已发现”标签 | 已检查；当前未启用端点收集，未开启监测 |
| 网络 | 定义服务 | `/admin/services/new` | 已检查，未填写或提交 |
| 网络 | DNS | `/admin/dns` | 已检查；补齐名称服务器、搜索域、MagicDNS、HTTPS 说明 |
| 用户 | 用户列表 | `/admin/users` | 已检查；补齐邀请、批准提示、表头 |
| 访问控制 | 常规访问规则 | `/admin/acls/visual/general-access-rules` | 已检查并验证中文效果 |
| 访问控制 | Tailscale SSH | `/admin/acls/visual/tailscale-ssh` | 已检查 |
| 访问控制 | 自动批准规则 | `/admin/acls/visual/auto-approvers` | 已检查；路由、服务、出口节点三部分 |
| 访问控制 | 常规与 SSH 测试 | `/admin/acls/visual/tests` | 已检查 |
| 访问控制 | 分组定义 | `/admin/acls/visual/groups` | 已检查 |
| 访问控制 | 标签定义 | `/admin/acls/visual/tags` | 已检查 |
| 访问控制 | IP 集合 | `/admin/acls/visual/ipsets` | 已检查 |
| 访问控制 | 主机 | `/admin/acls/visual/hosts` | 已检查 |
| 访问控制 | 设备安全状态 | `/admin/acls/visual/postures` | 已检查 |
| 访问控制 | 节点属性 | `/admin/acls/visual/node-attributes` | 已检查 |
| 访问控制 | JSON 编辑器 | `/admin/acls/file` | 已检查外围控件；策略代码保持原文 |
| 访问控制 | 变更预览 | `/admin/acls/diff` | 已检查；未修改策略 |
| 访问控制 | 规则预览 | `/admin/acls/preview` | 已检查 |
| 日志 | 配置日志 | `/admin/logs` | 已检查；补齐筛选与表头，不改写业务日志数据 |
| 日志 | 网络流量日志 | `/admin/logs/network` | 已检查；当前套餐启动按钮禁用 |
| 设置 | 常规 | `/admin/settings/general` | 已检查 |
| 设置 | 路由选择 | `/admin/settings/general/route-selection` | 已检查；部分选项受套餐限制 |
| 设置 | Mullvad 配置 | `/admin/settings/general/mullvad` | 已检查入口说明；未购买附加服务 |
| 设置 | 用户管理 | `/admin/settings/user-management` | 已检查 |
| 设置 | 设备管理 | `/admin/settings/device-management` | 已检查 |
| 设置 | 设备安全状态集成 | `/admin/settings/device-management/posture` | 已检查；当前套餐供应商选项禁用 |
| 设置 | 策略文件管理 | `/admin/settings/policy-file-management` | 已检查 |
| 设置 | 信任凭据 | `/admin/settings/trust-credentials` | 已检查空列表；未创建凭据 |
| 设置 | Webhook | `/admin/settings/webhooks` | 已检查空状态 |
| 设置 | 联系偏好 | `/admin/settings/contact-preferences` | 已检查标签与说明；邮箱保持原样 |
| 设置 | 账单用量 | `/admin/settings/billing` | 已检查 |
| 设置 | 发票 | `/admin/settings/billing/invoices` | 已检查无发票状态 |
| 设置 | 账单详情 | `/admin/settings/billing/billing-details` | 已检查无账单详情状态 |
| 设置 | 附加服务 | `/admin/settings/billing/add-ons` | 已检查；未进入结算或购买 |
| 设置 | 密钥 | `/admin/settings/keys` | 已检查空状态和说明；未生成密钥或令牌 |
| 资源 | 资源中心 | `/admin/resource-hub` | 已检查默认家庭实验室视图 |

## 首页和浏览器翻译

- 官网 `https://tailscale.com/`：核对导航、产品入口和首页主要介绍区的实时公开 HTML；补齐首屏标题、介绍、产品卡片和主要分区。
- 在真实 Edge 中逐一切换首页企业 VPN、特权访问、AI 安全、基础设施访问、零信任网络五张产品卡片，以及 IT、安全、DevOps、工程团队四个标签，补齐切换后才出现的文案。
- 登录页 `https://login.tailscale.com/login`：已有按钮及占位符翻译测试；不操作登录凭据。
- 已适配域名由 manifest 在 `document_start` 注入浏览器翻译保护。真实 Edge 工作台已确认 `meta[name="google"]` 为 `notranslate`，冷加载后保持本插件词库翻译，没有出现浏览器对产品名的机翻。
- 关闭插件时撤销本插件自己的标记；这不改变 Edge 全局语言设置。

## 验证和边界

保留原 GitHub 回归测试，多网站测试新增大小写、省略号、SVG 无障碍提示、设备名称保护及浏览器翻译标记生命周期检查。

用户截图回归：顶部横幅两段、Mullvad 可见链接、设备管理可见链接、搜索占位符、LAST SEEN 表头、底部安装说明均已在真实 Edge 设备页验证。专门使用 DOM 文本与 placeholder 复查，避免 aria-label 已翻译但屏幕文字仍是英文。回归截图保存在 `test-results/tailscale-machines-fixed.png`。

当前没有测试付费套餐专有功能的完整工作流程、创建数据后才出现的详情页、结算流程及全部弹窗组合；没有为了覆盖率购买服务、开启监控或生成凭据。已有数据与无数据时界面可能不同。官网文档、博客及客户引用长文仍不属于工作台界面词库的覆盖目标。后续出现新的固定英文文案，可继续补入网站词库。
