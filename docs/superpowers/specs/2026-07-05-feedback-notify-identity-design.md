# Feedback / 定向通知 / 用户身份 — 设计文档

日期:2026-07-05
状态:待用户确认
背景:目前问题全靠用户口头反馈(如 Adrian 的 npm E404、CMS 路径 bug),作者希望主动、自动地获知问题,并能定向推送更新通知。

## 总体架构(零后端)

| 关注点 | 存放/通道 | 谁维护 |
|---|---|---|
| 用户身份 | 系统账号名,App 自动读取(本地 SQLite 存显示名) | 无人,自动 |
| 用户名单 | Wasabi `registrations/` 对象列表,App 激活时自动写入 | 无人,自动 |
| Feedback | Lark 群卡片(实时)+ Wasabi `feedback/` 对象(存档) | — |
| 更新通知 | Wasabi `announcements.json`(公开读),App 启动轮询 | shieng 上传 |
| Lark webhook URL | remote config JSON(可轮换不发版) | shieng |
| DeepSeek 分诊 | 作者侧运行(不进 App),读 Wasabi 存档 | shieng(Phase 4) |

明确不做:密码/SSO 登录、后端服务、Postgres 直连(凭证嵌入客户端等于交出整库,若将来需要权限级用户管理,单独立项做小 API + Postgres)。

## 1. 用户身份(轻量,自动)

- Rust command 读操作系统账号名(如 `adrianchong`)作为 `userId`,不可由用户输入
- Settings 可选填显示名(装饰用),存 SQLite `penguin-user-display-name`
- 首次身份确定 + 每次版本变更时,发「注册卡」到 Lark 群并 PUT `registrations/<userId>.json` 到 Wasabi(内容:userId、显示名、版本、平台、时间)
- 名单从空开始,随使用自动生长;作者 list `registrations/` 即得实时名单

## 2. Feedback 页

- 入口:Settings 新增 Feedback 区块(多行文本 + 提交按钮)
- 自动附带:App 版本、userId、显示名、平台、最近 10 条 error_log 摘要(时间/severity/scope/message,不含 details 大字段)
- 双写:Lark 群卡片 + Wasabi `feedback/<ISO时间>-<userId>.json`
- webhook URL 取自 remote config;未配置时区块显示「未启用」
- 发送失败提示重试,不做本地队列

## 3. 定向更新通知

- Wasabi 公开读对象 `announcements.json`:

```json
[{
  "id": "2026-07-05-upgrade-1117",
  "title": "请升级到 v1.11.7",
  "body": "修复升级丢包……",
  "to": ["adrianchong"],
  "minVersion": null,
  "maxVersion": "1.11.6"
}]
```

- 过滤规则(纯函数):`to` 缺省=全员,否则精确匹配 userId(大小写不敏感);min/maxVersion 与当前版本 semver 比较,叠加生效;已读 id(SQLite)排除
- 展示:弹窗对话框,多条未读合并列表,确认后记已读
- 发布 = 作者上传新 announcements.json(不发版、不 push git)

## 4. Wasabi 桶与密钥

- 桶结构:`registrations/`、`feedback/`(私有,App 只写)+ `announcements.json`(公开读)
- App 内嵌**仅 PutObject** 的 IAM 密钥(编译期经 GitHub Actions secret 注入,不进任何 git 仓库):最坏泄露后果 = 被灌垃圾对象,无法读/删/改已有数据
- 作者持完整密钥(读取名单、feedback、上传公告)
- Rust 端用 SigV4 直接 HTTP PUT(避免引入完整 AWS SDK 依赖,Wasabi 兼容 S3 API)

## 5. DeepSeek 参与(Phase 4,角色待定)

- 已验证 key 可用(deepseek-v4-flash / v4-pro)
- 约束:不进 App(密钥嵌入问题);在作者侧运行
- 候选:feedback 自动分诊打标 → Lark 摘要;周期性错误聚类报告
- 具体形态在 Phase 4 开始前再定

## 测试策略

沿用仓库惯例(node --test + Rust 单测):
- 纯函数直测:通知过滤(to/版本区间/已读)、卡片/对象组装、error_log 摘要截取
- Rust 单测:OS 用户名读取、SigV4 签名
- UI 接线:源码级断言(RequestPanel 先例)

## 实施阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 身份:OS 用户名 command + Settings 显示名 | 无 |
| P1 | Lark:webhook 入 config、Feedback 页、注册卡 | P0 |
| P2 | 通知:announcements 过滤 + 弹窗 + 已读 | P0(P2 可先从 git config 读,Wasabi 就绪后切换) |
| P3 | Wasabi:SigV4 PUT、registrations/feedback 存档、announcements 迁移 | 桶+密钥就绪 |
| P4 | DeepSeek 分诊(作者侧) | P3 |

每阶段独立可发版。P1 完成即闭环「自动知道问题」的最小可用版本。
