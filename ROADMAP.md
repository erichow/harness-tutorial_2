# Harness 架构全景 · 第 1-22 章

## 全景思维导图

每个章节右侧标了它在环中的位置。

```mermaid
mindmap
  root((Agent Harness))
    第一部分：基础
      第1章_项目骨架
      第2章_Agent概念与最小循环
      第3章_类型消息
    第二部分：工具与执行
      第4章_工具协议
      第5章_流式_中断_错误
      第6章_安全工具执行
    第三部分：上下文工程
      第7章_上下文窗口记账
      第8章_压缩
      第9章_外部状态_Scratchpad
      第10章_检索
      第11章_为模型设计的工具
    第四部分：规模化
      第12章_动态工具加载
      第13章_MCP外部工具
      第14章_沙箱与权限
    第五部分：多智能体
      第15章_子智能体
      第16章_结构化计划
      第17章_并行执行
    第六部分：生产化
      第18章_可观测性(OTel)
      第19章_评测(Evals)
      第20章_成本控制
      第21章_可恢复与持久化
    第七部分：收束
      第22章_什么能迁移
```

## 一图纵览：ReAct 环 → Harness

整个 Harness 所有子系统的**顺序**和**位置**都在这个环里了。①-⑪ 是每回合的流水线。
```mermaid

flowchart LR

%% 统一定义样式类
classDef observe fill:#FED7D7,stroke:#C53030
classDef reason fill:#FEEBC8,stroke:#C05621
classDef act fill:#BEE3F8,stroke:#2B6CB0
Observe --> Reason --> Act --> Observe
%% 绑定样式类

class Observe observe
class Reason reason
class Act act

```

```mermaid
flowchart LR

%% 统一定义样式类 — 每步一种语义色
classDef global   fill:#F5F5F5,stroke:#9E9E9E,stroke-dasharray: 5 5
classDef sel      fill:#F3E5F5,stroke:#7B1FA2
classDef snap     fill:#FFF3E0,stroke:#E65100
classDef compact  fill:#FBE9E7,stroke:#BF360C
classDef reason   fill:#E3F2FD,stroke:#1565C0
classDef decide   fill:#F3E5F5,stroke:#6A1B9A
classDef validate fill:#E0F2F1,stroke:#00695C
classDef perms    fill:#EDE7F6,stroke:#4527A0
classDef exec     fill:#E8EAF6,stroke:#283593
classDef append   fill:#E8F5E9,stroke:#2E7D32
classDef plan     fill:#F9FBE7,stroke:#827717
classDef output   fill:#E8F5E9,stroke:#1B5E20
classDef error    fill:#FFEBEE,stroke:#C62828


subgraph Observe[Observe — 每回合前准备]
    direction TB
    Sel[① ToolCatalog<br/>select Top-K<br/>§12]
    Snap[② Accountant<br/>snapshot<br/>§7]
    Compact[③ Compactor<br/>mask→summarize<br/>§8]
    Sel --> Snap
    Snap -->|red| Compact
    Compact -.->|retry| Snap
end

Snap -->|green/yellow| Reason

Reason[④ Reason<br/>Adapter → Provider 流式<br/>§3·§5] --> Decide

Decide{⑤ Decide<br/>§2} -->|isToolCall| V

V{⑥ 校验闸门<br/>§4} -->|name 不存在| Error
V -->|args 不符 schema| Error
V -->|通过| P{⑦ Permission<br/>通过?<br/>§14}

P -->|否| Error
P -->|是| Exec[⑧ Execute Tool<br/>sync / async / MCP<br/>§4·§13]

Exec --> Append[⑨ append 结果<br/>到 Transcript<br/>§3] --> Sel

Decide -->|isFinal| PlanOK{⑩ Plan<br/>完成?<br/>§16}
PlanOK -->|否| Feedback[合成提示<br/>继续 loop] --> Sel
PlanOK -->|是| Output[⑪ 返回最终答案]

subgraph Act[Act — 执行层]
    Decide
    Error
    Output
    V
    P
    Exec
    Append
    PlanOK
    Feedback
end


%% Global ~~~ Observe

%% subgraph Global[⓪ 全局支撑 · 循环启动前构建]
%%     direction LR
%%     Reg
%%     Msg
%% end

%% subgraph Reg[⓪ Registory Tool · §4 ]
%%     R1[name + description]
%%     R2[input_schema]
%%     R3[side_effect tag]
%% end

%% subgraph Msg[⓪ Message System · §3 ]
%%     B1[TextBlock]
%%     B2[ToolCall]
%%     B3[ToolResult]
%%     B4[ReasoningBlock]
%% end


%% 绑定样式类
class Global global
class Reg global
class Msg global
class Sel sel
class Snap snap
class Compact compact
class Reason reason
class Decide decide
class V validate
class P perms
class Exec exec
class Append append
class PlanOK plan
class Feedback plan
class Output output
class Error error
```

