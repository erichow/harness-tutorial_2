# 第 5 章：Shell 执行与沙箱

> dugsyn 的 shell 工具支持执行任意命令、超时控制、输出截断、进程生命周期管理和跨平台沙箱隔离。

---

## 1. 执行架构

```mermaid
flowchart TD
    MODEL["模型调用 execute_command"] --> TOOL["shell tool handler"]
    TOOL --> VALIDATE["参数校验<br/>command 必填<br/>timeout 上限 300s"]
    VALIDATE --> SANDBOX{"沙箱模式?"}
    SANDBOX -->|"是"| RUNNER["SandboxRunner<br/>-- 限制文件系统访问<br/>-- 网络隔离"]
    SANDBOX -->|"否"| PASSTHROUGH["直接 exec"]
    RUNNER --> MANAGE["ProcessManager<br/>-- PID 跟踪<br/>-- 优雅 kill → SIGTERM → SIGKILL"]
    PASSTHROUGH --> MANAGE
    MANAGE --> TRUNC["OutputManager<br/>-- maxOutputBytes 截断<br/>-- stderr/stdout 分离"]
    TRUNC --> RESULT["ToolHandlerOutput"]
```

---

## 2. ProcessManager — 进程生命周期

```mermaid
stateDiagram-v2
    [*] --> Running: exec
    Running --> Completed: exit 0
    Running --> TimedOut: timeout 秒未完成
    Running --> Killed: 外部取消/中断
    TimedOut --> Terminating: SIGTERM
    Terminating --> ForceKilled: 3s 后 SIGKILL
    Killed --> [*]
    Completed --> [*]
    ForceKilled --> [*]
```

- 每个进程通过 PID 跟踪
- timeout → `SIGTERM`，3 秒后 `SIGKILL`
- 工具返回时保证进程已结束或已 kill

---

## 3. 沙箱运行器 — SandboxRunner

```mermaid
flowchart TD
    REQ["execute_command({cmd})"] --> CHECK{"平台支持?"}
    CHECK -->|"macOS"| SEATBELT["sandbox-exec<br/>-- 限制文件写入<br/>-- 网络规则"]
    CHECK -->|"Linux"| BUBBLEWRAP["bwrap<br/>-- 只读 rootfs<br/>-- tmpfs /tmp"]
    CHECK -->|"不支持"| NATIVE["原生执行<br/>-- 信任 workspace"]

    SEATBELT --> EXEC["在限制内执行命令"]
    BUBBLEWRAP --> EXEC
    NATIVE --> EXEC
```

沙箱不是强制安全边界 — 它是防御层。真正的安全由 permission engine 控制。

---

## 4. 输出管理

| 策略 | 说明 |
|------|------|
| `maxOutputBytes` | 输出截断上限（默认值来自 registry options） |
| stdout/stderr 捕获 | 两个流独立收集 |
| 截断标记 | 超出限制时追加 `[output truncated at N bytes]` |
| 超时信息 | `Command timed out after N seconds` |

---

## 5. 中断保护

```mermaid
sequenceDiagram
    participant Agent as Agent Loop
    participant Tool as Shell Tool
    participant Proc as 子进程

    Agent->>Tool: execute_command(cmd, {signal})
    Tool->>Proc: spawn(cmd)

    Note over Agent: 用户按 Ctrl-C
    Agent->>Tool: signal.abort()
    Tool->>Proc: kill(SIGTERM)
    Proc-->>Tool: 进程终止
    Tool-->>Agent: ToolResultBlock{status:'error'}
```

---

## 6. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/tools/shell/index.ts` | Shell 工具 handler + 参数校验 |
| `dugsyn/src/tools/shell/process-manager.ts` | 进程生命周期管理 + PID 跟踪 |
| `dugsyn/src/tools/shell/sandbox-runner.ts` | 跨平台沙箱执行 |
| `dugsyn/src/tools/shell/output.ts` | 输出截取与格式化 |
