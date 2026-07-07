简体中文 | Sonatype 包模糊搜索设计

# 安装器 Sonatype 模糊搜索（2026-07-07，当天交付）

分支：`feature/sonatype-package-search`。已与产品确认三决策：版本列表选择（默认最新）/ 搜索为主保留手输 / 默认当前协议过滤可切全部。

## 取数方案（拍板 A）

打开安装器 → 一次拉全量 @snsoft 包列表（内存缓存 5 分钟）→ fuse.js 本地模糊 → 点选包再拉 packument 取版本（按包名缓存）。不做每键服务端搜索（Nexus 非模糊）、不调 npm CLI。

## 组件

**Rust 两个新命令**（凭据不进前端；复用 npmrc 解析 + reqwest）：

- `registry_search_packages()`：读 npmrc registry+凭据 → 先试 npm `/-/v1/search?text=@snsoft&size=250`，失败回退 Nexus REST `/service/rest/v1/search?format=npm`（origin 推导，分页 continuationToken 取完）→ `[{name, latest_version, description}]`
- `registry_package_versions(name)`：packument → `{versions: string[], latest: string}`

**前端**：

- `src/lib/registry-search.ts`：invoke 封装 + 缓存 + 纯函数 `filterPackages(list, query, protocol|null)`（fuse.js + 协议后缀过滤）+ `sortVersionsDesc(versions)`（14 位时间戳优先，语义化回退）
- `PackageInstaller.tsx`：顶部搜索框（自动聚焦）→ 结果列表（协议胶囊，默认过滤当前页签，「全部」开关）→ 版本列表（时间戳可读化，新→旧，默认最新）→ 填入保留的 spec 输入框。已装对比/安装流程/日志不动

## 降级

搜索是增强层：registry 不可达/401/未配凭据 → 搜索区一行原因（401 提示去设置页 Registry Auth），手输安装照常，绝不阻塞。

## 测试

`filterPackages` / `sortVersionsDesc` 纯函数单测（tests/registry-search.test.mjs，仓里 ts transpile 风格）；Rust 端点回退与 npmrc 解析随现有 Rust 测试风格；UI 冒烟。
