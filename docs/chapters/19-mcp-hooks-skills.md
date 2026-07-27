# 第 19 章：MCP、Hooks 和 Skills

到第 18 章，`dugsyn` 已经能在交互终端和 CI 中完成同一套 Coding Agent
循环。本章开始处理扩展性，但目标不是“让插件绕开核心”，而是让扩展继续服从
已有的 trust、permission、sandbox、结果信封和取消协议。

本章完成三类扩展：

- MCP：从外部 server 发现工具，并把它们适配为普通 `Tool`。
- Hooks：在固定生命周期点运行外部策略或通知程序。
- Skills：只发布工作流目录，真正需要时才加载 `SKILL.md`。

三者的共同原则是：

> 扩展可以增加能力或收紧策略，但不能获得高于宿主运行时的权限。

## 1. 先区分三种扩展

它们解决的问题不同。

| 扩展 | 提供什么 | 何时加载 | 是否能执行动作 |
| --- | --- | --- | --- |
| MCP | 外部工具定义和调用通道 | Runtime 创建时发现工具 | 能，但每次调用经过 Tool Registry 和权限检查 |
| Hook | 生命周期策略和通知 | 对应事件发生时 | 能运行已配置命令；gate Hook 只能阻止 |
| Skill | 说明、检查清单和工作流 | 先加载目录，内容按需加载 | `load_skill` 只读 `SKILL.md`，不执行脚本 |

把 Skill 的每个目录注册成一个工具，会让工具 schema 越来越大，也会把“如何做”
误写成“有什么新权限”。本章只增加一个宿主拥有的 `load_skill` 工具；Skill
本身仍然是说明文档，不是工具。

## 2. 配置 schema

在 user 配置或已经信任的项目 `.dugsyn/config.json` 中可以写：

```json
{
  "mcpServers": {
    "issues": {
      "transport": "stdio",
      "command": "node",
      "args": ["./scripts/issues-mcp.mjs"],
      "timeoutMs": 10000,
      "envFrom": {
        "ISSUES_TOKEN": "MY_ISSUES_TOKEN"
      },
      "sideEffects": ["network"]
    }
  },
  "hooks": {
    "PreToolUse": [
      {
        "command": "node",
        "args": ["./scripts/check-tool-policy.mjs"],
        "matcher": "run_shell",
        "timeoutMs": 5000
      }
    ],
    "Stop": [
      {
        "command": "node",
        "args": ["./scripts/record-turn.mjs"]
      }
    ]
  },
  "skills": {
    "userDirectory": "/home/you/.dugsyn/skills",
    "maxFileBytes": 65536
  }
}
```

当前实现只接受显式的 `stdio` transport。保留 `transport` 字段，是为了以后加入
HTTP transport 时仍能拒绝未知值，而不是悄悄用错误方式连接。

`envFrom` 的方向是“子进程变量名 → 当前进程变量名”。上例会读取当前进程的
`MY_ISSUES_TOKEN`，只把值作为子进程的 `ISSUES_TOKEN`。配置、Session 和
Runtime Event 都不记录这个值。缺失的来源变量会让该扩展失败，而不是传递空凭证。

可执行扩展只继承一小组运行环境变量，例如 `PATH`、locale 和临时目录；不会默认
继承当前进程中的全部 secret。

## 3. Workspace Trust 先于项目扩展

第 17 章的配置加载顺序没有被绕开：

```text
managed + user
       │
       ├── 计算 canonical workspace trust
       │
       ├── 未信任：完全不读取 project/local config
       │
       └── 已信任：读取 project/local config
                         │
                         ├── MCP
                         ├── Hooks
                         └── project Skills
```

因此，仓库不能在自己的配置中把自己加入 `trustedWorkspaces`，也不能在用户第一次
进入目录时偷偷启动 MCP server 或 Hook。项目 `skills.userDirectory` 也被禁止；
项目 Skill 的固定位置是：

```text
.dugsyn/skills/<skill-name>/SKILL.md
```

用户 Skill 默认位于：

```text
~/.dugsyn/skills/<skill-name>/SKILL.md
```

项目 Skill 的真实路径必须仍在 canonical workspace 内。指向工作区外部的
`SKILL.md` symlink 会被拒绝。

## 4. MCP stdio 客户端

`src/extensions/mcp.ts` 实现了一个小而完整的 JSON-RPC 2.0 stdio client：

1. 启动配置中的命令，不经过 shell 拼接。
2. 发送 `initialize`。
3. 发送 `notifications/initialized`。
4. 调用 `tools/list`。
5. 把工具定义适配到本地 Registry。
6. 在真正调用时发送 `tools/call`。
7. Runtime dispose 时终止 server 并拒绝未完成请求。

