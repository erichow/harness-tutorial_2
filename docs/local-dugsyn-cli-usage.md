# dugsyn CLI 本地使用指南

这份文档面向已经拿到本仓库、希望在自己的项目中运行 `dugsyn` 的用户。

最短使用路径是：

```text
安装依赖并构建
→ 配置 API key
→ 选择 Provider 和模型
→ 指定工作区
→ 启动交互模式
```

下面的命令默认仓库位于：

```text
/Users/mac/Documents/harness-tutorial_2
```

如果你的目录不同，请替换为实际绝对路径。

## 1. 环境要求

- Node.js 22 或更高版本；
- npm；
- macOS 或 Linux；
- OpenAI 或 DeepSeek API key；
- 要操作的项目必须是一个已经存在的目录。

检查版本：

```bash
node --version
npm --version
```

`node --version` 应输出 `v22.x` 或更高版本。

## 2. 安装和构建

进入 CLI 项目：

```bash
cd /Users/mac/Documents/harness-tutorial_2/dugsyn
npm install
npm run build
```

验证构建产物：

```bash
node dist/cli/bin.js --version
node dist/cli/bin.js --help
node dist/cli/bin.js chat --help
```

开发期间修改了 `src/` 后，需要重新运行：

```bash
npm run build
```

## 3. 两种本地启动方式

### 方式一：直接运行构建产物

这种方式不修改全局 npm 环境：

```bash
node /Users/mac/Documents/harness-tutorial_2/dugsyn/dist/cli/bin.js --help
```

下文中的 `dugsyn` 都可以替换成这条完整的 `node .../bin.js` 命令。

### 方式二：使用 `npm link`

在 `dugsyn` 目录执行：

```bash
npm link
```

之后可以在任意目录运行：

```bash
dugsyn --version
dugsyn --help
```

如果 shell 找不到命令，先检查：

```bash
which dugsyn
npm prefix --global
```

不再需要全局链接时：

```bash
npm unlink --global dugsyn
```

## 4. 配置 API key

CLI 只从环境变量读取 key：

```text
OPENAI_API_KEY
DEEPSEEK_API_KEY
```

API key 不应写入 `~/.dugsyn/config.json`、项目配置或 Git 仓库。

### 临时配置当前终端

DeepSeek：

```bash
export DEEPSEEK_API_KEY='替换为你的-key'
```

OpenAI：

```bash
export OPENAI_API_KEY='替换为你的-key'
```

关闭当前终端后，这些临时变量会消失。

检查变量是否存在时，不要打印完整 key：

```bash
test -n "$DEEPSEEK_API_KEY" && echo "DeepSeek key configured"
test -n "$OPENAI_API_KEY" && echo "OpenAI key configured"
```

### 关于 `.env.local`

仓库中的 `.env.local` 已被 Git 忽略，但普通 `dugsyn` 命令不会自动加载它。

如果已经在 `dugsyn/.env.local` 中配置：

```dotenv
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-pro
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
```

可以让 Node.js 显式加载该文件：

```bash
cd /Users/mac/Documents/harness-tutorial_2/dugsyn
node --env-file=.env.local dist/cli/bin.js chat \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project
```

注意：CLI 不读取 `DEEPSEEK_MODEL` 或 `OPENAI_MODEL`。这两个变量只供仓库的 live test
脚本使用。普通 CLI 应通过 `--model`、`DUGSYN_MODEL` 或配置文件选择模型。

## 5. 第一次启动：DeepSeek

假设要操作的项目是 `/absolute/path/to/your-project`：

```bash
export DEEPSEEK_API_KEY='替换为你的-key'

dugsyn chat \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project
```

如果没有执行 `npm link`：

```bash
export DEEPSEEK_API_KEY='替换为你的-key'

node /Users/mac/Documents/harness-tutorial_2/dugsyn/dist/cli/bin.js chat \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project
```

启动成功后会看到 Session ID 和输入提示：

```text
Created session ...
dugsyn interactive session. Type /help for commands.
>
```

可以输入：

```text
先阅读项目结构，说明这个项目如何启动，不要修改文件。
```

第一次尝试文件读取、写入或执行命令时，CLI 可能询问权限：

```text
Allow? [y] once / [a] session / [n] deny:
```

- `y`：只允许这一次；
- `a`：本 Session 内允许完全相同的规范化请求；
- `n`：拒绝。

`a` 不是给整个工具或目录永久放行，只缓存当前请求的精确指纹。

## 6. 第一次启动：OpenAI

