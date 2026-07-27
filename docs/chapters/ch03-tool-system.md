# 第 3 章：工具系统

> dugsyn 的工具系统采用 4 道闸门的注册-分发模型，集成权限检查、循环检测和 Hook 生命周期。

---

## 1. 工具契约 — 3 个组成部分

```mermaid
classDiagram
    class ToolDefinition {
        +name: string
        +description: string
        +inputSchema: JsonObject
    }
    class ToolSideEffect {
        <<enumeration>>
        read_workspace
        write_workspace
        execute_process
        network
    }
    class ToolHandlerContext {
        +signal: AbortSignal
        +maxOutputBytes: number
    }
    class ToolHandlerOutput {
        +content: string
        +data?: JsonValue
        +nextCursor?: string
    }
    class Tool {
        +definition: ToolDefinition
        +sideEffects: ToolSideEffect[]
        +handler(input, context) Promise~ToolHandlerOutput~
    }
    Tool --> ToolDefinition
    Tool --> ToolSideEffect
    Tool --> ToolHandlerOutput
```

关键设计：
- **`handler` 是 async** — 支持异步操作（文件 IO、shell、网络）
- **`nextCursor` 分页** — 长输出可分段返回，tool handler 自定 cursor 格式
- **`sideEffects` 四分类** — 权限系统据此决定是否需要批准

---

## 2. ToolRegistry — 4 道闸门

```mermaid
flowchart TD
    A["execute(call, context)"] --> G1{"Gate 1: name 存在?"}
    G1 -->|"否"| ERR1["unknown_tool error"]
    G1 -->|"是"| G2{"Gate 2: args 匹配 schema?"}
    G2 -->|"否"| ERR2["invalid_arguments error<br/>+ AJV 校验详情"]

    G2 -->|"是"| G3{"Gate 3: 权限通过?"}
    G3 -->|"否"| ERR3["permission_denied error"]
    G3 -->|"是"| G4{"Gate 4: 循环检测?"}

    G4 -->|"> 3 次相同调用"| ERR4["repeated_call error"]
    G4 -->|"通过"| HOOK_PRE["PreToolUse hook"]
    HOOK_PRE --> EXEC["handler(input, context)"]

    EXEC -->|"成功"| HOOK_POST["PostToolUse hook"]
    EXEC -->|"失败"| HOOK_FAIL["PostToolUseFailure hook"]

    HOOK_POST --> OK["ToolResultBlock{status:'success'}"]
    HOOK_FAIL --> ERR5["ToolResultBlock{status:'error'}"]

    style ERR1 fill:#f8d7da,stroke:#c62828
    style ERR2 fill:#f8d7da,stroke:#c62828
    style ERR3 fill:#f8d7da,stroke:#c62828
    style ERR4 fill:#f8d7da,stroke:#c62828
    style ERR5 fill:#f8d7da,stroke:#c62828
    style OK fill:#d4edda,stroke:#2e7d32
```

所有闸门返回结构化 `ToolResultBlock`（非抛异常），模型读到错误信息后自行纠正。

---

## 3. 循环检测

```mermaid
flowchart LR
    C1["call: bash({cmd:'ls'})"] --> KEY["key: bash:{cmd:ls}"]
    C2["call: bash({cmd:'ls'})"] --> KEY
    C3["call: bash({cmd:'ls'})"] --> KEY
    C4["call: bash({cmd:'ls -la'})"] --> KEY2["key: bash:{cmd:ls -la} — 参数不同，不计数"]

    KEY --> COUNT{"count > maxIdenticalCalls (3)?"}
    COUNT -->|"是"| BLOCK["repeated_call error"]
```

使用 `canonicalJson()` 排序 key → 语义相同但顺序不同的 JSON 视为同一调用。

---

## 4. ToolExecutor vs ToolRegistry

```mermaid
flowchart LR
    REG["ToolRegistry<br/>-- 持有所有 tool + 全局状态"] -->|"createExecutor()"| EXEC["ToolExecutor<br/>-- 每个 turn 一个实例<br/>-- 持有独立 callCounts"]

    EXEC --> DEF["definitions: ToolDefinition[]"]
    EXEC --> EXEC_FN["execute(call, context)"]
```

**Registry 是单例，Executor 是 turn-local**。这样每个 turn 的循环检测计数独立，上一个 turn 的重复调用不影响当前 turn。

---

## 5. 工具结果工厂

| 函数 | 说明 |
|------|------|
| `createToolSuccessResult(id, output)` | 截断 content 到 `maxOutputBytes` |
| `createToolErrorResult(id, status, message)` | 结构化错误：`unknown_tool` / `invalid_arguments` / `permission_denied` / `repeated_call` / `execution_failed` |

`ToolHandlerOutput` 返回 `{ content, data?, nextCursor? }`。`data` 是任意 JSON value，用于传递机器可读的结构化数据给 model。

---

## 6. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/tools/tool.ts` | Tool / ToolDefinition / ToolSideEffect 类型定义 |
| `dugsyn/src/tools/registry.ts` | ToolRegistry — 注册、4 道闸门 dispatch、Hook 集成 |
| `dugsyn/src/tools/executor.ts` | ToolExecutor 接口 — turn-local 执行器 |
| `dugsyn/src/tools/result.ts` | ToolResultBlock 工厂函数 + 截断逻辑 |
ENDDOFDOC
echo "Written ch03-tool-system.md"