---

## 第一部分：基础（第 1-3 章）

```mermaid
flowchart LR
    subgraph "第1章 · 项目骨架"
        A1[Package.json<br/>TypeScript + Vitest<br/>项目结构]
    end

    subgraph "第2章 · Agent概念与最小循环"
        A2["Model + Loop + Tools<br/>= Agent<br/>Provider.complete<br/>while loop<br/>同步 run()"]
    end

    subgraph "第3章 · 类型消息"
        A3[4种Block: Text<br/>ToolCall<br/>ToolResult<br/>Reasoning<br/>Message + Transcript]
    end

    A1 --> A2 --> A3
```

### 关键概念流

```mermaid
flowchart TB
    Input([用户输入]) --> Loop

    subgraph Loop["2.Loop"]
        direction TB
        L1["response = provider.complete(transcript)"]
        L2{"final?"}
        L3{"tool_call?"}
        L4["execute 工具"]
        L5["iter++ 继续循环"]

        L1 --> L2
        L2 -- 否 --> L3
        L3 -- 是 --> L4 --> L5 --> L1
        L3 -- 否 --> L5
    end

    L2 -- 是 --> Final([返回最终回复])

    Loop -.-> Transcript

    subgraph Transcript["3.Transcript"]
        direction TB
        T1["user text"]
        T2["assistant tool_calls"]
        T3["tool_result"]
        T1 --> T2 --> T3
    end
```

---

## 第二部分：工具与执行（第 4-6 章）

```mermaid
flowchart LR
    subgraph "第4章 · 工具协议"
        T4[ToolDefinition<br/>name + description + inputSchema<br/>ToolHandler 函数<br/>ToolRegistry]
    end

    subgraph "第5章 · 流式与中断"
        T5["astream 流式事件<br/>TextDelta | ToolCallDelta<br/>5种 StreamEvent<br/>arun async loop<br/>中断恢复"]
    end

    subgraph "第6章 · 安全执行"
        T6[4道闸门<br/>1. 工具存在?<br/>2. Schema校验<br/>3. 循环检测<br/>4. Try/Execute<br/>Did you mean? 建议]
    end

    T4 --> T5 --> T6
```

### execute() 的 4 道闸门

```mermaid
flowchart TB
    Input([工具调用]) --> G1

    G1{"闸门 1:<br/>name 存在?"}
    G1NO["→ unknown<br/>Did you mean calc?"]
    G2{"闸门 2:<br/>args ⊃ schema?"}
    G2NO["→ validation error"]
    G3{"闸门 3:<br/>去重器?<br/>连续3次相同调用"}
    G3YES["→ 换策略"]
    G4{"闸门 4:<br/>execute"}
    G4ERR["← 异常 →<br/>error result<br/>try/catch"]
    DONE["ToolResultBlock"]

    G1 -- 否 --> G1NO
    G1 -- 是 --> G2
    G2 -- 否 --> G2NO
    G2 -- 是 --> G3
    G3 -- 是 --> G3YES
    G3 -- 否 --> G4
    G4 -- 异常 --> G4ERR
    G4 -- 成功 --> DONE
```

---

## 第三部分：上下文工程（第 7-11 章）

