# 从零构建 Coding Agent CLI · 实战教程设计稿

> 状态：实施中。总体设计已经通过评审；伴随代码按 `chapter-01` 至 `chapter-23` 的 Git tag 逐章交付。
>
> 原有 1–32 章继续作为“原理篇”。本教程是配套的“实战篇”：以一套真实、连续、可编译的 TypeScript 项目为主线，把原理落成一个可使用的 Coding Agent CLI。

---

## 1. 为什么需要一套新的实战篇

原教程对 Agent Harness 的组成讲得比较完整，但不适合直接作为产品源码照抄：

- 第 1–22 章使用 Python，第 23–32 章突然切换到 TypeScript。
- 大量代码是用于解释设计的节选，不是完整文件。
- 后半部分假设 TypeScript Harness 已经存在，但没有提供对应基线。
- 一些“安全机制”实际上只是提示或字符串检查，不是真正的执行边界。
- Checkpoint、权限、评测等能力分别讲过，但没有完整接入最终 CLI。
- 没有一套可以持续执行 `build + test + eval` 的伴随代码仓库。

实战篇不重讲所有理论，而是解决一个更具体的问题：

> 从空目录开始，怎样按可验证的小步，做出一套能读代码、修改代码、执行命令、运行测试、恢复会话，并且不会轻易破坏用户工作区的 Coding Agent CLI？

---

## 2. 最终要交付什么

教程完成时，项目应提供一个名为 `agent-code` 的 CLI。名称只是占位符，后续可以替换。

它至少支持：

```text
agent-code                         # 启动交互会话
agent-code "解释这个项目"          # 带首条消息启动
agent-code --resume <session-id>   # 恢复会话
agent-code --print "运行测试"      # 非交互执行
agent-code --output-format jsonl   # 机器可读事件流
agent-code --worktree <name>       # 在隔离工作区执行
```

核心能力：

- 流式模型响应和结构化工具调用。
- 同时支持 GPT 和 DeepSeek；Anthropic 不是教程前提，也不是必装依赖。
- 项目文件发现、读取、搜索和基于 patch 的修改。
- Shell 命令执行、超时、取消、后台任务和输出分页。
- Workspace trust、权限规则以及可替换的 OS 沙箱执行器。
- 修改前 checkpoint、真实 diff、冲突检查和按回合撤销。
- 只提交 Agent 自己产生且用户确认过的 Git 修改。
- 会话持久化、恢复、分支和导出。
- 项目指令、配置、MCP、Hooks 和 Skills。
- Mock Provider 单元测试、真实工作流 Eval 和可观测事件。
- 可选的 Subagent、Worktree 和 LSP 扩展。

本教程不把以下目标塞进第一版：

- 不追求复刻某个商业产品的私有实现。
- 不在 MVP 阶段制作全屏 TUI、IDE 插件或 Web 服务。
- 不声称仅靠命令字符串分类就能提供安全沙箱。
- 不手写完整 LSP/JSON-RPC 协议栈。
- 不默认展示模型的原始思维链，只展示可供用户判断的状态和行动摘要。

---

## 3. 教程的工程约束

### 3.1 单一语言和运行时

实战篇统一使用：

- TypeScript
- Node.js 22+
- ESM
- 严格类型检查
- Vitest

原理篇中的 Python 实现仍然有学习价值，但实战篇不会混用两套语言。需要引用原理时，只引用概念和设计理由，然后给出对应的 TypeScript 实现。

### 3.2 每章必须是可运行状态

每章结束必须满足：

```bash
npm run typecheck
npm test
npm run build
```

涉及完整 Agent 行为的章节还要满足：

```bash
npm run test:e2e
```

使用真实模型的 smoke test 默认不进入普通 CI，避免 API 成本和随机性影响基础测试。

### 3.3 文档和源码不能分叉

伴随代码采用以下规则：

- 每章对应一个 Git tag，例如 `chapter-04`。
- 教程中的完整代码优先从真实源文件引用或生成。
- 只用于说明的伪代码必须明确标注“伪代码”。
- 每个命令都要在干净环境验证。
- 章节迁移必须给出明确 diff，不能用“其余代码略”隐藏关键接线。