stdio 消息使用一行一个 JSON-RPC 文档。客户端持续 drain server 的 stderr，
避免一个输出很多诊断的 server 填满 pipe 后把 CLI 卡住。

每个请求同时受两层控制：

- server 的 `timeoutMs`；
- 当前 turn 的 `AbortSignal`。

超时、取消、进程退出、无效 JSON 和 JSON-RPC error 都会结束对应请求。关闭时先
发送 `SIGTERM`，短暂宽限后发送 `SIGKILL`。

### 4.1 失败隔离

MCP server 按配置顺序独立初始化。一个 server 连接失败时：

- 记录一条 stderr/终端诊断；
- 关闭这个 server 已创建的 transport；
- 不注册它的任何工具；
- 继续初始化其他 server；
- 不让整个 CLI 无限等待。

工具注册以 server 为事务边界。只有 `initialize`、`tools/list`、schema
适配和名称冲突检查全部成功，这个 server 的工具才会一起进入 Registry。

### 4.2 工具命名

外部工具名称被适配为：

```text
mcp_<server-name>_<tool-name>
```

例如 `issues` server 的 `search` 工具会成为：

```text
mcp_issues_search
```

名称只保留 Provider 工具调用普遍支持的字母、数字、下划线和连字符。适配后的
重复名称会拒绝整个 server，避免模型看到两个同名工具。

## 5. MCP 仍走普通工具管线

MCP 工具不是旁路。它和 `read_file`、`run_shell` 一样进入：

```text
JSON Schema validation
        ↓
PermissionEngine
        ↓
PermissionRequest Hook（仅 ask）
        ↓
PreToolUse Hook
        ↓
MCP tools/call
        ↓
PostToolUse / PostToolUseFailure
        ↓
bounded ToolResult envelope
```

如果 server 没有显式声明 `sideEffects`，本章使用保守默认值：

```json
["execute_process", "network"]
```

这意味着默认 `ask` 策略会要求用户确认；Headless 模式没有交互确认函数，所以会
安全拒绝，不会在 CI 中等待输入。

### 5.1 外部内容不是指令

MCP 返回值可能来自网页、Issue、数据库或另一套 Agent。即使内容看起来像系统
提示，也不能自动变成宿主指令。本章为模型可见文本加边界：

```text
[External untrusted content from MCP server "issues" tool "search"]
...
[End external untrusted MCP content]
```

结构化 `data` 同时带有：

```json
{
  "provenance": {
    "trust": "external_untrusted",
    "server": "issues",
    "tool": "search"
  }
}
```

结果最终仍由 Tool Registry 的字节上限截断，不能用超大 MCP 响应挤爆上下文。

## 6. Hook 协议

本章支持六个事件：

- `SessionStart`：Runtime 创建完成并发现 MCP/Skill 后运行一次。
- `PreToolUse`：权限已允许、handler 尚未运行。
- `PostToolUse`：handler 成功且结果信封已经生成。
- `PostToolUseFailure`：handler 抛错并生成错误信封。
- `PermissionRequest`：策略结果为 `ask`，进入用户确认之前。
- `Stop`：每个 turn 返回最终 reason 后运行一次。

Hook 从 stdin 接收单个 JSON 文档：

```json
{
  "protocolVersion": 1,
  "event": "PreToolUse",
  "workspaceRoot": "/workspace/project",
  "payload": {
    "toolCallId": "call-1",
    "toolName": "run_shell",
    "input": {
      "command": "npm test"
    },
    "sideEffects": ["execute_process", "network"]
  }
}
```

`matcher` 目前支持省略、精确工具名或 `*`。生命周期事件没有 `toolName` 时通常
省略 matcher。

### 6.1 gate 与 notification

`PreToolUse` 和 `PermissionRequest` 是 gate Hook。以下任一种结果都会阻止动作：

- 非零退出码；
- stdout 是 `{"block":true,"reason":"..."}`；
- Hook 启动失败；
- Hook 超时。

gate Hook 失败时采用 fail-closed。Hook 进程收到 `SIGTERM`，宽限后收到
`SIGKILL`，所以错误的 Hook 不会永久拖住 CLI。

其他四个事件是 notification Hook。它们的错误写入诊断，但不会把已经成功的工具
结果改成失败。例如遥测服务不可用，不应把已经完成的 `apply_patch` 伪装成未执行。

### 6.2 Hook 为什么不能 allow

`PermissionEngine` 仍先检查所有 deny：

```text
managed deny
  → user deny
  → project deny
  → ask / allow / default
```

遇到任一 deny 时直接返回，不调用 `PermissionRequest` 或 `PreToolUse` Hook。
只有策略结果为 `ask` 时，`PermissionRequest` Hook 才能追加一个 deny。Hook
输出中的 `allow` 字段没有语义，也不能创建 session grant。