```mermaid
flowchart LR
    subgraph "第7章 · 记账"
        C7[ContextAccountant<br/>snapshot 三态<br/>green / yellow / red<br/>ContextBudget]
    end

    subgraph "第8章 · 压缩"
        C8[Compactor<br/>maskOlderResults<br/>summarizePrefix<br/>red → compact]
    end

    subgraph "第9章 · Scratchpad"
        C9[Scratchpad<br/>write / read / list<br/>文件系统 KV<br/>防 ../ 遍历]
    end

    subgraph "第10章 · 检索"
        C10[DocumentIndex<br/>BM25 Okapi<br/>search_docs 工具<br/>Edge placement]
    end

    subgraph "第11章 · ACI工具"
        C11[readFileViewport<br/>100行窗口 + 行号<br/>editLines<br/>Envelope footer<br/>描述6项checklist]
    end

    C7 --> C8
    C8 -.->|压缩不了<br/>外部状态| C9
    C9 -.->|检索也不是<br/>自己写的| C10
    C10 --> C11
```

### 上下文生命周期

```mermaid
flowchart TB
    subgraph "每回合"
        direction TB
        SNAPSHOT["1. Accountant.snapshot()"]
        GREEN["green → 继续"]
        YELLOW["yellow → 警告"]
        RED["red → Compactor.compact()"]
        MASK["maskOlderResults<br/>隐藏旧工具结果"]
        SUMM["summarizePrefix<br/>总结旧轮次"]

        SNAPSHOT --> GREEN
        SNAPSHOT --> YELLOW
        SNAPSHOT --> RED
        RED --> MASK
        RED --> SUMM
    end

    subgraph "2. 新内容写入 transcript"
        T1["assistant 消息"]
        T2["tool_call 消息"]
        T3["tool_result 消息"]
        T1 --> T2 --> T3
    end

    subgraph "3. 重要的东西不在 transcript"
        O1["Scratchpad<br/>磁盘文件"]
        O2["DocumentIndex<br/>BM25检索"]
        O3["下一回合 agent<br/>引用/检索回来"]
        O1 --- O2 --- O3
    end

    SNAPSHOT -.->|写入| T1
    T3 -.->|存不下的| O1
    T3 -.->|搜不到的| O2
```

---

## 第四部分：规模化（第 12-14 章）

```mermaid
flowchart LR
    subgraph "第12章 · 动态加载"
        S12["ToolCatalog<br/>BM25 索引工具名+描述<br/>select(query, k, pinned)<br/>queryFromTranscript<br/>list_available_tools 钉死"]
    end

    subgraph "第13章 · MCP"
        S13[MCPClient<br/>JSON-RPC 2.0 over stdio<br/>mcp__server__tool 前缀<br/>wrapMcpTools<br/>AsyncToolHandler]
    end

    subgraph "第14章 · 权限"
        S14[PermissionManager<br/>Policy: allow/deny/ask<br/>pathAllowlist<br/>bySideEffect<br/>trust label<br/>executeAsync 5道闸]
    end

    S12 -->|"选中的工具"| S13
    S13 -->|"外部工具需要权限"| S14
```

### 第 12 章：每回合工具选择流程

```mermaid
flowchart TB
    CATALOG["完整 Catalog<br/>(30 tools)"]
    PINNED["pinned: list_available_tools<br/>永远钉死"]
    BM25["BM25.select(query, k=7)"]
    QUERY["query = queryFromTranscript(transcript)<br/>= 首条user消息 + 最近3条assistant消息"]
    SELECTED["选中的 7 个工具 → 临时 ToolRegistry"]
    MODEL["模型看到 7 个工具<br/>→ schema 占 token 少 75%"]

    CATALOG --> PINNED
    CATALOG --> BM25
    QUERY -.-> BM25
    BM25 --> SELECTED --> MODEL
```

### 第 14 章：executeAsync 的 5 道闸门

