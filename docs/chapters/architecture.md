# dugsyn 架构总览

> dugsyn（独孤信多面体煤精组印 CLI）是一个 tutorial-built 的 coding agent CLI，吸收了各大厂 agent 工具和教程的精髓，自研融合。
> 以下 Mermaid 图展示 dugsyn 完整架构。可在 VS Code（安装 Markdown Preview Mermaid 插件）或 GitHub 上直接渲染。

---

## 1. 整体架构总览

```mermaid
graph TB
    subgraph CLI["🖥 CLI 入口"]
        BIN["bin.ts — 分发"]
        CHAT["chat.ts — 参数解析"]
        MAIN["main.ts — 帮助信息"]
        HEADLESS["headless.ts — JSONL 协议"]
        RENDERER["renderer.ts — 终端输出"]
        PERM_PROMPT["permission-prompt.ts"]
        BIN --> CHAT
        BIN --> MAIN
        BIN --> HEADLESS
    end

    subgraph AGENT["🔄 Agent Runtime"]
        direction TB
        RUNNER["coding-agent.ts — CodingAgentRuntime"]
        TURN["agent.ts — runTurn()"]
        LOOP["while steps < maxSteps"]
        TEST_LOOP["test-loop.ts — test → fix 循环"]
        CANCEL["cancellation.ts — 中断保护"]
        TURN --> LOOP
        TURN --> TEST_LOOP
        TURN --> CANCEL
    end

    subgraph PROVIDERS["🏭 Provider 层"]
        PSTREAM["provider.ts — ProviderStreamEvent"]
        OAI["openai-responses.ts"]
        DS["deepseek-chat.ts"]
        MOCK["mock.ts — 测试用"]
        HTTP["http.ts — HTTP 客户端"]
        SSE["sse.ts — SSE 解析"]
    end

    subgraph TOOLS["🔧 Tool 层"]
        T_BASE["tool.ts — Tool / ToolDefinition / SideEffect"]
        T_REG["registry.ts — ToolRegistry + 4 道闸门"]
        T_EXEC["executor.ts — ToolExecutor"]
        T_RESULT["result.ts — ToolResultBlock 工厂"]
        T_FILES["files/ — 文件工具集"]
        T_SHELL["shell/ — Bash 执行"]
        T_GIT["git/ — Git 操作"]
        T_TEST["testing/ — 测试运行"]
    end

    subgraph SEC["🔒 安全层"]
        TRUST["trust.ts — WorkspaceTrust"]
        PERMS["permissions.ts — PermissionEngine"]
        POLICY["team-policy.ts — 组织策略"]
    end

    subgraph SESSION["💾 会话层"]
        STORE["store.ts — SessionStore"]
        EXPORT["export.ts — 导出"]
        TRANSCRIPT["transcript.ts — Transcript"]
        BLOCKS["blocks.ts — ContentBlock 类型"]
    end

    subgraph CONTEXT["📋 上下文管理"]
        CTX_MGR["manager.ts — ContextManager"]
        INSTR["instructions.ts — InstructionLoader"]
        CTX_MGR --> INSTR
    end

    subgraph EXT["🔌 扩展层"]
        LSP["lsp.ts — LSP 插件"]
        MCP_EXT["mcp.ts — MCP 集成"]
        SKILLS["skills.ts — Skill 目录"]
        HOOKS["hooks.ts — 生命周期钩子"]
        PLUGIN["plugin.ts — 插件管理"]
    end

    subgraph EVAL["🧪 评估"]
        EVAL_RUNNER["runner.ts — EvalRunner"]
    end

    subgraph OBS["📡 可观测性"]
        TRACE["trace.ts — Trace span"]
        EXPORTER["exporter.ts — OTLP exporter"]
    end

    CLI --> AGENT
    AGENT -->|"stream(transcript, tools)"| PROVIDERS
    AGENT -->|"execute(call, ctx)"| TOOLS
    AGENT --> CONTEXT
    TOOLS -->|"authorize(request)"| SEC
    AGENT --> SESSION
    EXT --> HOOKS --> T_REG

    style CLI fill:#e8f5e9,stroke:#2e7d32
    style AGENT fill:#fff3e0,stroke:#e65100
    style PROVIDERS fill:#e3f2fd,stroke:#1565c0
    style TOOLS fill:#fce4ec,stroke:#c62828
    style SEC fill:#ffebee,stroke:#b71c1c
    style SESSION fill:#f3e5f5,stroke:#6a1b9a
    style CONTEXT fill:#e0f2f1,stroke:#00695c
    style EXT fill:#fff8e1,stroke:#f9a825
    style EVAL fill:#e8eaf6,stroke:#283593
    style OBS fill:#f1f8e9,stroke:#33691e
```

---

## 2. Agent 循环 — runTurn()