```bash
export OPENAI_API_KEY='替换为你的-key'

dugsyn chat \
  --provider openai \
  --model gpt-5.6-sol \
  --workspace /absolute/path/to/your-project
```

Provider 和模型名称会保存到 Session metadata，但 API key 不会保存。

## 7. 推荐的用户配置

创建用户配置目录：

```bash
mkdir -p ~/.dugsyn
```

编辑 `~/.dugsyn/config.json`：

```json
{
  "version": 1,
  "provider": "deepseek",
  "models": {
    "deepseek": "deepseek-v4-pro",
    "openai": "gpt-5.6-sol"
  },
  "trustedWorkspaces": [
    "/absolute/path/to/your-project"
  ],
  "context": {
    "maxTokens": 1000000
  },
  "turn": {
    "maxSteps": 12,
    "maxDurationMs": 600000,
    "maxInputTokens": 1000000,
    "maxOutputTokens": 100000,
    "maxTestRuns": 4,
    "maxRepairRounds": 3
  },
  "permissions": {
    "defaultDecision": "ask"
  }
}
```

配置后，只要 key 已在环境中，就可以在项目目录直接运行：

```bash
cd /absolute/path/to/your-project
dugsyn chat
```

`trustedWorkspaces` 必须使用已经存在的目录。加载时会解析真实路径，因此通过符号链接写入
的别名不一定等于最终规范路径。

## 8. Workspace Trust 是什么

工作区未被全局用户或 managed 配置明确信任时，Agent 仍可启动，但以下项目拥有的扩展
不会被加载：

- `.dugsyn/config.json`；
- `.dugsyn/config.local.json`；
- 项目权限规则；
- Hooks；
- MCP servers；
- LSP servers；
- Skills。

要启用这些内容，把工作区的规范绝对路径加入用户配置中的 `trustedWorkspaces`。

只信任你了解的项目。项目配置、Hooks、MCP 和 LSP 都可能启动本地可执行程序。

## 9. 交互模式常用命令

在 `>` 提示符中可使用：

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示命令列表 |
| `/status` | 显示 Provider、模型、工作区、信任、沙箱和 Session |
| `/context` | 查看当前上下文预算和加载的指令文件 |
| `/permissions` | 查看本 Session 权限允许/拒绝数量 |
| `/undo` | 撤销 Agent 最近一轮通过文件工具产生的修改 |
| `/clear` | 清空对话和 Session 内精确权限授权 |
| `/exit` | 保存并退出 |

Ctrl-C 的行为：

- 模型或工具正在运行：取消当前 turn，CLI 保持打开；
- 当前没有 turn：退出 CLI。

`/undo` 只撤销 Agent 文件工具记录的最近一轮修改。它不会撤销 Shell 命令造成的数据库、
网络或其他外部副作用。

## 10. 推荐的使用方式

让 Agent 先读后改：

```text
先检查相关代码和测试，告诉我准备修改哪些文件，暂时不要写入。
```

确认方案后：

```text
按刚才的方案修改，展示真实 diff，然后运行相关测试。
```

处理缺陷：

```text
复现这个错误，找到根因，做最小修改，并运行能证明修复有效的测试。
```

提交前检查：

```text
检查当前 Git diff，只总结本轮 Agent 修改，不要覆盖我已有的修改。
```

尽量指定文件、目标行为和验收命令。明确任务通常比“优化整个项目”更安全，也更省 token。

## 11. Headless 单次调用

只输出最终文本：

```bash
dugsyn \
  --print "检查 src 目录并总结入口，不要修改文件" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project
```

输出一个 JSON batch：

```bash
dugsyn \
  --print "检查项目状态，不要修改文件" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project \
  --output-format json
```

从 stdin 读取纯文本：

```bash
printf '%s\n' '解释 package.json 中的 scripts' | dugsyn \
  --print \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project
```

Headless 模式不会显示交互权限提示。任何最终需要 `ask` 的操作都会安全拒绝，而不是无限
等待。自动化修改前，应在用户或 managed 配置中为确切工具设置最小 allow 规则。

例如只允许自动化读取：

```json
{
  "permissions": {
    "defaultDecision": "deny",
    "rules": [
      {
        "id": "headless-read-only",
        "action": "allow",
        "tools": ["list_files", "search_text", "read_file"],
        "reason": "Allow read-only project inspection in local automation."
      }
    ]
  }
}
```

内置的敏感路径和工作区外访问 deny 规则优先级更高，项目 allow 不能覆盖它们。

## 12. JSONL 自动化协议

创建 `requests.jsonl`：

