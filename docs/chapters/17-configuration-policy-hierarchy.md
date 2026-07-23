# 第 17 章：配置系统和策略层级

到第 16 章为止，`agent-code` 已经有不少可配置项，但它们分散在命令行参数、Provider 环境变量和各模块的默认值里。这样的代码可以继续堆功能，却很难回答几个重要问题：某个值究竟来自哪里、项目能否改变安全策略、写错配置时为何没有生效。

本章实现一个严格、分层且能真正驱动运行时的配置系统。最终行为是：

- 所有配置文件都经过 Zod runtime schema 校验；
- 配置分为 managed、user、project、local 四层；
- 未信任 workspace 的 project/local 文件完全不读取；
- preference 使用明确的覆盖顺序，数组使用字段级合并规则；
- managed deny 会一直保留，项目 allow 不能把它覆盖掉；
- CLI 和环境变量也进入同一套优先级；
- 错误会同时指出文件、字段和原因。

对应 Git 快照为 `chapter-17`。

## 1. 为什么不能只做一次对象展开

下面这段代码看起来像一个配置系统：

```ts
const config = {
  ...managed,
  ...user,
  ...project,
  ...local,
};
```

它有三个问题。

第一，浅层展开会让 `{ context: { maxTokens } }` 整块覆盖，而不是只覆盖指定字段。第二，数组没有统一正确的答案：模型候选可能希望 replace，权限 deny 却绝不能被后一层删除。第三，项目配置本身是仓库内容；如果打开陌生仓库就先解析并执行它，workspace trust 便失去了意义。

因此配置加载不是“读四个 JSON 然后 spread”，而是策略边界的一部分。

## 2. 文件布局

默认路径如下：

| 层 | 默认路径 | 控制者 | 读取条件 |
| --- | --- | --- | --- |
| managed | 无默认文件，通过 `AGENT_CODE_MANAGED_CONFIG` 指定 | 组织/设备管理员 | 文件存在 |
| user | `~/.agent-code/config.json` | 当前用户 | 文件存在 |
| project | `<workspace>/.agent-code/config.json` | 项目 | workspace 已信任 |
| local | `<workspace>/.agent-code/config.local.json` | 当前机器上的项目覆盖 | workspace 已信任 |

不存在的文件会跳过。存在但内容无效的文件会中止启动，不能静默回退到默认值。

`local` 适合个人路径或当前机器的临时选择，通常应加入项目的 `.gitignore`；它并不比 project 拥有更高的安全权限。

可通过两个带产品前缀的变量改变全局文件位置：

```bash
AGENT_CODE_MANAGED_CONFIG=/etc/agent-code/config.json
AGENT_CODE_USER_CONFIG=$HOME/.agent-code/config.json
```

教程没有硬编码 `/etc`，因为个人开发环境不一定存在组织级配置。部署者必须显式指定 managed 文件。

## 3. 严格 schema

schema 位于 `agent-code/src/config/schema.ts`。一个完整示例是：

```json
{
  "version": 1,
  "provider": "openai",
  "models": {
    "openai": "gpt-5.6-sol",
    "deepseek": "deepseek-v4-pro"
  },
  "trustedWorkspaces": [
    "/Users/me/projects/example"
  ],
  "sessionDirectory": "/Users/me/.agent-code/sessions",
  "context": {
    "maxTokens": 32000
  },
  "instructions": {
    "userPath": "/Users/me/.agent-code/AGENTS.md",
    "maxFileBytes": 32768,
    "maxTotalBytes": 131072
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
    "defaultDecision": "ask",
    "rules": [
      {
        "id": "confirm-shell",
        "action": "ask",
        "tools": ["run_shell"],
        "reason": "Shell commands require confirmation."
      }
    ]
  }
}
```

每个 object 都使用 `.strict()`。因此拼错 `maxToken` 不会被忽略，而会得到类似结果：

```text
Invalid configuration in /project/.agent-code/config.json at context:
Unrecognized key: "maxToken"
```

数值限制也在文件变成 TypeScript 类型之前检查。例如 token 和时间上限必须是正整数，`maxRepairRounds` 可以是零。

`version` 当前只能为 `1`。它暂时可省略，是为了让短小的个人配置易写；未来出现不兼容格式时，可以像 Session 一样增加显式迁移。

## 4. 两阶段加载与 trust 引导

项目不能通过自己的配置宣布“我值得信任”。加载器的顺序是：