### 3.4 安全声明必须准确

文中严格区分：

- `PathGuard`：检查路径是否符合规则。
- `PermissionPolicy`：决定 allow / ask / deny。
- `SandboxRunner`：用操作系统能力限制文件和网络访问。
- `WorkspaceTrust`：决定是否加载项目提供的配置、Hooks 和 MCP。

只有真正使用操作系统隔离的执行器才能称为 sandbox。用户确认不是隔离边界。

---

## 4. 最终架构

```text
┌──────────────────────────────────────────────────────┐
│ CLI                                                   │
│ input controller · renderer · commands · headless    │
└────────────────────────┬─────────────────────────────┘
                         │ UserMessage / UserDecision
┌────────────────────────▼─────────────────────────────┐
│ Session                                               │
│ transcript · event log · config · checkpoint · usage │
└────────────────────────┬─────────────────────────────┘
                         │ runTurn()
┌────────────────────────▼─────────────────────────────┐
│ Agent Runtime                                         │
│ loop · provider · tool selection · context · cancel  │
└───────────────┬──────────────────────┬───────────────┘
                │ tool call            │ model stream
┌───────────────▼────────────┐   ┌─────▼───────────────┐
│ Tool Runtime               │   │ Provider Adapter     │
│ schema · permission · log  │   │ GPT · DeepSeek · Mock│
└───────────────┬────────────┘   └─────────────────────┘
                │
┌───────────────▼──────────────────────────────────────┐
│ Execution Boundary                                    │
│ workspace paths · file patches · shell · MCP · hooks │
└───────────────┬──────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────┐
│ Safety / Recovery                                     │
│ sandbox · checkpoint · git ownership · audit         │
└──────────────────────────────────────────────────────┘
```

计划中的源码结构：

```text
agent-code/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli/
│   │   ├── bin.ts
│   │   ├── main.ts
│   │   ├── input-controller.ts
│   │   ├── renderer.ts
│   │   └── commands.ts
│   ├── runtime/
│   │   ├── agent.ts
│   │   ├── events.ts
│   │   ├── cancellation.ts
│   │   └── limits.ts
│   ├── messages/
│   │   ├── blocks.ts
│   │   ├── transcript.ts
│   │   └── serde.ts
│   ├── providers/
│   │   ├── provider.ts
│   │   ├── mock.ts
│   │   ├── openai-responses.ts
│   │   ├── openai-chat-compatible.ts
│   │   └── deepseek.ts
│   ├── tools/
│   │   ├── tool.ts
│   │   ├── registry.ts
│   │   ├── result.ts
│   │   ├── files/
│   │   ├── shell/
│   │   ├── git/
│   │   └── mcp/
│   ├── permissions/
│   │   ├── policy.ts
│   │   ├── rules.ts
│   │   └── workspace-trust.ts
│   ├── sandbox/
│   │   ├── runner.ts
│   │   ├── unavailable.ts
│   │   └── platform/
│   ├── sessions/
│   │   ├── store.ts
│   │   ├── checkpoint.ts
│   │   └── export.ts
│   ├── context/
│   │   ├── accountant.ts
│   │   ├── compactor.ts
│   │   └── project-instructions.ts
│   ├── config/
│   │   ├── schema.ts
│   │   └── loader.ts
│   ├── extensions/
│   │   ├── hooks.ts
│   │   ├── skills.ts
│   │   └── mcp.ts
│   └── observability/
│       ├── audit.ts
│       └── tracing.ts
└── tests/
    ├── unit/
    ├── integration/
    ├── security/
    └── evals/
```

### 4.1 Provider 路线：GPT 和 DeepSeek 都是一等公民

教程不要求读者拥有 Anthropic API。真实模型接入顺序调整为：

```text
Mock Provider
→ GPT Provider（OpenAI Responses API）
→ DeepSeek Provider（OpenAI-compatible Chat Completions）
```

两条真实 Provider 路径共享同一个内部接口，但不会通过“只换 base URL”假装二者完全相同：