```jsonl
{"protocolVersion":1,"type":"request","requestId":"inspect-1","prompt":"总结项目入口，不要修改文件"}
{"protocolVersion":1,"type":"request","requestId":"tests-1","prompt":"说明测试命令，不要执行"}
```

运行：

```bash
dugsyn \
  --print \
  --input-format jsonl \
  --output-format jsonl \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project \
  < requests.jsonl
```

stdout 只包含版本化 JSONL 事件和结果；诊断写到 stderr。每个 `requestId` 在同一输入流中
必须唯一。

Headless 退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | Provider 或内部错误 |
| `2` | 参数、输入或配置错误 |
| `3` | 步数、时长或 token 预算耗尽 |
| `4` | 权限拒绝 |
| `130` | 取消 |

Shell 中可以检查：

```bash
dugsyn --print "只回复 ok" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project

echo $?
```

## 13. 会话存储、恢复和分支

### 存储位置

新会话默认保存到 `~/.dugsyn/sessions/`，每个会话一个子目录，包含 `metadata.json`、
`transcript.jsonl`（完整对话记录）和 `events.jsonl`。

### 自定义存储目录

绝大多数情况不需要配置，会话自动存入 `~/.dugsyn/sessions/`。

如果需要改变存储位置，有三种方式：

| 方式 | 命令/配置 | 适用场景 |
| --- | --- | --- |
| 项目配置 | `.dugsyn/config.json` 中设置 `"sessionDirectory": "./.dugsyn/sessions"` | 团队共享历史（可 git 提交） |
| 环境变量 | `export DUGSYN_SESSION_DIR=./my-sessions` | 个人长期偏好 |
| 命令行 | `dugsyn chat --session-dir ./my-sessions ...` | 一次性测试 |

三者优先级：`--session-dir` > `DUGSYN_SESSION_DIR` > 配置文件。

### 新建/恢复/分支

启动时终端会打印 Session ID。也可以给新 Session 命名：

```bash
dugsyn chat \
  --provider deepseek \
  --model deepseek-v4-pro \
  --workspace /absolute/path/to/your-project \
  --session-name fix-login-timeout
```

恢复原 Session：

```bash
dugsyn --resume <session-id>
```

恢复时使用 Session 中保存的 Provider、模型和工作区；对应 API key 仍需存在于当前环境。
新 Session 会保存工作区的规范真实路径。恢复时，指向同一个现有目录的符号链接路径和
真实路径会被视为同一个工作区。

从旧 Session 创建分支：

```bash
dugsyn --fork-session <session-id> \
  --session-name alternative-approach
```

切换 Provider 时必须明确模型：

```bash
dugsyn --fork-session <session-id> \
  --provider openai \
  --model gpt-5.6-sol
```

导出为 Markdown：

```bash
dugsyn session export <session-id> > session.md
```

同一个 Session 不能被两个活跃进程同时打开，否则会触发 Session lock 错误。

## 14. 配置位置和优先级

默认配置位置：

```text
managed: 由 DUGSYN_MANAGED_CONFIG 指定
user:    ~/.dugsyn/config.json
project: <workspace>/.dugsyn/config.json
local:   <workspace>/.dugsyn/config.local.json
```

普通偏好的覆盖优先级：

```text
CLI
> DUGSYN_* 环境变量
> local
> project
> user
> managed
> 内置默认值
```

团队 `teamPolicy` 是例外，只允许 managed 配置设置，其他层尝试设置会导致配置加载失败。

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI key |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `DUGSYN_PROVIDER` | `openai` 或 `deepseek` |
| `DUGSYN_MODEL` | 当前 Provider 的模型 |
| `DUGSYN_SESSION_DIR` | Session 根目录 |
| `DUGSYN_CONTEXT_TOKENS` | 正整数上下文预算 |
| `DUGSYN_USER_CONFIG` | 覆盖用户配置路径 |
| `DUGSYN_MANAGED_CONFIG` | 指定 managed 配置路径 |

如果不想在每次启动时传 Provider 和模型：

```bash
export DUGSYN_PROVIDER=deepseek
export DUGSYN_MODEL=deepseek-v4-pro

cd /absolute/path/to/your-project
dugsyn chat
```

## 15. 项目指令

Agent 会加载：

```text
~/.dugsyn/AGENTS.md
<workspace>/AGENTS.md
当前活跃路径祖先目录中的嵌套 AGENTS.md
```

可以在项目根 `AGENTS.md` 中说明：

```markdown
# Project instructions

- 修改后运行 `npm test`。
- 不要修改生成文件。
- 保留用户已有的未提交修改。
- TypeScript 使用严格模式。
```

