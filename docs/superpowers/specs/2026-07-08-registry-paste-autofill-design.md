# Registry 设置：粘贴 npm 命令自动填充

## 背景 / 问题

设置页 Package Registry 三个字段（Registry URL / Username / Password）目前只能手动逐个填。
内部同事拿到的凭证往往是一条现成的 npm 命令：

```
npm config set //sonatype.client88.me/repository/npm_hosted/:_auth="$(echo -n snsoft-read:snsoft-read123 | base64)"
```

用户需要自己从命令里手动拆出 host、用户名、密码再分别填——容易填错，也是本轮
"配置不到对的 registry/username" 反馈的一部分诱因。

## 目标

用户把整条 npm 命令**直接粘进 Registry URL 输入框**，前端自动识别并拆解，把
Registry URL / Username / Password 三个框一次填好；用户核对后点「保存」。

非目标（YAGNI）：多行 .npmrc 粘贴、`registry=` 行解析、`_authToken` 形式、后端解析。

## 交互

- 入口：**Registry URL 输入框**（`onChange`）。检测到粘入的是 npm auth 命令就自动拆解填充；
  否则按普通输入原样处理（手动填不受影响）。
- **不自动保存**：填完后给一句提示（如"已从命令解析并填入，请核对后保存"），
  用户核对（此时密码框已填、保存按钮可用）再点「保存」。解析错了也能一眼看出，
  不会静默写坏 `~/.npmrc`。

## 解析器（纯函数，前端 TS）

新文件 `src/lib/registry-command-parse.ts`：

```ts
parseRegistryCommand(input: string, currentScheme: "http" | "https")
  : { registryUrl: string; username: string; password: string } | null
```

规则：
1. **host/path**：正则取 `//` 与 `:_auth=` 之间 → 如 `sonatype.client88.me/repository/npm_hosted/`。
   取不到 → 返回 `null`。
2. **凭证**：
   - 优先匹配 `echo -n <user:pass>` 取明文 token；
   - 否则把 `_auth=` 后的值当**字面 base64** 解码（`atob`）→ `user:pass`（零成本兜底，
     支持用户从 `~/.npmrc` 抄一行裸 `//host:_auth=BASE64`）。
   - 按**第一个 `:`** 拆成 username / password；任一为空 → `null`。
3. **Registry URL**：`` `${currentScheme}://${hostPath}` ``。scheme **沿用输入框当前值**
   （默认 `http://`，若用户已改成 `https://` 则保留）——不猜、不降级，与刚修复的读取端 bug 一致。
4. 容忍：`npm config set` 前缀有无、单/双引号、多余空格。
5. 非命令（不含 `:_auth=`）→ `null`，交由普通输入路径。

**为什么放前端**：纯字符串解析，前端即时反馈、单测简单（复用仓库
`registry-search-core.test.mjs` 的 TS→mjs 转译测试模式）。后端 `registry.rs` 不动。

## 改动面

- 新增 `src/lib/registry-command-parse.ts`（纯函数）
- 新增 `tests/registry-command-parse.test.mjs`
- `src/components/settings/RegistryAuthSection.tsx`：`handleRegistryUrlChange` 加检测+填充分支 + 一条提示文案常量
- 后端不改（本轮已修复读取端 host 关联 + scheme 保留）

## 测试

`registry-command-parse.test.mjs`：
- echo 命令 → 正确拆出 host/path、user、pass
- 裸 base64 行 → 解码拆出
- scheme 保留：currentScheme=https → `https://...`；=http → `http://...`
- 非命令（普通 URL / 空串）→ `null`
- 畸形（无 `:_auth=` / 凭证无 `:` / base64 非法）→ `null`
- 密码含 `:` → 只按第一个冒号拆
```