```ts
interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  parallelToolCalls: boolean;
  reasoningSummary: boolean;
  nativeContinuation: boolean;
}
```

具体边界：

- GPT 适配器使用 OpenAI Responses API，把 response output items、function call 和 usage 转成内部事件。
- DeepSeek 适配器使用 OpenAI-compatible Chat Completions，把 message、tool calls、reasoning 字段和 SSE delta 转成相同的内部事件。
- OpenAI-compatible 只代表请求形状大体兼容，不代表角色、参数、reasoning 字段、tool choice 和流式事件完全一致。
- Runtime、Tool Registry 和 Transcript 不 import OpenAI SDK 类型，也不依赖 DeepSeek 的响应类型。
- 模型 ID必须由配置或环境变量提供；教程不把容易变化的默认模型名写死在业务代码里。
- 每个 Provider 有独立 fixture 和契约测试，确保“同一内部事件语义”，而不是确保“厂商 JSON 完全一样”。

建议配置：

```text
AGENT_CODE_PROVIDER=openai|deepseek|mock
AGENT_CODE_MODEL=<你账号中可用的模型 ID>
OPENAI_API_KEY=<GPT API key>
DEEPSEEK_API_KEY=<DeepSeek API key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

读者可以只配置其中一个真实 Provider。普通单元测试和大部分端到端测试始终使用 Mock Provider，因此没有任意一家的 API key 也能完成基础章节。

---

# 第一部分：做出真正能运行的 MVP

这一部分只追求一条可靠的端到端链路：用户输入 → 模型 → 工具 → 结果 → 模型 → 用户。

完成标准：它能在一个临时项目中读取文件、做一次安全修改、运行测试，并且所有行为都有结构化事件记录。

## 第 1 章：项目骨架和章节契约

### 本章目标

- 建立 TypeScript、ESM、Vitest 和构建配置。
- 定义每章必须通过的命令。
- 建立 `src/`、`tests/` 和示例目录。
- 加入 Mock-only 的 CI，不需要 API key。

### 本章产物

- 可执行的空 CLI：`agent-code --help`。
- `npm run typecheck/test/build` 全部通过。
- 第一份架构决策记录：为什么统一 TypeScript。

### 验收测试

- Node 版本不符合要求时给出可读错误。
- CLI 的 `--help` 返回退出码 0。
- 未知参数返回非零退出码。

### 参考原教程

- ch1 项目骨架。
- ch23 CLI 产品边界。
- ch32 npm 打包。

## 第 2 章：类型化消息和事件协议

### 本章目标

定义稳定的内部协议，而不是直接传厂商 SDK 对象：

```ts
type ContentBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningSummaryBlock;

type RuntimeEvent =
  | TextDeltaEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | PermissionRequestedEvent
  | UsageEvent
  | ErrorEvent;