```text
managed + user
       │
       ├─ 校验 trustedWorkspaces
       └─ 创建 canonical WorkspaceTrust
                    │
              trusted ?
              /       \
            yes        no
            │          │
     读 project/local  完全不读并记录 skipped reason
```

只有 managed 和 user 可以包含 `trustedWorkspaces`。`sessionDirectory` 和 `instructions.userPath` 也限制在这两个全局层：项目不能诱导 CLI 把 Session 写到任意外部目录，也不能指定任意用户指令文件。如果可信项目文件里出现这些字段，加载器会明确报错，而不是让它们看起来生效。

可信根和 workspace 都经过 `realpath`。这带来两个保证：

- 同一目录的软链接别名不能绕过“精确根目录”信任；
- project/local 文件如果通过软链接解析到了 workspace 外部，会被拒绝。

注意这里采用精确目录信任，不把父目录自动变成所有子项目的授权。用户配置示例：

```json
{
  "trustedWorkspaces": [
    "/absolute/path/to/the/project"
  ]
}
```

配置中的相对路径以该配置文件所在目录为基准。环境变量中的相对路径以启动 CLI 时的当前目录为基准。project/local 仍可配置不产生外部路径读取或写入的模型、上下文、turn 和 permission preference。

## 5. 优先级

普通 preference 的优先级从高到低为：

```text
CLI 参数
AGENT_CODE_* 环境变量
local
project
user
managed
程序默认值
```

例如新会话的 Provider/模型按以下方式解析：

```bash
agent-code chat --provider openai --model gpt-5.6-sol
```

命令行最高。省略参数时可以使用：

```bash
AGENT_CODE_PROVIDER=openai
AGENT_CODE_MODEL=gpt-5.6-sol
agent-code chat
```

再省略则读取配置文件中的 `provider` 和对应的 `models.openai` 或 `models.deepseek`。

恢复 Session 是一个有意的例外：`--resume` 使用 Session 已持久化的 Provider、模型和项目路径，不让当前配置悄悄改变历史会话。要改变它们应使用 `--fork-session`。

## 6. 数组不是统一覆盖

本章逐字段规定数组语义：

| 数组字段 | 语义 | 原因 |
| --- | --- | --- |
| `trustedWorkspaces` | managed 与 user 合并、去重 | 两个全局层都可以授予精确目录信任 |
| `permissions.rules` | 按来源追加 | 后层不能靠替换数组删除 managed/user deny |
| 单条 rule 的 `tools` / `sideEffects` / `resources` | 整条 rule 的原子内容，不跨层合并 | 同一来源内 rule id 必须唯一，跨 project/local 重复也报错 |

这里没有“猜测用户想 merge 还是 replace”。增加任何新数组字段时，都必须先在这张规则表中选择语义并增加测试。

模型使用 keyed object 而不是数组：

```json
{
  "models": {
    "openai": "gpt-5.6-sol",
    "deepseek": "deepseek-v4-pro"
  }
}
```

这样不同层可以只改一个 Provider 的模型，不必复制另一个值，也避免把易过期的模型 ID 散落在命令脚本里。

## 7. managed deny 为什么不会消失

加载器不会把四层权限规则拍平成一个“最终 rules 数组”，而是保留：

```ts
permissions: {
  managedRules,
  userRules,
  projectRules, // project + local
}
```

这些数组分别传入 `PermissionEngine`。引擎先按 managed、user、project 顺序检查所有 deny，之后才考虑 ask、allow 和默认决定。

因此下面两个配置同时存在时，请求仍会拒绝：

```json
// managed
{ "permissions": { "rules": [
  { "id": "no-shell", "action": "deny", "tools": ["run_shell"] }
] } }
```

```json
// project
{ "permissions": { "rules": [
  { "id": "allow-shell", "action": "allow", "tools": ["run_shell"] }
] } }
```

`defaultDecision` 是没有规则命中时的 preference；组织需要不可放宽的限制时，应表达为具体 managed deny，而不是只依赖默认决定。

## 8. 环境变量契约

运行时 preference 只接受这些产品前缀变量：

| 变量 | 含义 |
| --- | --- |
| `AGENT_CODE_PROVIDER` | `openai` 或 `deepseek` |
| `AGENT_CODE_MODEL` | 当前 Provider 的显式模型 ID |
| `AGENT_CODE_SESSION_DIR` | Session 保存目录 |
| `AGENT_CODE_CONTEXT_TOKENS` | 正整数上下文预算 |
| `AGENT_CODE_MANAGED_CONFIG` | managed 配置路径 |
| `AGENT_CODE_USER_CONFIG` | user 配置路径 |