```mermaid
flowchart TB
    Input([工具调用]) --> G1

    G1["闸门 1: name 存在?"]
    G2["闸门 2: args ⊃ schema?"]
    G25{"闸门 2.5:<br/>permission 通过?<br/>← 第14章新增"}
    ALLOW["allow → 继续"]
    DENY["deny → 返回错误"]
    ASK["ask → 暂停，等人批准<br/>→ 缓存到 session"]
    G3["闸门 3: 去重器?"]
    G4["闸门 4: execute"]
    TRUST["trust label:<br/>MCP 输出包 &lt;untrusted_content&gt;"]
    DONE["ToolResultBlock"]

    G1 --> G2 --> G25
    G25 -- allow --> ALLOW --> G3
    G25 -- deny --> DENY
    G25 -- ask --> ASK
    G3 --> G4 --> TRUST --> DONE
```

---

## 第五部分：多智能体（第 15 章）

```mermaid
flowchart TB
    subgraph "第15章 · 子智能体"
        M15[Sub-agent<br/>独立 Transcript<br/>独立工具集<br/>独立 Context Window<br/>3种模式]
    end

    subgraph "1. 委托模式"
        D1[父 agent 派发任务<br/>→ Sub-agent 执行<br/>→ 返回结果]
    end

    subgraph "2. 扇出模式"
        D2[父 agent<br/>├→ Sub A: 搜索<br/>├→ Sub B: 分析<br/>└→ Sub C: 测试<br/>→ 合并结果]
    end

    subgraph "3. 管线模式"
        D3[Sub A 分析<br/>→ Sub B 修复<br/>→ Sub C 验证<br/>⚠ 串联累计错误]
    end

    M15 --> D1
    M15 --> D2
    M15 --> D3
```

---

## 完整架构总览

```mermaid
flowchart TB
    subgraph "Layer 1: 消息与循环"
        L1a["Provider (API)"]
        L1b["Transcript (消息容器)"]
        L1c[arun 循环]
    end

    subgraph "Layer 2: 工具系统"
        L2a["ToolRegistry<br/>4道闸门"]
        L2b["ToolCatalog<br/>BM25 动态选择"]
        L2c["MCPClient<br/>外部工具"]
        L2d["PermissionManager<br/>5道闸门"]
    end

    subgraph "Layer 3: 上下文管理"
        L3a["ContextAccountant<br/>记账"]
        L3b["Compactor<br/>压缩"]
        L3c["Scratchpad<br/>外部状态"]
        L3d["DocumentIndex<br/>检索"]
    end

    subgraph "Layer 4: 工具设计"
        L4a["readFileViewport<br/>100行视口"]
        L4b["editLines<br/>行范围编辑"]
        L4c["ACI Envelope<br/>显式外壳"]
    end

    subgraph "Layer 5: 多智能体"
        L5["Sub-agent<br/>独立循环"]
    end

    L1c --> L2a
    L1c --> L2b
    L1c --> L2c
    L1c --> L2d
    L1c --> L3a
    L3a --> L3b
    L3b -.->|压缩不了| L3c
    L3b -.->|压缩不了| L3d
    L2a --> L4a
    L2a --> L4b
    L1c --> L5
```



## 数据流全景