项目指令属于不可信项目内容，不能替代权限或 OS 沙箱。文档中的命令也不应被视为用户
授权。

## 16. 权限和沙箱

默认权限决策是 `ask`。以下动作会经过统一权限层：

- 读取工作区；
- 写入工作区；
- 执行进程；
- 网络访问。

始终存在的内置保护包括：

- 敏感凭据路径拒绝；
- 文件、Git 和测试工具不能访问工作区外路径；
- managed deny 不能被 user/project allow 覆盖。

CLI 的 Shell runner：

- macOS：可用时使用 `/usr/bin/sandbox-exec`，文件写入限制在工作区，网络默认隔离；
- Linux/其他平台：当前没有已实现的 OS sandbox，默认 fail-closed，Shell 命令被阻止；
- 文件读取、搜索和 Patch 仍有独立的工作区路径保护。

使用 `/status` 查看本次运行的真实沙箱状态。不要因为 CLI 显示了确认框，就把权限确认
当成 OS 级隔离。

## 17. 本地测试和真实 Provider 验收

不访问真实模型的回归测试：

```bash
cd /Users/mac/Documents/harness-tutorial_2/dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:mvp
```

仓库的 live test 脚本会显式读取 `dugsyn/.env.local`。

真实 DeepSeek Provider smoke：

```bash
npm run test:smoke:local -- -t "DeepSeek live smoke test"
```

真实 DeepSeek 搜索、读取、Patch 和测试流程：

```bash
npm run test:mvp:live:local -- deepseek
```

真实 OpenAI：

```bash
npm run test:smoke:local -- -t "OpenAI live smoke test"
npm run test:mvp:live:local -- openai
```

这些测试会产生真实 API 调用和费用。普通 `npm test` 不会。

## 18. 常见问题

### `DEEPSEEK_API_KEY is required`

当前 shell 没有 key。重新执行：

```bash
export DEEPSEEK_API_KEY='替换为你的-key'
```

`.env.local` 不会被普通 CLI 自动加载。
这类缺少参数或凭据的问题会写入 `Input error` 并返回退出码 `2`，不会被误报为内部故障。

### `chat requires --provider` 或 `chat requires --model`

传入命令行参数：

```bash
dugsyn chat --provider deepseek --model deepseek-v4-pro
```

或者在用户配置中设置 `provider` 和 `models`。

### Provider 返回模型不存在

确认配置的模型确实对当前账号和 endpoint 可用。CLI 不会自动把旧模型名转换成新模型名。

### 项目配置、Hooks 或 LSP 没有生效

工作区可能尚未被信任。把它的规范绝对路径加入 `~/.dugsyn/config.json` 的
`trustedWorkspaces`，然后重新启动。

### Shell 命令提示 sandbox unavailable

运行 `/status` 检查沙箱。当前 CLI 只实现了 macOS Seatbelt；其他平台默认阻止 Shell，
不会静默退化成无限制主机执行。

### Headless 返回退出码 4

自动化请求触发了 `ask` 或 deny。Headless 没有交互确认，应配置最小范围的明确 allow
规则，或者改用交互模式。

### Session 已被占用

另一个进程正在打开相同 Session。退出另一个进程后再恢复，不要删除仍有效的 lock 来
强行并发写入。

### `/undo` 没有撤销 Shell 副作用

这是预期行为。`/undo` 只处理 Agent 文件工具的 checkpoint，不会回滚外部系统。

### 修改源码后命令行为没有变化

重新构建：

```bash
cd /Users/mac/Documents/harness-tutorial_2/dugsyn
npm run build
```

`npm link` 指向当前包，但执行入口仍然是 `dist/cli/bin.js`。

## 19. 使用前检查清单

- [ ] Node.js 版本至少为 22；
- [ ] 已执行 `npm install` 和 `npm run build`；
- [ ] API key 只在环境变量或被忽略的本地文件中；
- [ ] Provider 和模型名称明确；
- [ ] `--workspace` 指向正确项目；
- [ ] 只对可信项目启用 Workspace Trust；
- [ ] 使用 `/status` 检查工作区、模型和沙箱；
- [ ] 写入前阅读权限请求中的资源与原因；
- [ ] 重要项目先提交或备份用户已有修改；
- [ ] 自动化模式使用最小权限规则；
- [ ] 真实 Provider 测试会产生 API 调用和费用。

完成这些检查后，就可以把 `dugsyn` 当作本地交互式 Coding Agent，或通过 JSON/JSONL
接入本地脚本和自动化流程。