`MODEL`、`PROVIDER` 之类的通用变量会被忽略，避免与 shell 或其他工具冲突。第 9、10 章中使用的 `OPENAI_MODEL` / `DEEPSEEK_MODEL` 是当时 Provider 阶段的契约；从本章当前版本开始，CLI 模型选择迁移为 `AGENT_CODE_MODEL` 或配置文件。

API key 是例外：仍使用 Provider 官方惯例 `OPENAI_API_KEY` 和 `DEEPSEEK_API_KEY`。密钥不是普通 preference，不进入 JSON 配置、Session 或日志，CLI 也不会自动加载 `.env.local`。

## 9. 接入真实运行时

配置不只负责解析。`runChatCli` 把结果接到了四个消费者：

| 配置 | 运行时消费者 |
| --- | --- |
| Provider、模型、Session 目录 | CLI 和 `SessionStore` |
| `context.maxTokens` | `ContextManager` |
| `instructions.*` | `InstructionLoader` |
| `turn.*` | 每次 `runTurn` 的限制 |
| permission 默认值和分层规则 | `PermissionEngine` |
| `trustedWorkspaces` | `WorkspaceTrust` |

CLI 先以参数中的 workspace（没有则用当前目录）加载配置。恢复或分支 Session 后，如果实际项目路径不同，会为真实 workspace 重新加载配置。这样权限和上下文不会错误地沿用启动目录的 project 文件。

`session export` 也读取同一配置，因此 `sessionDirectory` 对交互、恢复、分支和导出保持一致；显式 `--session-dir` 仍然最高优先。

## 10. 错误模型

`ConfigurationError` 保存三个稳定字段：

```ts
class ConfigurationError extends Error {
  source: string;
  field: string;
}
```

常见错误包括：

- JSON 语法错误：字段为 `$`；
- schema 错误：例如 `context.maxTokens`；
- 无效环境变量：source 为 `environment`，field 为变量名；
- 不存在的可信根：指出声明它的文件和数组下标；
- project 配置软链接越界；
- project/local 之间 permission rule id 重复。

“文件不存在”和“文件存在但错误”必须区分：前者表示该层没有配置，后者表示用户意图明确但写错，不能悄悄忽略。

## 11. 测试策略

`tests/unit/configuration.test.ts` 全部使用临时目录，覆盖：

- 四层 scalar 和 nested object 优先级；
- trusted workspace 数组合并；
- permission rules 按来源保留；
- 未信任时不解析恶意或损坏的项目文件；
- 项目不能自行建立 trust；
- JSON、schema、环境变量和可信路径错误定位；
- project 配置软链接越界；
- managed deny 对 project allow 仍有效。

所有测试离线运行，不读取真实 `~/.agent-code/config.json`，也不访问 OpenAI 或 DeepSeek。

本章验收命令：

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## 12. 动手练习

1. 增加 `tools.disabled`。先决定它是 replace 还是 merge，再让 Tool Registry 真正过滤工具并为 `/context` 增加可见性。
2. 给配置增加 `agent-code config inspect`，显示每个最终字段的来源，但要对密钥保持永久不可见。
3. 为 managed 配置加入平台默认路径，同时保留 `AGENT_CODE_MANAGED_CONFIG` 的显式覆盖，并测试 Windows/macOS/Linux 差异。
4. 设计 schema version 2 的迁移函数，不允许未知版本被当前 schema 当作普通错误糊过去。

## 13. 已知边界

- 当前只支持 JSON，不支持 JSONC、YAML 或 TOML；严格 JSON 让 schema、错误位置和依赖保持简单。
- trust 是精确 workspace 根目录，不支持 glob 或父目录递归授权。
- 配置只在 CLI 启动或切换到 Session 实际 workspace 时读取，没有文件热重载。
- managed 文件路径由部署环境显式提供，教程不实现操作系统级签名、ACL 或 MDM 分发。
- `loadedFiles` 和 `skippedFiles` 已保留来源信息，但还没有面向用户的 `/config` 查看命令。

这些是明确的产品边界，不影响本章“可验证的分层与策略不降级”目标。

下一章将实现 Headless 和 JSONL 协议：加入 `--print`、输入/输出格式、稳定退出码，并让 CI 模式在需要交互授权时默认安全拒绝。