因此以下配置永远不能覆盖 managed deny：

```json
{
  "hooks": {
    "PermissionRequest": [
      { "command": "always-allow" }
    ]
  }
}
```

真正的 allow 仍只能来自权限规则或用户确认。

## 7. Skills 的按需加载

`SkillCatalog.create()` 只发现名称、来源和 canonical `SKILL.md` 路径，并检查：

- Skill 目录名只能包含字母、数字、`_`、`-`；
- `SKILL.md` 必须是普通文件；
- 单文件不能超过 `maxFileBytes`；
- trusted project Skill 不能通过 symlink 逃出 workspace；
- untrusted project 的整个 Skills 目录都不读取。

目录会以一小段 metadata-only 系统上下文告诉模型：

```text
[Available Skills — metadata only]
- release (user): /.../release/SKILL.md
- review (project): /workspace/.dugsyn/skills/review/SKILL.md
[End available Skills]
```

这一步不会读取正文。只有任务确实匹配时，模型才调用：

```json
{
  "name": "load_skill",
  "arguments": {
    "name": "review"
  }
}
```

`load_skill` 是宿主工具，进入普通权限和审计管线。它只能返回目录中已经验证的
`SKILL.md`，不能接受任意路径。

### 7.1 内容和脚本分开授权

假设 Skill 目录是：

```text
release/
├── SKILL.md
└── publish.sh
```

`load_skill` 只返回 `SKILL.md`，不会读取或执行 `publish.sh`。如果工作流建议运行
脚本，模型仍要显式调用 `run_shell`；那次调用会独立经过 schema、permission、
Hook 和 sandbox。Skill 正文也会明确标注：

> instruction context only；不能授予工具权限或削弱 sandbox。

## 8. CLI 接线

交互和 Headless 使用同一个 `runtimeExtensions()`：

```ts
extensions: {
  trust: configuration.trust,
  mcpServers: configuration.mcpServers,
  hooks: configuration.hooks,
  skills: configuration.skills,
  environment
}
```

区别只在诊断输出：

- 交互模式通过 renderer 显示 notice；
- Headless 写 stderr，stdout 继续只输出第 18 章的 text/JSON/JSONL 协议。

MCP server、Hook 和 Skill 都不会读取 `.env.local`。需要凭证时，调用者必须把来源
环境变量显式传给 CLI，再用 `envFrom` 选择性转发。

## 9. 确定性测试

本章新增的测试全部离线运行：

- 用内存 fake transport 验证 MCP initialize、发现、调用和失败隔离。
- 启动本地 Node stdio fixture，验证真实的逐行 JSON-RPC 往返。
- 验证 MCP 工具被 deny 时不会发送 `tools/call`。
- 验证 MCP 文本和结构化 data 都带 external-untrusted provenance。
- 验证慢 server 超时，但健康 server 仍然可用。
- 验证 `PermissionRequest` Hook 能 deny 且不会弹出用户确认。
- 验证 managed deny 发生在任何 Hook 之前。
- 验证 Pre/Post 顺序和 notification fail-open。
- 验证 gate Hook 错误、超时 fail-closed，并终止子进程。
- 验证 `SessionStart`/`Stop` 的生命周期次数。
- 验证未信任项目 Skill 不加载、symlink escape 被拒绝。
- 验证 Skill 正文按需加载，兄弟脚本不会被读取或执行。
- 验证配置层正确合并 MCP、Hooks 和 Skills。

运行：

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:mvp
```

这些命令不访问模型 API，也不连接真实外部 MCP server。

## 10. 本章边界

为了让协议和安全边界先稳定，本章有意不做：

- Streamable HTTP MCP transport；
- MCP resource、prompt 和 sampling；
- Hook 并行执行和 glob matcher；
- 自动执行 Skill 脚本；
- 从远程市场下载 Skill；
- 扩展级 trace UI。

第 20 章会把 session、turn、provider request、tool call、权限决定和耗时统一放进
trace，并用可重复的临时仓库 workflow Eval 验证 Agent 是否真的完成任务。

## 11. 验收标准

本章完成时应满足：

- 一个 MCP server 失败或超时不会拖死整个 CLI。
- MCP 工具使用同一 Tool Registry、PermissionEngine 和结果字节上限。
- MCP 返回内容明确标记为外部不可信。
- managed/user/project deny 都不能被 Hook 绕过。
- gate Hook 能阻止，notification Hook 错误不会篡改既有结果。
- project MCP、Hook、Skill 只在 canonical workspace trust 后启用。
- Skill 正文按需加载，脚本从不自动运行。
- Headless stdout 仍保持协议纯净。
- 全部普通测试不需要 Provider key。