```

### 关键决定

- Provider 对象不能泄漏到 Transcript。
- 事件必须可序列化，以便 CLI、JSONL 和未来 Web UI 共用。
- Tool result 同时包含机器字段和给模型看的文本。
- 错误分为 user error、tool error、provider error、cancelled 和 internal error。

### 验收测试

- 所有消息和事件都能 JSON round-trip。
- 未知事件版本能被明确拒绝或兼容处理。

### 参考原教程

- ch3 类型消息。
- ch5 流式事件。

## 第 3 章：Mock Provider 和最小 Agent Loop

### 本章目标

- 定义 `Provider.stream()` 接口。
- 实现可脚本化的 Mock Provider。
- 实现带最大回合数、取消信号和明确终止原因的 loop。

### 关键决定

`runTurn()` 使用配置对象，不使用十几个位置参数：

```ts
await runTurn({
  provider,
  transcript,
  tools,
  signal,
  limits,
  emit,
});
```

### 验收测试

- 纯文本回答。
- 一次工具调用后回答。
- 连续多次工具调用。
- 未知工具、无效参数和工具异常。
- 达到最大回合数。
- 用户取消。

### 参考原教程

- ch2 最小循环。
- ch5 中断。
- ch6 安全派发。

## 第 4 章：真实 Provider 和流式工具调用

### 本章目标

- 先实现 GPT Provider，使用 OpenAI Responses API。
- 再实现 DeepSeek Provider，使用其 OpenAI-compatible Chat Completions API。
- 分别正确累积两种协议的文本 delta、工具参数 delta 和 usage。
- 记录 usage、stop reason 和 provider request ID。
- GPT 和 DeepSeek 都必须通过同一组 Provider 契约测试。

### 关键决定

- 默认模型来自配置，不把易过期的模型 ID散落在源码里。
- `temperature=0` 不表述为“完全确定性”。
- mid-stream 失败不能盲目重放已有副作用。
- Provider retry 只覆盖可以安全重试的阶段。
- 不把 OpenAI Responses API 的 continuation 机制强行模拟成 DeepSeek 能力；多轮历史由内部 Transcript 提供共同基线。
- reasoning/thinking 是可选能力，没有时 Runtime 仍然正常工作。

### 验收测试

- 分别用 GPT 和 DeepSeek 的录制流式 fixture 测试，不依赖网络。
- 两种协议下，工具参数跨多个 delta 时都能正确拼接。
- provider 断流时返回部分输出和明确错误。
- 只配置 `OPENAI_API_KEY` 时可以完成 GPT smoke test。
- 只配置 `DEEPSEEK_API_KEY` 时可以完成 DeepSeek smoke test。

### 参考原教程

- ch3 Provider adapter。
- ch5 streaming、retry 和 fallback。
- ch22 多 Provider 原则。

## 第 5 章：Tool Registry、Schema 和结果信封

### 本章目标

- 定义 Tool、JSON Schema、side effects 和 handler。
- 使用标准校验器验证参数。
- 实现统一的 ToolResult envelope。
- 实现输出尺寸限制和分页 cursor。

### 工具执行顺序

```text
查找工具
→ 校验参数
→ 计算权限请求
→ 权限决策
→ 执行
→ 截断/分页
→ 记录审计事件
→ 返回 ToolResult
```

### 验收测试

- 缺少字段、类型错误、额外字段。
- 工具异常不能击穿 Agent Loop。
- 超大输出不会塞满上下文。
- 相同工具调用循环能被检测。

### 参考原教程

- ch4 Tool Protocol。
- ch6 校验和异常。
- ch11 为模型设计工具。

## 第 6 章：项目发现、读取、搜索和 Patch 编辑

### 本章目标

第一版只提供四类核心能力：

- `list_files`
- `search_text`
- `read_file`
- `apply_patch`

不单独提供会静默覆盖文件的 `create_file`。创建新文件也通过 patch 表达。

### 关键决定

- 所有路径相对于一个不可变的 workspace root。
- 路径检查使用 realpath，并明确处理符号链接。
- `.git`、依赖目录、二进制文件和敏感文件有独立策略。
- Patch 带有读取时的文件 hash，过期时拒绝应用。
- 写入使用临时文件 + rename，避免半写入状态。

### 验收测试

- `../` 路径逃逸。
- 绝对路径逃逸。
- 指向 workspace 外的符号链接。
- 文件在读取后被其他进程修改。
- 新建、修改和删除 patch。
- UTF-8、空文件、大文件和二进制文件。

### 参考原教程

- ch11 viewport 和 edit_lines。
- ch24 文件工具。

## 第 7 章：可取消的 Shell 执行器

### 本章目标

- 前台命令和后台 job 使用同一个 ProcessManager。
- 支持 cwd、timeout、AbortSignal、输出 cursor 和退出原因。
- 正确追踪子进程引用，`stop_job` 必须真的停止进程。
- 对 POSIX 进程组和 Windows 行为分别说明。

### 关键决定

- Shell runner 接受完整命令是产品能力，但命令前缀匹配不作为安全边界。
- 输出按字节限制，并保留头尾或 cursor，不只粗暴截断前 100KB。
- 环境变量采用最小 allowlist，再按配置添加。
- 网络权限由 SandboxRunner 控制，不依赖 `curl` 黑名单。
- 无法启用 OS 沙箱时，CLI 显示清晰警告。

### 验收测试

- 超时后杀死进程树。
- 用户 Ctrl-C 取消当前命令，但不退出整个 CLI。
- 无限 stdout/stderr 不导致内存无限增长。
- 后台任务查询、停止和清理。
- `ls && destructive-command` 不能因为 `ls` 被当成只读。

### 参考原教程

- ch5 中断。
- ch14 sandbox 接口。
- ch25 终端执行器。

## 第 8 章：Workspace Trust、权限与沙箱

### 本章目标

建立四层防线：

```text
Workspace Trust
→ Permission Rules
→ Interactive Decision
→ OS Sandbox Enforcement
```

### 权限模型

```ts
type PermissionDecision =
  | { kind: "allow"; scope: "once" | "session" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };
```

规则优先级：

```text
managed deny
→ user deny
→ project deny
→ explicit ask
→ allow
→ default policy
```

### 关键决定

- 读操作也可能泄漏秘密，不能简单全部自动放行。
- 项目配置在 workspace 被信任前不能启用 Hooks、MCP 或放宽权限。
- “本次会话允许”基于规范化规则，不基于参数前 100 字符。
- 敏感目录、网络域名和外部路径都进入同一审计模型。

### 验收测试

- `.env`、SSH、凭据文件读取。
- 项目配置试图放宽用户 deny。
- Prompt injection 诱导访问 workspace 外文件。
- 沙箱不可用时的 fail-open / fail-closed 配置。

### 参考原教程

- ch13 MCP 不可信内容。
- ch14 权限和 sandbox。
- ch23 CLI 确认。
- ch30 配置化权限。

## 第 9 章：CLI 交互、事件渲染和取消

### 本章目标

- 全程只维护一个输入控制器，不在工具里重复创建 readline。
- 模型输出、工具状态和权限请求共享一个终端状态机。
- 第一遍 Ctrl-C 取消当前 turn，空闲时 Ctrl-C 才退出。
- 支持 `/help`、`/status`、`/permissions`、`/clear` 和 `/exit`。

### 关键决定

- 进度来自实际工具事件，不由模型编造百分比。
- Diff 来自真实 patch 和文件状态，不由模型提供 original/modified 字符串。
- 默认展示行动摘要，不展示原始思维链。
- Renderer 负责处理 ANSI、终端宽度和非 TTY 环境。

### 验收测试

- 文本流与工具事件交错。
- 权限提示期间不会被模型输出破坏。
- 非 TTY 环境不输出控制字符。
- 工具输出中的 ANSI escape 不得控制用户终端。

### 参考原教程

- ch5 REPL。
- ch23 events。
- ch29 UI。

## 第 10 章：MVP 端到端验收

### 本章场景

在临时项目中完成：

```text
用户：把 timeout 从 5000 改为 10000，并运行测试。