```mermaid
flowchart TB
    User([用户消息]) --> Layer1

    subgraph Layer1["Layer 1: 循环 (arun)"]
        direction TB
        S1["① ToolCatalog.select(query)<br/>← 第12章 BM25 选工具"]
        S2["② create turnRegistry<br/>← 第12章 临时注册"]
        S3["③ Accountant.snapshot()<br/>← 第7章 上下文记账"]
        S4{"④ red?"}
        S5["Compactor.compact()<br/>← 第8章 压缩"]
        S6["⑤ Provider.astream()<br/>← 第5章 流式调用 LLM"]
        S7["⑥ accumulate() → response<br/>← 第5章 攒成消息"]
        S8{"⑦ tool_call?"}

        S1 --> S2 --> S3 --> S4
        S4 -- 是 --> S5 --> S6
        S4 -- 否 --> S6
        S6 --> S7 --> S8
    end

    S8 -- 是 --> Layer2

    subgraph Layer2["Layer 2: 工具派发 (executeAsync)"]
        direction TB
        G1["闸门 1: name 存在?"]
        G1ERR["→ unknown 错误"]
        G2["闸门 2: Schema 校验<br/>← 第6章"]
        G2ERR["→ validation 错误"]
        G25["闸门 2.5: Permission check<br/>← 第14章 allow/deny/ask"]
        G25ERR["→ deny 错误 / ask 暂停"]
        G3["闸门 3: Loop detection<br/>← 第6章 连续重复检测"]
        G3ERR["→ 建议换策略"]
        G4{"闸门 4: Execute"}
        LOCAL["本地工具: handler(args)"]
        MCP["MCP工具: client.call()<br/>← 第13章"]
        TRUST["wrapIfUntrusted<br/>← 第14章 trust label"]

        G1 -- 不存在 --> G1ERR
        G1 -- 存在 --> G2
        G2 -- 不通过 --> G2ERR
        G2 -- 通过 --> G25
        G25 -- 拒绝 --> G25ERR
        G25 -- 允许 --> G3
        G3 -- 命中重复 --> G3ERR
        G3 -- 通过 --> G4
        G4 --> LOCAL
        G4 --> MCP
        LOCAL --> TRUST
        MCP --> TRUST
    end

    TRUST --> Layer3

    subgraph Layer3["Layer 3: 结果处理"]
        R1["ToolResult → transcript.append()"]
        R2["Accountant 记账<br/>(token 变多)"]
        R3["→ 下一回合回到 Layer 1"]
        R1 --> R2 --> R3
    end

    S8 -- 否 --> Final([返回最终回复])
    Layer3 -.->|下一轮| S1
```

---

## 各章节贡献的代码组件

| 章节 | 核心组件 | 位置 |
|------|----------|------|
| ch1 | 项目骨架、tsconfig、vitest | `package.json`、`tsconfig.json` |
| ch2 | `run()`、`Provider` 接口 (含 Agent 概念) | `src/harness/agent.ts` |
| ch3 | `Message`、`Transcript`、4 种 Block | `src/harness/messages.ts` |
| ch4 | `ToolRegistry`、`ToolDefinition`、`ToolHandler` | `src/harness/tools/registry.ts` |
| ch5 | `arun()`、`StreamEvent`、`accumulate()` | `src/harness/agent.ts`、`providers/` |
| ch6 | Schema 校验、循环检测、`Did you mean?` | `src/harness/tools/registry.ts` |
| ch7 | `ContextAccountant`、`ContextBudget`、`ContextSnapshot` | `src/harness/context/accountant.ts` |
| ch8 | `Compactor`、`maskOlderResults`、`summarizePrefix` | `src/harness/context/` |
| ch9 | `Scratchpad`（write/read/list） | `src/harness/tools/scratchpad.ts` |
| ch10 | `DocumentIndex`（BM25）、`search_docs` | `src/harness/retrieval/` |
| ch11 | `readFileViewport`、`editLines`、Envelope | `src/harness/tools/files.ts` |
| ch12 | `ToolCatalog`、`queryFromTranscript`、`createDiscoveryEntry` | `src/harness/tools/selector.ts` |
| ch13 | `MCPClient`、`wrapMcpTools` | `src/harness/mcp/` |
| ch14 | `PermissionManager`、Policy、trust label | `src/harness/permissions/` |
| ch15 | Sub-agent 概念与设计模式 | 文档 |
| ch16 | `Planner`、`PlanStep`、结构化计划 | `src/harness/plans/` |
| ch17 | 并行执行概念与设计模式 | 文档 |
| ch18 | `ObservabilityExporter`、Tracing spans | `src/harness/observability/` |
| ch19 | `EvalRunner`、trace-based eval | `src/harness/evals/` |
| ch20 | `CostRouter`、cost enforcer | `src/harness/cost/` |
| ch21 | `CheckpointManager`、resume/serialize | `src/harness/checkpoint/` |
| ch22 | 多 provider 迁移策略 | 文档 |

