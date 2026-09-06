# Penguin 功能全览（v1.16.0）

> 依据：`main` 分支当前工作树源码（含未提交改动），2026-09-04 整理。README / OVERVIEW.md 停留在 v1.4 时代，本文以代码为准。
>
> 状态标记：
> - ✅ 已实现且可从 UI / CLI / MCP 使用
> - 🔒 有权限门（Dev Mode / admin / super-admin）
> - 🧪 实验性
> - 🚧 代码已实现但**未接入 UI**（组件存在、无处挂载）
> - ❌ 未实现（仅有依赖 / 预留 schema / 规划文档）

---

## 目录

1. [Penguin 是什么](#1-penguin-是什么)
2. [应用外壳（所有模块共用）](#2-应用外壳所有模块共用)
3. [API Client 模块（gRPC / gRPC-Web / JS-SDK）](#3-api-client-模块grpc--grpc-web--js-sdk)
4. [REST 模块](#4-rest-模块)
5. [Vault 模块（凭据管理）](#5-vault-模块凭据管理)
6. [Docs 模块（接口知识库）](#6-docs-模块接口知识库)
7. [Wiki / Penguin Knowledge 模块（代码知识图谱）](#7-wiki--penguin-knowledge-模块代码知识图谱)
8. [AI Agent 集成：penguin CLI 与 penguin-mcp](#8-ai-agent-集成penguin-cli-与-penguin-mcp)
9. [Runtime 与 Extras](#9-runtime-与-extras)
10. [数据存放位置总表](#10-数据存放位置总表)
11. [快捷键总表](#11-快捷键总表)
12. [发布、更新与 CI](#12-发布更新与-ci)
13. [已实现未接入 / 未实现 / 规划中](#13-已实现未接入--未实现--规划中)
14. [相关文档索引](#14-相关文档索引)

---

## 1. Penguin 是什么

Penguin 是一款 macOS 桌面应用（Tauri 2 + React 19 + Rust），面向使用 Protocol Buffers 和 `@snsoft/*` npm 包的团队。它从「gRPC 版 Postman」出发，现在是一个多模块工作台：

| 模块 | 一句话 | 入口 | 权限门 |
|---|---|---|---|
| **API Client**（默认） | 测试 gRPC / gRPC-Web / JS-SDK 接口，内置包管理与环境切换 | 左侧模块栏 | 无 |
| **REST** | Postman 风格 HTTP 客户端：项目 / 环境 / 集合 / 请求 / Cookie / 鉴权 | 左侧模块栏 | 无 |
| **Vault** | 团队凭据管理（各环境的 URL / Token / 账号），与飞书文档同步 | 左侧模块栏 | 🔒 Dev Mode + 有效 token |
| **Docs** | 手写接口知识库（标题 / 方法 / 路径 / 头 / 请求体 / 响应体），与飞书同步 | 左侧模块栏 | 🔒 Dev Mode + super-admin |
| **Wiki** | 本地代码知识图谱（Penguin Knowledge）：索引仓库、图谱、语义检索、存储管理 | 左侧模块栏 | 🔒 Dev Mode + super-admin |
| **Extras** | 实验性子模块启动器，目前只有 Live Wallpaper | 顶栏企鹅图标 | 无（macOS only） |
| **Runtime** | 防休眠（caffeinate）+ 知识运行时供给 | 状态栏 ☕ | 无 |
| **penguin CLI / penguin-mcp** | 给 Claude Code / Claude Desktop / Codex 用的命令行与 MCP 服务器 | 应用自动安装 | 无 |

技术栈：React 19 / TypeScript 5 / Vite 6 / Tailwind 4 / Zustand 5 / CodeMirror 6 / ConnectRPC；Rust 侧 Tauri 2 + rusqlite + reqwest(rustls, h2) + tokio；知识引擎为 TypeScript monorepo（`packages/knowledge-*`、`packages/mcp`、`packages/api-doc-generator`），运行在 vendored Node 22 上，tree-sitter WASM 解析。

**Dev Mode 解锁方式**：按住 ⌘ + G 3 秒弹出 Developer Mode 弹窗，输入 token（SHA-256 与内置哈希表比对，分 admin / super-admin 两级），token 持久化到本地，重启不再询问。这是 Vault / Docs / Wiki 三个模块的前置条件。

---

## 2. 应用外壳（所有模块共用）

### 2.1 启动与布局
- 启动即从 SQLite `app_kv` 表整体载入状态（阻塞式，保证 store 同步读到持久化值），随后恢复防休眠策略、挂接错误日志 sink。
- Rust 侧启动：迁移旧目录 `~/.pengvi` → `~/.penguin`；从登录 shell 抓取用户 PATH（保证 npm / node / lark-cli 可找到）；WAL checkpoint；启动 `~/.penguin` 文件监听（包变更即刷新 UI）；同步知识运行时、安装 `penguin` CLI 到 `~/.local/bin`、刷新 `~/.penguin/mcp/`、自动开启 watch。
- 布局：Header → 更新提示 → Toast → [模块栏 | 模块内容] → StatusBar。当前模块持久化（`penguin-active-module`），Reload 后回到原模块。

### 2.2 Header
- 企鹅吉祥物按钮 → 打开 Extras。
- 轮播问候语（Manglish / 中文，含国庆日、发薪日、深夜、周五特供）+ 12 小时制时钟，12:30–12:45 弹「去 makan」提醒。
- API Client 模块下：协议徽标、环境下拉、**Sync Environment Config** 按钮（拉远程配置）。
- 主题调色盘弹层、Settings 齿轮（有更新时显示红点）。

### 2.3 StatusBar（所有模块可见）
在线 / 离线圆点 · Shortcuts 按钮 · 错误日志按钮（未读徽标）· 硬刷新（先关闭内嵌 webview 再 reload）· Settings · ☕ Prevent Sleep · 版本号。

### 2.4 主题（8 套）
`dark` / `light` / `penguin`（1.15.0 起默认）/ `duck` / `cat` / `black-cat` / `hamster` / `rabbit`。后五套各带整套吉祥物贴图。通过 `data-theme` 切换，持久化 `penguin-theme`。**没有 i18n 框架**：文案硬编码，多数为中英双语并列；没有语言 / 字号设置。

### 2.5 Settings 弹窗（按顺序）
1. **Display Name** 显示名。
2. **App Updates**：当前版本、检查更新、下载安装（进度条）、重启；「自动检查更新」开关（默认关）。
3. **Package Registry**：Nexus/Sonatype 地址 + 账号密码 → 写入全局 `~/.npmrc`（`_auth` + `@snsoft:` / `@snsoft-dev:` scope），并镜像到三个协议目录。把整条 `npm config set //host:_auth=...` 命令粘进 URL 框会自动拆成三个字段。
4. **MCP Integration**：状态徽标（Configuration Present / Manual Setup / Server Check Failed / Runtime Outdated 等）、配置写入状态、launcher 健康、本地 `initialize` 探针；一键 **Configure MCP Clients**；可复制的 JSON `mcpServers` 片段、`claude mcp add ...`、`codex mcp add ...` 命令。语义检索控制不在此处，在 Wiki → Graph。
5. **Default Transport**：新 gRPC-Web 标签页默认 GRPC-WEB（旧服务）还是 CONNECT（新服务）。
6. **Max History Size**：100 / 200 / 500 / 1000。
7. **Export / Import Config**：导出环境、激活环境、默认请求头、默认传输、历史上限、主题、用户名；**不含**历史记录与已保存请求。
8. **Manage Environments**：跳转环境管理器。
9. **Clear Cache**：清空三个协议目录的 `node_modules` + lock，并重置标签页。
10. **Default Headers**：按协议（gRPC-Web / gRPC / JS-SDK）维护默认请求头；出厂值 `Authorization: Bearer `、`eId`、`x-env-tag`、`platform-id`（REST 另加 `Content-Type: application/json`）。

### 2.6 更新机制
Tauri updater，端点 `https://github.com/shiengng12345/penguin/releases/latest/download/latest.json`，minisign 签名校验。开启自动检查后：启动 5 秒后、每约 6 小时、窗口获焦时检查；Toast 提供「稍后 / 更新」，忽略按版本记忆。开发模式下完全关闭。
**ReleaseWelcomeDialog**：每个新版本首次启动弹一次，自动刷新 MCP 运行时并报告结果，可勾选开启自动更新检查，可直达 MCP 设置卡片。

### 2.7 引导
- **Welcome**：用户名为空时全屏询问。
- **InteractiveTutorial**：约 20 步交互式引导（安装示例包、⌘S / ⌘E / ⌘F / ⌘H / ⌘O / ⌘D / ⌘I / ⌘⇧I / ⌘N / ⌘R 全部实操一遍）。

### 2.8 错误日志
前端 warn/error、`window.onerror`、未处理 Promise 以及 Rust 侧错误统一写入 SQLite `error_log`（上限 1000 行）。弹窗支持 fe/be、error/warn 筛选，Fuse.js 模糊搜索，分页，多选后复制为 JSON / Markdown，一键清空。React 崩溃由 ErrorBoundary 兜底。

---

## 3. API Client 模块（gRPC / gRPC-Web / JS-SDK）

### 3.1 协议与传输
| 协议 | 通道 | 说明 |
|---|---|---|
| **gRPC-Web** | ConnectRPC → Rust `http_proxy`（reqwest） | 绕过 CORS；单标签页可在 **GRPC-WEB ↔ CONNECT** 传输间切换；响应上限 25 MB，超时 60 s，可中止 |
| **gRPC（原生）** | Node sidecar（`@grpc/grpc-js` + `proto-loader`，首次使用自动装进 `~/.penguin/grpc`） | HTTP/2；中止请求即杀 node 进程 |
| **JS-SDK** | Node sidecar 加载 `@snsoft/js-sdk` bundle | 动态解析 `.d.ts` |

Node 路径通过登录 shell 解析一次并缓存（兼容 nvm / volta / fnm / Homebrew）。

### 3.2 标签页与请求模型
- 每个标签页独立：协议、传输、URL、服务路径覆盖、方法、请求头、请求体、响应、来源（history / saved）。
- 标签页持久化（响应体只存前 64 KB，恢复后提示「完整响应见 History」）。
- 拖拽排序、中键关闭、右键菜单（复制 / 关闭 / 关闭其他 / 关闭右侧 / 全部关闭），关闭 ≥3 个时确认。
- 新建请求弹窗三选一：gRPC-Web / gRPC / JS-SDK。⌘E 循环切换协议，若目标协议有同名方法则自动带过去。

### 3.3 URL 栏
支持 `{{VAR}}` 环境变量；gRPC-Web / SDK 自动补 `https://`；可手动覆盖服务路径（琥珀色高亮 + 重置）；显示 `fullName (Request → Response)`；gRPC-Web 标签页有传输切换按钮。

### 3.4 请求面板
- 请求头表格（启用勾选 / key / value / 删除）。
- 请求体：CodeMirror JSON 编辑器（补全、lint、格式化、按 proto 字段重置默认体、复制）。
- 操作栏：Send / Cancel(Esc) / Save(⌘⇧S) / **Copy as cURL** / View Proto(⌘P) / Request as Doc(⌘D)。
- 发送规则：配置未同步完成或离线时禁止发送；只发送本标签页的请求头（Settings 默认头只用于新标签页初始化）；未能解析的 `{{模板}}` 头会被丢弃并记录；空 `Authorization` 丢弃；每次发送生成 `x-penguin-id: penguin-<uuidv7>` 关联 ID 并回显在响应头中；历史记录在调用前先落库、响应到达后补全。

### 3.5 响应面板
- 状态徽标 + 耗时；16 个 gRPC 状态码的中文解释 / 建议 / 是否可重试。
- 请求头默认精简显示（`x-penguin-http-status`、`x-penguin-http-version`、`x-penguin-id`），可展开全部；点击值即复制。
- 响应体：语法高亮 JSON、嵌套 JSON 字符串自动展开、`_` 前缀字段隐藏、>2 KB 字串折叠、非 JSON 上限 256 KB；>500 行启用虚拟滚动。
- **响应内查找**：高亮命中、`n/total` 计数、Enter / Shift+Enter 跳转、Esc 关闭。
- **ProtoViewer（⌘P）**：请求 / 响应类型渲染为可点击跳转的伪 proto。
- **RequestDocDialog（⌘D）**：生成可分享的接口文档（信息 / URL / 头 / 请求 schema / 请求体 / 响应 schema / 响应），可复制文本或 **复制为 PNG**。

### 3.6 包管理（`@snsoft/*`）
- 存放：`~/.penguin/{grpc-web,grpc,sdk}/`，各自是独立 npm 项目；`~/.npmrc` 会镜像到每个目录。
- 侧栏 **Packages**：包 → 服务 → 方法树，自动展开定位当前方法；每个包可就地输入版本升级、可卸载；**Collections** 页显示已保存请求。
- **Package Installer（⌘S）**：类型筛选（全部 / gRPC / gRPC-Web / JS-SDK）、包名搜索、产品线多选、分支筛选 + 「仅 master」、结果行显示版本 / 构建时间 / 分支 / 已安装徽标；多选批量安装带进度；手动输入 spec（`@snsoft/x-grpc-web@version`）；实时安装日志；admin 以上可开 5 秒自动刷新。
- 安装机制：仅允许 `@snsoft` 作用域；`npm install --save --prefer-online ...`，5 分钟超时；遇到 `ETARGET`（发布竞态）30 s / 60 s 重试两次；失败给出「常见原因」清单。
- **注册表发现**：凭据不进 webview，由 Rust 读 `~/.npmrc` 直连 Nexus / Sonatype；内置 21 个客户端产品线白名单快速路径 + ETag 缓存，结果流式推送 UI；回退到 Nexus 组件搜索 / npm search。应用启动预热并每 5 分钟刷新。

### 3.7 环境与配置
- 每协议（grpc-web / grpc / sdk / rest）独立环境集合，`{id, name, color, variables}`，8 种颜色。
- **本地配置加载顺序**（首个命中即用）：`~/.penguin/config.json` → `~/.penguin.config.json` → `~/.pengvi.config.json` → 应用资源目录 → 当前目录 → 可执行文件目录。
- **远程团队配置（只拉不推）**：`https://raw.githubusercontent.com/shiengng12345/penguin/main/config/penguin.remote-config.json`，按协议给出 environments + packages；合并规则：新名字新增、相同跳过、冲突时**本地优先**并列出冲突。
- **EnvManager**：分协议页签、拉最新配置、增删改环境（新环境预置 `URL` + `TOKEN`）。
- **cURL 导入（⌘⇧I）**：解析 `-X / -H / -d`，根据 host 推断环境名（QAT1 / UAT / LOCAL / STAGING / PROD…），可一键创建环境（URL + TOKEN）并把 URL / 头 / 体应用到当前标签页。

### 3.8 历史、保存、搜索
- **History（⌘H）**：SQLite `request_history`，含完整响应；每页 50、SQL 侧搜索（方法 / 服务 / 包 / URL）；↑↓ + Enter 恢复到新标签页；达到上限自动裁剪。
- **Saved（⌘O / ⌘⇧S）**：SQLite `saved_requests`；就地重命名、删除、预览、搜索、恢复。
- **CommandSearch（⌘F）**：跨三协议所有已装包模糊搜索（支持 `*` 通配），协议筛选循环；选中后载入当前空标签页或新开标签页并在侧栏定位。
- **NetworkCheck（⌘I）**：网络诊断 + 测速。

---

## 4. REST 模块

Postman 风格 HTTP 客户端，与 API Client 完全独立的数据与 UI。

### 4.1 层级
**Projects → Environments → Collections → Requests**。全部就地新建 / 重命名 / 删除；删除项目级联删除环境、集合、请求、变量并清空对应 Cookie；删除环境只解绑集合。当前是**单活动请求**（无多标签工作区）。

### 4.2 请求编辑器
- 方法：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS。
- 布局：左侧堆叠 Headers / Authorization / Body，右侧响应，50/50。
- Body 模式：**JSON**（CodeMirror，格式化 / 重置）、**键值对**（string / number / boolean / null / object / array 类型化行，发送时序列化为 JSON）、**Raw**、**Binary**（hex / base64 / utf8，可发 gRPC-Web 帧）、**None**。
- `{{VAR}}` 插值作用于 URL、请求头、查询参数、请求体。
- 把 `curl ...` 粘进 URL 栏即整体导入（提示 `Imported curl · N headers · body · auth`）。
- **Copy curl**：生成含真实凭据的可运行命令。
- 每次发送自动加 `x-penguin-id`。

### 4.3 鉴权与密钥
- 四种：No Auth / **Bearer** / **Basic** / **API Key**（header 或 query）。
- 密钥模型采用 Postman 式**本地明文**：存于 `~/.penguin/penguin.sqlite3` 的 `app_kv` 表（键前缀 `rest:secret:`）。曾用 OS Keychain（`keyring`）但 macOS 反复弹密码框，已回退。前端只拿到掩码句柄（`••••后四位`），发送时由 Rust 注入，只允许注入到 header / query。

### 4.4 发送与限制
默认超时 30 s；跟随重定向最多 10 次或关闭；响应体上限 100 MB（超出标记 truncated）；非 UTF-8 响应 base64 包装；未手填 Content-Type 时 JSON 模式默认 `application/json`。

### 4.5 Cookie Jar
按 **Collection** 隔离，落 SQLite `rest_cookies`。请求无显式 `Cookie` 头时自动按 host + path 附带；响应 `Set-Cookie`（Domain / Path / Expires / Max-Age）自动入库；过期 Cookie 列表时过滤但不删除。🚧 Cookie 管理面板组件已写好但未挂载，目前无 UI 查看 / 编辑。

### 4.6 历史与导入
- **History（⌘H）**：最近 200 条（`app_kv` 键 `penguin-rest-history`），带完整重放快照；若鉴权句柄失效则清除并给出提示；可单删 / 清空。
- **cURL 导入弹窗（⌘⇧I）**：实时解析预览，选择或新建目标集合；自动把 `Authorization: Bearer/Basic` 及 `x-api-key` 等常见头提升为鉴权并存为密钥。

### 4.7 响应查看器
JSON 美化（显示上限 1,000,000 字符，可展开全文）；响应内查找；复制；**gRPC-Web / Connect 透镜**：按字段编号展示 protobuf 消息、trailers、hex 兜底，不猜字段名。

### 4.8 存储
前端状态以 JSON blob 存在 `app_kv`（`penguin-rest-projects / -environments / -collections / -requests / -env-vars / -history`）；专用表 `rest_collections / rest_requests / rest_env_vars` 已建但**尚未写入**（迁移为后续工作）。

---

## 5. Vault 模块（凭据管理）

🔒 Dev Mode + 有效 token。「Vault」是团队凭据管理器，**不是** HashiCorp Vault（`vault` 只是其中一种凭据类型）。未验证 token 时显示锁屏卡片，引导去 Settings 验证。

### 5.1 数据模型
- **Project** → `environments[]`（QAT / UAT / PROD / SANDBOX / 自定义，各带颜色）+ `credentials[]` + `kinds[]`。
- **Credential**：kind、name、`valueByEnv`（各环境一个值）、isSensitive、`pairedWith`（配对成一张多字段卡）、isFavorite。ID 是名字的确定性 slug，保证推送到飞书的 Markdown 稳定。
- **Kinds 是用户数据**：可增删改、拖拽排序（super-admin）；内置 12 种带品牌图标：vault、database、cache、link、token、argocd、monitoring、web、api、login、generic、totp。

### 5.2 编辑与浏览
- 新增走**模板选择**（Vault Server / Service with Auth / Link / Database / Cache / Custom…），一个模板一次生成多条凭据并自动配对。
- 三栏：项目侧栏 | 类型栏（可拖宽 140–320px）| 凭据卡片。
- All / Favorites 页签；搜索支持 `*` `?` 通配或字符子序列模糊匹配并高亮。
- 点值即复制（光标处浮出 copied）；URL 型值可在浏览器打开；卡片颜色按名称哈希稳定；拖拽排序；**Copy JSON** 导出整库；删除后 5 秒内可撤销。

### 5.3 飞书（Lark）同步
- 接受 `https://*.larksuite.com/...` 或 `*.feishu.cn/...` 文档地址，也可输入口令（如 `PENGUIN`）解析到真实地址。
- **Pull**：通过 `lark-cli` 拉取文档中的 ```json``` 块，校验后落库（30 s 超时）。
- **Push**（super-admin）：先拉远端算 SHA-256 与上次同步哈希比对，不一致则**中止并返回冲突**（附远端内容），一致才 `lark-cli +update` 覆盖并记录新哈希。
- **Diff**：按凭据 ID 的结构化差异（新增 / 修改 / 删除 / 项目变更）。
- ⚠️ 加密：AES-256-GCM + HKDF 双收件人（admin / super-admin）信封加密已实现，但**当前推送走明文 Markdown**，代码注释注明是临时取舍。

### 5.4 内嵌 Webview（🚧 未接入）
Rust 侧完整实现原生子 webview：独立进程、按 `dataKey` 隔离的 cookie / storage（`~/.penguin/inline-webview-data/{key}`，QAT / UAT 同域不串登录）、缩放 0.5–1.5、前进 / 后退 / 刷新 / 跳转 / 执行 JS（用于自动填 Vault Token）。前端面板与工具栏组件存在但**没有页面挂载**，目前用户看不到内嵌 Vault UI / ArgoCD。`totp` 类型也没有对应的验证器 UI。

---

## 6. Docs 模块（接口知识库）

🔒 Dev Mode + super-admin。一个「只存不发」的接口文档库，不发请求。

- **Collections** 增删改（删除有确认）。
- **Endpoint 编辑器**七段式：① 标题 ② 方法 ③ 路径 ④ 描述 ⑤ Headers（key / value / description 表格）⑥ Request Body（CodeMirror）⑦ Response Body。
- 方法集合比 REST 更宽：GET / POST / PUT / PATCH / DELETE / **GRPC / GRPC-WEB / SDK**。
- **从 curl 导入**自动填方法 / 路径 / 体 / 鉴权。
- 阅读视图：方法徽标 + Headers / Request / Response 三卡各带复制。
- **飞书 Pull / Push**（Push 需 super-admin，覆盖远端）。
- 存储：`app_kv` 键 `penguin-docs-knowledge-base` 等。

> 另有一套**基于证据的 API 文档生成器**（`packages/api-doc-generator`），只通过 CLI / MCP 使用，见 §8.1「api-doc」。它从知识图谱事实推导请求类 / 响应矩阵，输出带覆盖等级（exhaustive / bounded / observed / partial）的 Markdown 预览，可绑定并同步到飞书文档的受管区块。桌面 Docs 页**不消费**它。

---

## 7. Wiki / Penguin Knowledge 模块（代码知识图谱）

🔒 Dev Mode + super-admin。一个**本地、按修订版本（revision）追踪**的代码知识系统：确定性的源码 / 路径搜索是权威，图谱、笔记、证据、记忆和可选的语义检索只做补充。数据在 `~/.penguin/knowledge/`。Schema 版本 **v18**。

### 7.1 桌面 Wiki UI（当前挂载的部分）

**首次引导（WikiOnboarding）**
- 原生文件夹选择器选仓库 → 启动全量索引任务（**分离子进程，关掉 Penguin 也继续跑**），1 秒轮询进度（百分比、done/total、当前文件）。
- 一键 AI 集成：`penguin` CLI 加入 PATH（写 zshrc / bashrc / fish）；MCP 写入 Claude Desktop / Claude Code / Codex（未安装的客户端跳过并如实报告）；写入全局 `CLAUDE.md` / `AGENTS.md` 指引块。
- Claude Code hooks 可选（默认勾选）：`SessionStart` 紧凑状态、`UserPromptSubmit` 有界上下文；取消勾选即移除 Penguin 自己的 hook；检测到第三方上下文注入 hook（如 codegraph）会警告重复耗 token，但**绝不删除第三方 hook**。Codex 只走 MCP + AGENTS.md。

**Graph 页签**
- 三种布局：**整洁（径向）**、**力导向**、**3D**（three.js），均按需加载。
- 三种范围：**Service map**（跨服务 gRPC 调用 + 包依赖）、**Repo graph**（单分支高连接度符号）、**Local graph**（聚焦符号 1 跳邻域）。
- Obsidian 式交互：节点大小按度、缩放显标签、悬停高亮邻居、自动适配视口。
- 边类型着色：calls / references / imports / defines / tests / handles / invokes / throws / uses。
- 统计浮层：按节点类型过滤（偏好持久化）、≤40 节点时可逐个勾选。
- 点服务节点若该仓库有多条活分支 → 弹分支选择器（不猜分支）。返回轨迹。

**关系栏（WikiContextPane）**
- 跨服务卡片（调用远程 gRPC 服务 / 被其他服务调用）、被调用 / 调用、React 渲染关系、回调动态调用、测试覆盖、被哪些文件 import；每卡最多 14 条可点击。
- **ScopeBadge**：`repo@branch sha7 (worktreeState)`，绿点 = 精确命中请求范围，琥珀 = 回退并说明原因。
- **ScopeBlockerPanel**：`BRANCH_NOT_INDEXED` 时列出候选已索引分支并提供「改用 X 分支回答」一键重试；`SCOPE_NOT_FOUND` 不提供重试。

**Storage 页签（30 秒轮询）**
- 总大小 + 健康灯（WAL 比例 / 增长过快 / 可回收空间）、周增量；主库 / WAL / SHM 组成。
- 语义向量独立统计：是否可查询、后端、就绪 / 期望 chunk、待处理 / 失败任务、活跃 / 暂存代次、向量磁盘占用；**只有完整校验通过的向量代次才会切换为可查询**。
- 「大头在哪」按需分析：graph_edges / source_content（去重后）/ fts / vectors / symbols / other。
- 回收状态：上次 GC、每仓热快照上限、Trigram 加速通道开关（关掉省约 1 GB）、上次 vacuum。
- 每仓明细表；操作：**立即回收**、**压实数据库**；被拒绝时给出原因（索引中 / 维护中 / 有活跃读者）。UI 内**没有**「重置索引」按钮。

**状态页脚**：DB 可用性、schema 过期（提示 `penguin index`）、修订对齐（Aligned / Behind / Branch not indexed / Git unavailable）、大小芯片。

**索引进度横幅**、**全量索引任务面板**（阶段：代码索引 → 完整重建 → 语义队列 → 校验收尾；暂停 / 继续 / 取消 / 重试失败分片；关闭 Penguin 不中断）、**语义 Worker 面板**（每仓状态、吞吐、ETA、模型、后端；Pause / Resume / Retry / Cancel generation；`MODEL_IDENTITY_MISMATCH` 时 fail-closed）。

### 7.2 🚧 已实现但未挂载的 Wiki 页面
`WikiSearchPage`（多模式搜索 + 过滤器 + 保存查询 + `vscode://` 跳转 + 导出 Obsidian `.canvas`）、`KnowledgeHomePanel`（仓库 / 分支表：watch 开关、全部同步、设主分支、pin、删索引）、`WikiBrowseTree`、`WikiWhyPanel` + `WikiNoteEditor`（`[[` 与 `#` 自动补全）、`EvidenceInbox`（SLS 证据收件箱）、`WikiTimelinePane`、`WikiFlowPane`。这些能力目前只能通过 CLI / MCP 使用。

### 7.3 索引什么
- **语言**（tree-sitter WASM）：TypeScript / TSX / JavaScript / Rust / Go / Java / PHP / Python / C / C++ / C# / Ruby / Kotlin / Swift / Bash / HTML / CSS / JSON。YAML 语法包在当前构建下无法加载，`.yml/.yaml` 跳过不报错；proto / SQL 语法未打包（另有手写 proto 解析器抽取 gRPC 服务 / 方法）。
- **框架边**：仅 NestJS（injects / provides / implements / dispatches_to）。没有 Spring 支持。
- **端点**：`@GrpcMethod`（带跨仓全局 ID，供应方与消费方跨 repo 连接）、Kafka 处理器、HTTP（含状态码）。
- **消息通道**：kafka / rabbitmq / sqs / sns / redis / websocket / cron 的生产 / 消费绑定。
- **IaC 事实**：docker stage / service / deployment / ingress / config / secret_ref / terraform_resource / workflow_job / helm_value / port / volume。
- 其它：包依赖（package.json + pnpm-lock）、字段访问、包装函数、Markdown 链接与属性、未链接提及、git 提交图、Obsidian canvas。
- **引用解析**分层：同文件 → 同仓唯一限定名 → import 作用域 → 同仓裸名（唯一 = 提取、多个 = 推断）；有候选数上限与泛用名黑名单防止 `get / find / log` 成假枢纽；未解析引用分类入队列而非丢弃。
- **Git-truth 发现**：以 git 文件清单为准；固定忽略 `node_modules / dist / target / .next / vendor …`；默认单文件 1 MB；识别 minified 与 vendored；`.env* / *.pem / *.key / credentials.json` 归类 secret，**只留路径不留内容**。不变式 `discovered = admitted + excluded + failed`，解析失败不会让文件从语料消失。

### 7.4 修订模型
- 内容哈希去重 + 快照 / 写时复制：分支存 overlay，有效清单继承源事实；每个结果都带 revision 定位与证据状态。
- **工作树覆盖层**：未提交改动作为 `working_tree` 快照索引，不发布为分支正式修订；结果标 `trust: exact_worktree`。
- **保留策略**：每仓热快照 20 个、14 天转冷、已删分支 30 天可恢复、事实 GC 7 天宽限；每次回收记账。
- 运行时兼容：`compatible / not_indexed (INDEX_NOT_READY) / schema_outdated (SCHEMA_OUTDATED)`，**拒绝自动迁移旧 schema**，提示 `penguin index`。

### 7.5 搜索与图查询
- 模式：`auto / exact / phrase / substring / path / regex / lexical / semantic / structural`；通道：`source / path / symbol / graph / note / semantic / vector / evidence`；语义融合 `off / fallback / blend`。
- 确定性命中为 **verified**，带文件 / 行 / 字节偏移；零结果附覆盖与告警，**不是不存在的证明**。游标 HMAC 签名并绑定能力哈希（`CURSOR_INVALID / CURSOR_STALE`）。正则只支持 RE2 子集。
- **图查询 DSL**（`knowledge.graph.query`）：起点 kinds / nodeIds，traverse 方向 / 边类型 / 深度 ≤12 / 状态，limit ≤500；只读、按修订范围、无 SQL / Cypher。
- 能力全表见 `docs/knowledge-v2/capability-matrix.md`（约 100 项，CLI 与 MCP 全部实现），分组：发现、符号关系、路径 / 影响、图、架构、证据、Wiki、记忆、语义、API 文档、运维。

### 7.6 笔记、记忆、本体、Why、证据
- **Notes**：磁盘 Markdown 是事实来源，SQLite 可重建；frontmatter `id/title`；原子写（0600）；`[[wikilink]]` / 锚点 / 嵌入 / `#tag` / `.canvas` 全部解析；标记 sensitive 的笔记不暴露给 MCP。**Obsidian 兼容**：用 Obsidian 编辑或删除笔记后 reindex 即可。外部源：`markdown_directory / url / postgres_schema / openapi`（url / openapi 需显式联网，不隐式抓取）。
- **Memory**：类别 session / project / decision / runbook / incident / preference；保留 ephemeral / normal / indefinite；session 24 小时过期；`forget` 是脱敏不是删除；`improve` 升级为 project 级。
- **Ontology**：术语（actor / capability / entity / state / event / system）+ 别名 + 证据 + 到图节点的链接，状态 draft / reviewed / verified / stale。
- **Why 卡片**：问题 / 答案 / 决策 / 备选与否决原因 / 约束 / 后果 / 证据 / 缺口；状态机 draft → reviewed → verified → stale（+ disputed），非法跳转报错。
- **Suggestions**：AI 提议的边默认不进搜索结果，accept 后才生效。
- **Evidence（阿里云 SLS 日志调查）**：证据包分四桶 codeFacts / wikiFacts / slsFacts / inferences + gaps；捕获内容寻址（重复返回 `duplicate_observed`）；生命周期 draft → reviewed → verified → resolved → archived；doctor / repair / validate。Penguin **自己不查 SLS**，由宿主的 SLS MCP 作为兄弟服务执行查询。
- **Onboarding 生成**：产出带 revisionHash + capabilityHash 的入职 Markdown。

### 7.7 语义检索通道
- 提供方：内置模型 / 本地已验证模型 / transformers.js ONNX（`local_files_only`）；远程提供方需显式确认「源码会离开本机」；默认策略 `pinned-local-only`、禁止运行时下载。
- 选定模型：`nomic-ai/nomic-embed-text-v1.5` int8 ONNX（约 137 MB，768 维，2048 token），资产 SHA-256 锁定。
- 模型身份 = 模型 + tokenizer + chunker 哈希，换模型会报 `MODEL_IDENTITY_MISMATCH` 而不是污染向量。
- 存储：sqlite-vec（有 sqlite 回退）；混合检索按通道给出来源与排名，重排「不是证明」。
- 生命周期 space → generation → job，只有完整校验代次可查；后台 Worker 有租约、暂停、重试、死主回收，日志 `~/.penguin/knowledge/logs/semantic-worker.log`。语义失败时降级到确定性通道并告警，**从不削弱精确通道**。

### 7.8 重置、导出、恢复
- **全量重置**：需确认令牌、先出备份收据、表分三类（保护 / 混合 / 可重建）、可续跑的重置清单。UI 无按钮，走 CLI。
- **Artifact 导出 / 导入**：签名 + 校验和的 zip（可加密），导入前验证；`--into <db> --confirm` 才真正恢复。
- **Ledger**：只追加 `ledger.jsonl`（SHA-256），单写者假设。WAL 被动 checkpoint；用 pid 存活判断崩溃的 indexer。

---

## 8. AI Agent 集成：penguin CLI 与 penguin-mcp

### 8.1 `penguin` CLI
应用每次启动自动写 `~/.local/bin/penguin`（打包版执行 `~/.penguin/runtimes/current/node` + launcher；开发版用 PATH 上的 node）。`penguin --version` 输出 appVersion / buildId / capabilityHash / schemaVersion / modelHash 等运行时身份。

**命令族**
- 索引与仓库：`init [path]`（非 git 目录会进入多仓选择）、`index`、`rebuild`、`watch`、`corpus run|discover|reconcile|status|pause|resume|cancel|retry|reset`、`materialize`、`remove`、`pin`、`master`。
- 状态：`status`、`capabilities`、`coverage`、`doctor`、`snapshots`、`trigram on|off|status`、`semantic status|wake|worker|pause|resume|retry|cancel`。
- 检索与理解：`search`、`explore`（首选，一次给源码 + 流 + 影响 + 测试 + 路由 + 信任）、`locate`、`context`、`node`、`callers` / `calls` / `callees` / `impact`、`flow`、`affected`、`path`、`graph` / `repograph`、`architecture`、`communities`、`deadcode`、`files` / `filesymbols` / `endpoints` / `endpoint-identity`、`package-dependencies` / `dependency-path`、`analyze-repository`、`compare`、`timeline` / `recent`、`explain`（**唯一调用外部 LLM 的命令**，BYOK `--provider/--model/--key`）、`why` / `domain` / `onboarding`、`saved-query`、`memory`、`ontology`。
- 笔记与证据：`note new|append|list|reindex`、`incident new`、`backlinks`、`tags`、`link`、`suggestions` / `accept` / `reject`、`evidence list|status|doctor|repair`、`sample` / `samples`、`artifact export|import`（口令只走 `--passphrase-env` / `--passphrase-fd`）、`source register|sync|list|remove`。
- API 文档：`api-doc generate|list|show|diff|bind|unbind|draft|sync|repair|export`。
- RPC：`penguin call <pkg.Svc.Method> --env <name> [--body '{}'] [--transport connect]`，无需先 `init`。
- 系统：`install`、`hook session-start|user-prompt-submit`、`help`。

**输出与安全**
- `--json` 机器可读，错误统一 `{error:{code,message,retryable,remediation}}`；人类模式附 `scope: repo@branch sha` 页脚与 `warning:` 行；TTY 下实时进度树；`--events-jsonl` 输出进度帧。
- 范围选择：`--repo / --branch / --commit / --snapshot / --allow-fallback`。
- **非交互（管道 / Tauri / CI）默认 fail-closed**：变更类操作先 `--dry-run` 拿 `operationToken`，再 `--confirm=<token>`，否则退出码 6。`PENGUIN_KNOWLEDGE_TRUSTED_BACKGROUND=1` 只放行 init / index / rebuild / corpus run。
- 常驻查询服务：`worker_threads` 池，帧协议版本 1，支持取消；语义模型常驻复用。

**Claude Code hooks（`penguin hook`）**
- 写入 `~/.claude/settings.json` 的 `SessionStart` 与 `UserPromptSubmit`，标记 `--managed-by=penguin`。
- 默认紧凑：关系 + 签名 + `file:line`，≤2 KB，由 agent 自行 `knowledge_explore` 取源码；`--full` 给完整源码块。
- 每会话去重（`~/.penguin/knowledge/hook-sessions/`，24 小时 TTL，最多 128 目标）；hook 只允许 `status` / `explore` 两个只读查询；无索引时打印一行提示并退出 0，**永不阻塞 agent**。

### 8.2 `penguin-mcp` MCP 服务器
stdio 传输，客户端看到的命名空间为 `penguin`。`initialize` 的 `instructions` 携带 `{contractVersion:"2", schemaVersion:18, capabilityHash, modelHash, sessionId, clientConnectedAt}`。

**工具分层**（`tools/list` 按发现顺序）
- Tier 0：`knowledge_explore`。
- Tier 1：`knowledge_search`、`knowledge_get_hit`、`get_node`、`knowledge_file_symbols`、`knowledge_files`、`get_architecture`、`index_status`、`knowledge_semantic_status`；变更类 `knowledge_semantic_control`、`knowledge_repository_register`、`knowledge_index`、`knowledge_rebuild`。
- Tier 2（只读单关系）：`knowledge_callers / callees / impact / affected / flow / path / locate / context / explain / coverage / endpoints`。
- Tier 3（专项）：`explore_graph`（who_calls / calls_of / impact / backlinks / path / timeline / recent_changes / **who_injects**）、`knowledge_service_graph / local_graph / repository_graph / graph_query`、`find_dead_code`、`find_communities`、`analyze_repository`、`package_dependencies`、`dependency_path`、`compare_branches`、快照 / 来源 / 记忆 / 本体 / 标签 / 笔记 / 反链 / Why / 保存查询 的读取工具、`knowledge_domain_explain`、`knowledge_onboarding_generate`、`knowledge_artifact_export`、`knowledge_api_doc_export`、`status_panel`、`knowledge_doctor`。
- Tier 4（写 / 文档 / 维护）：`write_note`、`suggest_links` / `list_suggestions` / `accept_suggestion` / `reject_suggestion`、`api_doc_generate / list / show / diff`、`set_master_branch`、`knowledge_capabilities`。
- 证据 / SLS：`list_sls_targets`、`plan_log_investigation`、`capture_log_investigation`、`list_evidence_notes`、`set_evidence_status`、`evidence_doctor`、`repair_evidence`。
- 包 / 环境 / 请求（与桌面共享 `~/.penguin` 与 SQLite）：`mcp_health`、`list_packages`、`install_package`、`uninstall_package`、`package_status`、`search_methods`、`list_methods`、`describe_method`、`describe_service`、`list_environments`、`resolve_environment`、`get_default_headers`、`list_saved_requests`、`search_request_history`、**`call_method`**（真实发起 RPC，自动补 `x-penguin-id`）、**`compare_environments`**（同一 RPC 跨多环境并排）。

**安全模型**
- 所有 `knowledge.*` 变更能力默认**关闭**：需 `PENGUIN_MCP_MUTATIONS=enabled` + `PENGUIN_MCP_CONFIRMATION_SECRET`，再以 HMAC-SHA256 的 `confirmation_token`（绑定能力 + 范围 + 输入摘要，5 分钟有效）调用；索引类还需 `confirmed: true` 与 owner 本地路径校验。
- ⚠️ `call_method`、`compare_environments`、`install_package`、`uninstall_package` 有真实副作用但**不在**上述令牌保护内，靠客户端自身审批（Codex 配置只自动放行 `readOnlyHint` 工具）。
- 统一类型化错误边界；`isError` 时完整错误 JSON 进文本块。
- **代次监视 / fail-closed 更新传播**：应用升级后旧 stdio 服务器会通过 `~/.penguin/mcp/manifest.json` 感知到新 buildId，结果里附 `{code:"OUTDATED_RUNTIME", action:"restart_mcp_session"}`，由客户端负责重启；没有 manifest 的服务器永不误报。
- 连接后**自动唤醒语义 Worker**（`penguin semantic wake`），纯 MCP 用户不开 Penguin 也能有向量索引。
- 查询走有界 worker 池：`PENGUIN_MCP_QUERY_WORKERS`（默认 2）、队列 16、超时 30 s。

### 8.3 桌面端 MCP 管理
- **自动配置的客户端只有三个，且按本机检测**：Claude Desktop（`~/Library/Application Support/Claude/`）、Claude Code（`~/.claude.json` 或 `~/.claude/`）、Codex CLI（`~/.codex/`）。未安装的跳过并列在 `skippedClients`。Cursor / Windsurf / Gemini CLI 等需手动用 Settings 里的片段配置。
- 客户端配置指向**稳定 launcher** `~/.penguin/bin/penguin-mcp`（从不指向 .app 内部路径，避免 DMG / 迁移后失效）。JSON / TOML 合并写入，保留其它条目；旧 `pengvi` 条目只在确认归属时迁移。
- Codex 额外写入 `default_tools_approval_mode = "writes"` 并对所有只读工具设 `approve`。
- 健康检查两段式：`mcp_status` 快（解析配置）；`mcp_server_health` 真跑一次 `initialize → mcp_health → tools/list`（≤1.5 s），要求 `serverInfo.name == "penguin-mcp"` 且只读工具含 `knowledge_capabilities` 与 `knowledge_context`，否则视为失败并**中止写配置**。
- 应用启动时执行与手动按钮相同的客户端刷新（原子写 + 全局锁）。

### 8.4 质量 / 运维脚本（`pnpm knowledge:*`）
`doctor`、`package-smoke`、`release-gate`、`release-bundle:gate`（只读 .app 资源做干净安装验证）、`capability:gate` / `capability:closure`、各轮次 acceptance gate、`semantic:acceptance` / `semantic:performance-gate`、`parity`（能力清单 vs CLI vs MCP）、`mcp:parity`、`benchmark*`、`real-questions`、`differential`、`model-bakeoff`、`coverage-audit`、`canary`、`baseline`、`rc:audit`、`sbom`、`docs:generate` / `docs:check`、`rollout:backup`、`bundle`。

---

## 9. Runtime 与 Extras

### 9.1 Prevent Sleep（状态栏 ☕）
开关 + 两种策略：「Never（手动开）」/「Automatically when Penguin starts」（默认）。macOS 用 `caffeinate -d -i -w <penguin-pid>`，进程崩溃自动释放；非 macOS 明确返回不支持。引用计数多来源（Flow / Backend / Ai / Docker / Manual），实际只有手动来源在用；状态跳变弹 Toast。

### 9.2 知识运行时供给（后台，无 UI）
`~/.penguin/runtimes/<buildId>/` 不可变代次：暂存 → 文件树 SHA-256 校验 → 实际探测 CLI 与 MCP 入口 → `.ready` → 原子切换 `current` 符号链接；支持切换与回滚；失败不影响当前代次。manifest 记录 buildId / appVersion / capabilityHash / modelHash / contractSchemaVersion 18 / node 与 wasm 路径 / 签名状态。

### 9.3 Extras → Live Wallpaper（🧪 macOS only）
顶栏企鹅图标进入 Extras 全页；瓷贴显示实验标记、平台、运行状态点。Live Wallpaper：开关 + 状态（Running / Error / Off）；实现为隐藏、无边框、不接鼠标的 Tauri 窗口，置于桌面图标层之下、静态壁纸之上，跨所有 Space，只覆盖主显示器，加载内置动画场景。多显示器、自定义视频 / 网页源、遮挡 / 电池暂停为后续。

---

## 10. 数据存放位置总表

| 路径 | 内容 |
|---|---|
| `~/.penguin/penguin.sqlite3` | 主库（WAL）：`app_kv`（几乎全部 UI 状态 + REST 密钥）、`saved_requests`、`request_history`、`rest_cookies`、`error_log`（1000 行上限）、预留 `rest_collections / rest_requests / rest_env_vars` |
| `~/.penguin/{grpc-web,grpc,sdk}/` | 各协议 npm 项目（`package.json`、`node_modules`、`.npm-cache`），升级应用不丢包 |
| `~/.npmrc` | 注册表凭据（由 Settings 写入并镜像到上面三目录） |
| `~/.penguin/config.json` 等 | 本地环境配置（加载顺序见 §3.7） |
| `~/.penguin/knowledge/knowledge.db` | 知识图谱主库（+ `-wal` / `-shm`） |
| `~/.penguin/knowledge/ledger.jsonl` | 只追加事件账本 |
| `~/.penguin/knowledge/notes/` | Markdown 笔记（Obsidian 兼容，事实来源） |
| `~/.penguin/knowledge/api-docs/previews/` | API 文档预览 |
| `~/.penguin/knowledge/hook-sessions/` | Claude Code hook 会话去重状态 |
| `~/.penguin/knowledge/logs/semantic-worker.log` | 语义 Worker 日志（5 MB × 3） |
| `~/.penguin/runtimes/` | 版本化 CLI / MCP 运行时代次，`current` 符号链接 |
| `~/.penguin/bin/penguin-mcp`, `penguin-mcp-launcher.mjs`, `penguin-cli-launcher.mjs` | 稳定启动器 |
| `~/.penguin/mcp/` | 已同步的 MCP 服务器 + `manifest.json` |
| `~/.local/bin/penguin` | CLI 入口 |
| `~/.penguin/inline-webview-data/{key}` | 内嵌 webview 隔离数据（功能未接入 UI） |
| `<repo>/.penguin/api-docs/previews` | 每仓 API 文档预览 |
| `~/.claude.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.codex/config.toml` | Penguin 写入的 MCP 客户端配置 |
| `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` | hooks 与 agent 指引（仅对已安装客户端写入） |

环境变量可覆盖知识库路径：`PENGUIN_KNOWLEDGE_DB / _LEDGER / _NOTES`、`PENGUIN_API_DOC_PREVIEWS`、`PENGUIN_HOOK_STATE_DIR`、`PENGUIN_RUNTIME_ROOT`。

---

## 11. 快捷键总表

**全局**
| 键 | 动作 |
|---|---|
| ⌘ / | 快捷键速查表 |
| ⌘ I | 网络检查与测速 |
| ⌘ ⇧ I | cURL 导入（REST 模块下打开 REST 自己的导入弹窗） |
| ⌘ G（长按 3 秒） | Developer Mode 弹窗（隐藏） |
| Esc | 关闭任意弹窗 / 取消请求 / 退出模块 |

**API Client**
| 键 | 动作 |
|---|---|
| ⌘ Enter | 发送 |
| Esc | 取消进行中的请求 |
| ⌘ S | 包安装器 |
| ⌘ ⇧ S | 保存请求 |
| ⌘ D | 请求文档 |
| ⌘ P | 查看 proto |
| ⌘ E | 循环协议 gRPC-Web → gRPC → JS-SDK |
| ⌘ F | 搜索方法 / 服务 |
| ⌘ H | 历史 |
| ⌘ O | 已保存请求 |
| ⌘ N | 新标签页 |
| ⌘ W | 关闭标签页 |
| ⌘ R | 重置标签页 |

**REST**
⌘ Enter 发送 · URL 栏 Enter 发送 · ⌘ S 保存 · ⌘ L 聚焦 URL · ⌘ N / ⌘ T 新请求 · ⌘ W 关闭 · ⌘ F 聚焦侧栏搜索 · ⌘ H 历史 · Esc 取消 / 退出。

**Vault / Docs**：Esc 退出。列表类弹窗（History / Saved / CommandSearch）支持 ↑↓ + Enter；响应查找 Enter / Shift+Enter。

> 已知不一致：状态栏齿轮提示「⌘,」但实际**未绑定**；Wiki 模块下速查表回落显示 API Client 的快捷键。

---

## 12. 发布、更新与 CI

- **仓库拆分**：源码在私有仓库；公开仓库 `shiengng12345/penguin` 只放 Releases、GitHub Pages 下载页 / 文档、以及应用拉取的远程配置。跨仓写入用 PAT `RELEASES_TOKEN`。
- **`ci.yml`**（push main / PR）：Node 22 + pnpm 9 → `typecheck` + `test:verbose`；Rust job 在 macOS runner 上 `cargo test`。
- **`build.yml`**（`v*` tag）：aarch64 与 x86_64 双目标（arm64 runner 交叉构建 x64，vendored node 与 `better-sqlite3` 按目标架构打包）；`tauri build` 签名；产物重命名为 `Penguin_<arch>.dmg` / `.app.tar.gz(.sig)`；生成 `latest.json`；发布到公开仓库。
- **`sync-public.yml`**：只同步 `docs/*.html`、`docs/assets/` 与 `config/penguin.remote-config.json`，其余内部文档不外发。
- **`scripts/release.sh <version>`**：校验 semver → `set-version`（同步 `package.json` / `tauri.conf.json` / `Cargo.toml`）+ `cargo update` → test + typecheck → 提交 → 打 tag 推送。根目录 `release-v1.10.1.sh` 是过期的一次性脚本。
- **打包资源**：`.penguin.config.json`、MCP dist、knowledge-cli bundle（含 vendored node、`better-sqlite3`、tree-sitter WASM）；MCP 复用 CLI 运行时，不重复打包原生依赖。
- 窗口 1280×800，最小 900×600；`createUpdaterArtifacts: true`。

---

## 13. 已实现未接入 / 未实现 / 规划中

### 🚧 代码已实现，UI 未挂载
| 项 | 位置 |
|---|---|
| REST Cookie 管理面板（无法查看 / 编辑 Cookie Jar） | `src/components/rest/RestCookiesPanel.tsx` |
| REST 多标签工作区 | `src/components/rest/RestWorkspaceTabs.tsx` |
| REST 文件夹嵌套（schema 有 `parentId`，UI 隐藏） | `rest-types.ts`, `db.rs` |
| REST `form-urlencoded` 体（Rust 可发，无按钮） | `RestRequestEditor.tsx` |
| REST global / collection 级变量（只能建 env 级） | `RestSidebar.tsx` |
| REST 专用 SQLite 表（已建未写） | `db.rs`, `rest-storage.ts` |
| Vault 内嵌 webview 面板 + 工具栏（Rust 与 IPC 完整） | `InlineWebviewPanel.tsx`, `InlineWebviewToolbar.tsx` |
| Vault `totp` 类型的验证器 UI | `vault/types.ts` |
| Wiki 搜索页、仓库 / 分支面板、目录树、Why 面板、证据收件箱、时间线、流程面板 | `src/components/wiki/*` |
| `registry_package_versions` 命令（无调用方） | `registry_search.rs` |

### ⚠️ 已实现但被有意绕过
- Vault 推送加密（AES-256-GCM 信封）已实现，**当前推送明文**。

### ❌ 未实现（仅依赖 / 预留 / 注释）
- **Redis 模块**：只有 `fred` 依赖和 `redis:secret:` 键前缀保护。
- REST `multipart` 体：后端 no-op。
- REST 请求体路径的密钥注入：拒绝。
- Wallpaper `paused` 状态、多显示器、自定义源。
- Prevent Sleep 的 `ask_every_time` / `auto` 模式：Rust 枚举有，UI 有意不提供。
- Spring 框架边、proto / SQL / YAML 语法解析。
- Cursor / Windsurf / Gemini CLI 等 MCP 客户端自动配置。

### 📝 规划文档（明确标注 Future / Not Implemented）
- 多终端模块：`docs/architecture/penguin-multi-terminal-plan.md`
- 多窗口架构：`docs/architecture/penguin-multi-window-architecture-plan.md`
- Realtime 模块（WebSocket / Socket.IO / SSE）：`docs/architecture/penguin-realtime-module-full-plan.md`
- Penguin Runtime（容器运行时，对标 OrbStack）：`requirements/penguin-runtime/ARCHITECTURE.md`
- `requirements/graph.md` 中的 `replay / catchup / scar / consensus / graveyard / busfactor / challenge / trace / drift / living-spec / teach` 等旗舰命令为愿望清单，未实现。
- `enhancement/enhancementv1.md`：批量请求执行器（⌘B）等仍未实现；其中 Cheat Sheet、Copy as cURL、响应内搜索、响应大小已落地。

### 其它已知瑕疵
- 死代码：`onboarding/Tutorial.tsx`、`useNetworkGuard`。
- MCP 服务器中的 `schemaVersion: 18` 为手工维护常量，需与 `knowledge-core` 的 `SCHEMA_VERSION` 手动同步。
- `--legacy-search` 处于弃用窗口。
- 部分提示仅中文（多仓选择、未检测到 MCP 客户端、未知 shell）。

---

## 14. 相关文档索引

- 知识系统契约（自动生成，勿手改）：`docs/knowledge-v2/capability-matrix.md`、`cli-reference.md`、`mcp-reference.md`、`schema-reference.md`
- 知识系统说明：`docs/knowledge-v2/README.md`、`architecture.md`、`search-contract.md`、`coverage-policy.md`、`troubleshooting.md`、`operations.md`、`vault-and-obsidian.md`、`wiki-guide.md`、`penguin-wiki-comparison.md`
- 产品方向：`docs/penguin-knowledge-strategy.md`、`docs/ai-knowledge-vault.md`
- 需求与设计：`requirements/requirement.md`、`requirements/DOCUMENTATION.md`、`requirements/knowledge-design.md`、`requirements/graph.md`
- 发布：`docs/DOWNLOAD.md`、`docs/knowledge-v2/release-gate.md`、`rollout-runbook.md`、`rollback-runbook.md`
- 用户站点：`docs/index.html`、`docs/docs.html`、`docs/tutorial.html`