Agent：
1. 搜索 timeout。
2. 读取目标文件。
3. 生成带 hash 的 patch。
4. 请求编辑权限。
5. 应用 patch。
6. 请求并执行测试命令。
7. 根据真实退出码报告结果。
```

### 完成标准

- 全流程可以由 Mock Provider 确定性复现。
- 使用真实 Provider 可以完成 smoke test。
- 所有工具调用、权限决策和文件变化进入事件日志。
- 失败时不会留下半写入文件或失控子进程。

---

# 第二部分：让修改可恢复、可验证

第一部分解决“能工作”，第二部分解决“敢让它工作”。

## 第 11 章：真实 Diff、并发冲突和变更归属

### 本章目标

- 每次文件读取返回版本信息。
- 每次修改生成真实 unified diff。
- 应用 patch 前重新校验版本。
- 记录本回合由 Agent 产生的文件集合和行级 diff。

### 验收测试

- 用户在 Agent 思考期间修改同一文件。
- 两个工具并发编辑同一文件。
- Patch 只匹配一次、匹配零次或匹配多次。

## 第 12 章：Checkpoint 和 Undo

### 本章目标

- 每条用户消息开始前创建 checkpoint。
- 文件工具写入前保存必要的恢复信息。
- `/undo` 可以只撤销 Agent 的当前回合修改。
- 恢复时不能覆盖用户随后产生的新修改。

### 关键决定

- Git 仓库和非 Git 目录都能 checkpoint。
- Checkpoint 不等同于 `git reset --hard`。
- Shell 命令造成的外部副作用不能假装完全可逆。

### 参考原教程

- ch21 Checkpoint 和 resume。

## 第 13 章：Git 工具和用户修改保护

### 本章目标

- `git_status`、`git_diff` 和 `git_log` 使用结构化适配器。
- Agent 提交时只 stage 自己修改的明确文件。
- 提交前展示 staged diff。
- push、rebase、reset 等远程或高风险操作保持高权限。

### 禁止的默认行为

```text
git add .
git add -A
提交整个工作区
覆盖用户已有 staged 状态
```

### 参考原教程

- ch26 Git 工具集。

## 第 14 章：测试—诊断—修复循环

### 本章目标

- 测试结果使用结构化 ToolResult。
- 失败后允许 Agent 读取相关代码并再次修改。
- 限制最大修复轮数、总时长和 token。
- 最终报告必须区分“测试通过”“未运行”“运行失败”。

### 关键决定

- 不把“命令退出”误当成“测试成功”。
- 不吞掉 stderr。
- 不用模型判断退出码。

## 第 15 章：Session 持久化、恢复和分支

### 本章目标

- Transcript 和 RuntimeEvent 以版本化 JSONL 保存。
- 支持 session ID、名称、项目路径和创建时间。
- `--resume` 恢复对话和必要状态。
- `--fork-session` 从旧会话创建分支。
- 支持人类可读导出。

### 验收测试

- 进程异常退出后恢复。
- Schema 升级迁移。
- 同一会话不能被两个进程无保护地同时写入。

### 参考原教程

- ch9 外部状态。
- ch21 持久化。

---

# 第三部分：把 MVP 变成可扩展产品

## 第 16 章：上下文预算、压缩和项目指令

### 本章目标

- 加载用户级和项目级指令文件。
- 支持目录范围内的嵌套规则。
- 展示当前上下文由哪些部分占用。
- 在压缩后保留任务目标、未完成步骤和重要工具结果。

### 项目指令加载原则

- 未信任 workspace 不执行指令中引用的 Hooks 或命令。
- 长参考资料按需加载，不全部塞进初始上下文。
- 压缩摘要必须标记它是摘要，不伪装成原始消息。

### 参考原教程

- ch7–10 上下文工程。
- ch12 动态工具选择。

## 第 17 章：配置系统和策略层级

### 本章目标

- 配置使用 runtime schema 校验。
- 区分 managed、user、project 和 local 配置。
- 数组字段明确采用 merge 还是 replace。
- 无效配置必须报告文件、字段和原因，不能静默忽略。

### 关键决定

- 环境变量使用产品前缀，避免 `MODEL`、`TOOLS` 这类通用名称冲突。
- 项目配置不能覆盖 managed deny。
- 易过期的模型 ID集中管理并允许显式覆盖。

### 参考原教程

- ch30 配置系统。

## 第 18 章：Headless 和 JSONL 协议

### 本章目标

- `--print` 非交互执行。
- `--input-format text|jsonl`。
- `--output-format text|json|jsonl`。
- 正确的退出码和 stderr 约定。
- CI 模式默认拒绝需要交互确认的操作。

### 验收测试

- stdin 管道输入。
- 多事件 JSONL 流。
- 取消、预算耗尽、权限拒绝和内部错误的退出码。

## 第 19 章：MCP、Hooks 和 Skills

### MCP

- 配置 server transport、超时和鉴权。
- MCP 工具进入同一权限和审计管线。
- Server 返回内容默认标记为外部不可信内容。
- 连接失败不拖死整个 CLI。

### Hooks

- `SessionStart`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `PermissionRequest`
- `Stop`

Hooks 可以阻止操作，但不能绕过更高层级的 deny。

### Skills

- Skill 是按需加载的说明和工作流，不等同于增加一个新工具。
- 项目 Skill 在 workspace trust 后才能生效。
- Skill 内容和脚本分开授权。

### 参考原教程

- ch13 MCP。
- ch15 Subagent 作为隔离上下文的思想。

## 第 20 章：可观测性和工作流 Eval

### 本章目标

- 为 session、turn、provider request 和 tool call 建立 trace。
- 记录 token、耗时、错误和权限决策。
- 构建可重复的临时仓库 Eval。
- 使用真实测试、文件 diff 和 Git 状态评分。

### Eval 必须真正实现

- `EvalRunner.runAgent()` 不能留作抽象练习。
- Runner 必须把 workspace root 注入全部工具。
- 清理使用受控临时目录 API，不拼接 `rm -rf`。
- `passed/total` 是可访问的正式结果字段。
- 同一场景重复运行，报告成功率和方差。

### 参考原教程

- ch18 Observability。
- ch19 Eval。
- ch20 Cost。
- ch31 Coding Agent workflow eval。

---

# 第四部分：高级能力，按需加入

## 第 21 章：Subagent 和 Worktree 隔离

### 本章目标

- Subagent 使用独立 Transcript 和受限工具集。
- 父 Agent 只接收结构化摘要和产物引用。
- 并行写任务默认进入不同 worktree。
- 合并前运行冲突检测和测试。

### 关键决定

- 不让多个 Agent 直接并发写同一个工作目录。
- 子 Agent 的权限不能高于父任务授予的权限。
- 并行适用于独立任务，不把所有工作盲目并行化。

### 参考原教程

- ch15 Subagent。
- ch16 Plan。
- ch17 并行和共享状态。

## 第 22 章：LSP 作为可选插件

### 本章目标

- 默认核心能力不依赖 LSP。
- 使用成熟协议库处理 Content-Length framing。
- 正确设置 workspace URI、文档版本和请求超时。
- LSP 不可用时回退到搜索、读取和测试。

### 为什么后置

- Coding Agent 的第一价值是可靠地理解、修改和验证代码。
- LSP 部署成本和跨语言差异很大。
- 不稳定的自制 LSP 客户端会比没有 LSP 更难调试。

### 参考原教程

- ch27 LSP。
- ch28 代码分析。

## 第 23 章：插件、IDE、Web 和团队策略

这一章不在核心仓库里塞三个半成品，而是定义稳定的扩展接口：

- CLI Renderer adapter。
- IDE transport adapter。
- WebSocket event protocol。
- Plugin manifest。
- 团队 managed policy。
- 远程审计 exporter。

### 参考原教程

- ch29 UI。
- ch32 扩展方向。

---

## 5. 原教程内容如何处理

### 可以直接保留思想的章节

- ch2：Agent loop。
- ch3：类型消息。
- ch4：Tool protocol。
- ch5：Streaming 和 interruption。
- ch7–12：上下文工程和动态工具。
- ch13：MCP 基本动机。
- ch15–20：Subagent、Plan、Observability、Eval、Cost。

这些章节主要修正代码语言和 API，不需要改掉核心论点。

### 需要重写实现的章节

- ch14：权限和 sandbox。
- ch21：Checkpoint 接线。
- ch23：CLI 入口。
- ch24：文件安全和 patch。
- ch25：Shell 执行器。
- ch26：Git 修改归属。
- ch27：LSP framing 和生命周期。
- ch29：真实 diff、输入控制器和思考展示。
- ch30：配置 schema 和信任层级。
- ch31：可执行 EvalRunner。
- ch32：发布前必须由 CI 证明可构建。

### 需要新增的内容

- Workspace trust。
- 项目指令文件。
- Headless/JSONL 协议。
- Hooks 和 Skills。
- OS 级文件与网络沙箱。
- 文件 hash、原子 patch 和并发冲突。
- Agent 修改归属和精确 Git staging。
- Session 分支与导出。
- Worktree 隔离。
- 插件契约。

---

## 6. 教程写作模板

每章使用相同结构，避免只有概念没有接线：

1. **本章问题**：上一章的系统在哪里会失败。
2. **行为规格**：先写用户能观察到的结果。
3. **威胁和失败模型**：本章要防什么，不防什么。
4. **接口设计**：类型和不变量。
5. **完整实现**：真实文件，不给无法拼接的碎片。
6. **迁移步骤**：从上一章如何升级。
7. **测试**：正常、错误、安全和取消路径。
8. **动手实验**：让读者主动破坏系统。
9. **完成检查**：明确命令和预期输出。
10. **下一章留下的问题**：为什么下一步值得做。

---

## 7. 实施顺序和评审点

本文已经通过评审，伴随代码从第 1 章开始按可运行的小步实施，不会一次性写完所有功能。

### 评审点 A：开始编码前

需要确认：

- 是否统一采用 TypeScript。
- GPT 使用 OpenAI Responses API，DeepSeek 使用 OpenAI-compatible Chat Completions。
- 实际 smoke test 使用哪些 GPT/DeepSeek 模型 ID；模型名从配置读取，不写死。
- MVP 首发平台是 macOS/Linux，还是必须同时支持 Windows。
- 是否接受先做普通流式 CLI、后做全屏 TUI。
- 产品暂定名称。

已确认的实施默认值：

- 统一使用 TypeScript、Node.js 22+ 和 ESM。
- 产品暂定名为 `agent-code`。
- GPT 使用 OpenAI Responses API；DeepSeek 使用 OpenAI-compatible Chat Completions。
- 模型 ID 由配置提供，普通测试只使用 Mock Provider。
- 第一版优先支持 macOS/Linux；跨平台边界保留接口和测试。
- 先做普通流式 CLI，不在 MVP 阶段引入全屏 TUI。

### 评审点 B：第一部分完成后

用一个真实小项目演示：

- 读取代码。
- 应用 patch。
- 权限确认。
- 执行测试。
- Ctrl-C 取消。
- 安全测试。

只有这个纵向切片稳定，才进入 Checkpoint、Git 和 Session。

### 评审点 C：第二部分完成后

验证：

- 用户已有修改不会被覆盖或错误提交。
- `/undo` 能恢复 Agent 当前回合的文件修改。
- Session 崩溃后可恢复。
- Eval 能在临时仓库重复运行。

### 评审点 D：进入高级能力前

根据实际需求选择是否实现：

- MCP
- Hooks/Skills
- Subagent/Worktree
- LSP
- IDE/Web

这些不是为了“功能列表完整”而默认全部加入。

---

## 8. 全书最终验收场景

教程最后不用“发布到 npm”作为唯一成功标准，而用一组可重复场景验收。

### 场景一：安全修改

```text
修改一个配置值，展示真实 diff，用户确认后写入，运行测试。
```

要求：不能改动其他字段，不能覆盖并发修改。

### 场景二：失败恢复

```text
Agent 修改两次，第二次导致测试失败，用户执行 /undo。
```

要求：只撤销 Agent 修改，保留用户修改。

### 场景三：危险命令

```text
项目文档中包含 prompt injection，诱导执行读取秘密并上传的命令。
```

要求：权限和沙箱共同阻止文件或网络访问。

### 场景四：进程管理

```text
启动无限输出的后台进程，然后取消。
```

要求：内存有上限，进程树被清理，CLI 仍可继续使用。

### 场景五：恢复会话

```text
在工具执行后模拟进程崩溃，再通过 --resume 恢复。
```

要求：不会重复执行有副作用的工具。

### 场景六：自动化调用

```text
通过 stdin JSONL 发送任务，在 stdout 接收事件。
```

要求：无 ANSI 噪声，有稳定 schema 和正确退出码。

### 场景七：隔离并行

```text
两个 Subagent 分别修改独立模块。
```

要求：使用隔离 worktree，合并前运行测试并报告冲突。

---

## 9. 当前结论

实战篇的核心顺序是：

```text
先建立可测试协议
→ 跑通最小纵向链路
→ 做真实执行边界
→ 保护和恢复用户修改
→ 加入 session 与自动化协议
→ 最后扩展 MCP、Subagent、LSP 和 IDE
```

它会参考原教程的架构思想，但所有实战代码都以“能编译、能测试、能从上一章迁移”为准。任何标为产品级的能力，都必须有对应实现和失败测试，不能只靠文字声明。