```mermaid
flowchart TD
    START(["runTurn({ provider, transcript, tools, signal })"]) --> INIT
    INIT["初始化: turnId, sequence, limits, testLoop"] --> LOOP{"steps < maxSteps?"}

    LOOP -->|"是"| PREPARE["ContextManager.prepare()<br/>→ 注入 instructions + 预算压缩"]
    PREPARE --> STREAM["provider.stream(transcript, tools)"]
    STREAM --> CONSUME["consumeProviderResponse()<br/>消费 StreamEvent 流"]

    CONSUME --> HAS_CALLS{"toolCalls.length > 0?"}

    HAS_CALLS -->|"否"| FINISH["finish('completed')"]

    HAS_CALLS -->|"是"| EXEC["for each call:<br/>testLoop.executor.execute()"]
    EXEC --> TOOL_RESULT["append tool_result 消息"]

    TOOL_RESULT --> CHECK_TOKENS{"tokens 超限?"}
    CHECK_TOKENS -->|"是"| FINISH_MAX["finish('max_tokens')"]
    CHECK_TOKENS -->|"否"| LOOP

    LOOP -->|"❌ 超限"| FINISH_STEPS["finish('max_steps')"]

    FINISH --> END(["返回 RunTurnResult"])
    FINISH_MAX --> END
    FINISH_STEPS --> END

    style FINISH fill:#c8e6c9,stroke:#2e7d32
    style FINISH_STEPS fill:#ffcdd2,stroke:#c62828
    style FINISH_MAX fill:#ffcdd2,stroke:#c62828
```

核心设计：
- **同步 `runTurn()`** — 每次调用是一个完整的 turn，内部 while 循环处理多轮 tool call
- **test-loop 内置** — `testLoop.executor` 包装了 ToolExecutor，在执行 `execute_command` 后自动运行 `npm test`
- **中断保护** — `AbortSignal.any([callerSignal, durationTimer])`，超时或 Ctrl-C 优雅退出
- **ProviderStepError 带 partialContent** — stream 中断时保留已收集的文本和 tool_call 块，不丢失已完成的工作

---

## 3. 数据类型层级

```mermaid
classDiagram
    class ContentBlock {
        <<union>>
        TextBlock, ToolCallBlock, ToolResultBlock, ReasoningSummaryBlock
    }
    class TranscriptMessage {
        +id: string (UUID)
        +role: "user" | "assistant" | "system" | "tool"
        +content: ContentBlock[]
        +createdAt: string (ISO)
    }
    class Transcript {
        +messages: TranscriptMessage[]
        +system: string|null
    }
    class ToolDefinition {
        +name: string
        +description: string
        +inputSchema: JsonObject
    }
    class ProviderStreamEvent {
        <<union>>
        TextDelta, ReasoningSummaryDelta,
        ToolCall, Usage, ResponseCompleted
    }
    class RuntimeEvent {
        <<union>>
        turn_started, text_delta, tool_call_started,
        tool_call_finished, usage, error, turn_finished...
    }

    TranscriptMessage --> ContentBlock
    Transcript --> TranscriptMessage
    Provider --> ProviderStreamEvent
```

Key:
- `Transcript` 是 immutable 的 — 每次 append 返回新对象
- `ProviderStreamEvent` 是 Provider 向外暴露的流事件
- `RuntimeEvent` 是 Agent 向外 emit 的高级事件（含 protocolVersion, sequence, timestamp）

---

## 4. 配置体系 — 4 层合并

```mermaid
flowchart TD
    START["loadConfiguration()"] --> ENV["parseEnvironment()<br/>DUGSYN_PROVIDER / MODEL / CONTEXT_TOKENS"]
    ENV --> PATHS["resolvePaths()<br/>~/.dugsyn/config.json<br/>&lt;workspace&gt;/.dugsyn/config.json<br/>&lt;workspace&gt;/.dugsyn/config.local.json"]

    PATHS --> GLOBAL["加载 managed + user"]
    GLOBAL --> TRUST_CHECK{"WorkspaceTrust<br/>workspace in trustedRoots?"}
    TRUST_CHECK -->|"是"| PROJECT["加载 project + local 配置"]
    TRUST_CHECK -->|"否"| SKIP["跳过 project 配置<br/>记录 skippedFiles"]

    PROJECT --> MERGE["mergeConfiguration() 多层合并"]
    SKIP --> MERGE

    MERGE --> RULES["collectPermissionRules()<br/>按 managed/user/project 分组"]
    RULES --> OUT["返回 LoadedConfiguration"]

    style TRUST_CHECK fill:#fff3e0,stroke:#e65100
    style MERGE fill:#e3f2fd,stroke:#1565c0
```

合并优先级（后层覆盖前层）：
1. managed — 组织级策略（可设 teamPolicy）
2. user — `~/.dugsyn/config.json`
3. project — `<workspace>/.dugsyn/config.json`
4. local — `<workspace>/.dugsyn/config.local.json`
5. environment — `DUGSYN_*` 环境变量（最高优先级）

---

## 5. 模块导图

```
dugsyn/src/
├── cli/                   # CLI 入口（bin, chat, main, headless, renderer, session）
├── config/                # 配置加载（loader.ts, schema.ts）
├── context/               # 上下文管理（manager.ts, instructions.ts）
├── evals/                 # 评估运行器
├── extensions/            # 扩展（hooks, lsp, mcp, plugin, skills）
├── hosts/                 # 宿主适配（IDE 集成协议）
├── messages/              # 数据类型（blocks, schemas, transcript）
├── observability/         # 可观测性（trace, exporter）
├── protocol/              # 序列化（json, serde）
├── providers/             # Provider 实现（openai, deepseek, mock, http, sse）
├── runtime/               # Agent 运行时（agent, coding-agent, cancellation, events, test-loop）
├── security/              # 安全（permissions, trust, team-policy）
├── sessions/              # 会话持久化（store, export）
├── subagents/             # 子代理（coordinator, capabilities）
├── tools/                 # 工具系统（file, git, shell, testing, registry, executor）
└── version.ts
```
