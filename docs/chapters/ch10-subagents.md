# 第 10 章：子代理系统

> dugsyn 的子代理系统允许并行分派多个隔离任务，每个任务在自己的 Git worktree 中运行，完成后通过 merge 流程集成回主分支。写任务有 scope 限制和提交验证。

---

## 1. 架构总览

```mermaid
flowchart TB
    MAIN["主 Agent"] -->|"dispatch(tasks)"| COORD["SubagentCoordinator"]
    COORD --> TASK1["Task 1 (read)<br/>→ worktree 1"]
    COORD --> TASK2["Task 2 (write)<br/>→ worktree 2<br/>scope: src/"]
    COORD --> TASK3["Task 3 (write)<br/>→ worktree 3<br/>scope: test/"]

    TASK1 --> AG1["CodingAgentRuntime.runTurn()"]
    TASK2 --> AG2["CodingAgentRuntime.runTurn()"]
    TASK3 --> AG3["CodingAgentRuntime.runTurn()"]

    AG1 --> RESULT1["SubagentResult<br/>(只读，无 artifact)"]
    AG2 --> ARTIFACT2["SubagentArtifact<br/>{ baseCommit, branch, commit, changedFiles, diffSha256 }"]
    AG3 --> ARTIFACT3["SubagentArtifact"]

    ARTIFACT2 --> BATCH["SubagentBatch"]
    ARTIFACT3 --> BATCH
    BATCH --> INTEGRATE["integrate(testCommand)"]
    INTEGRATE -->|"成功"| MERGED["merged → 主分支"]
    INTEGRATE -->|"失败"| REJECTED["rejected: conflict / tests_failed / parent_changed"]
```

---

## 2. 任务类型

```typescript
interface SubagentTask {
  id: string;                    // 唯一标识
  prompt: string;                // 任务指令
  mode: "read" | "write";       // 只读 / 可写
  requestedTools: string[];      // 申请使用的工具
  writeScopes?: string[];        // 写入范围 (write 模式必填)
}
```

| 模式 | writeScopes | artifact | 验证 |
|------|-------------|----------|------|
| `read` | 不需要 | 无 | 无 |
| `write` | 必填，多任务不能重叠 | 有 | 提交文件必须在 scope 内 |

---

## 3. Worktree 隔离

```mermaid
flowchart TD
    BASE["baseCommit: HEAD"] --> CREATE["为每个 write task 创建 git worktree"]
    CREATE --> WT1["/tmp/dugsyn-xxx/task-1<br/>-- 独立 worktree"]
    CREATE --> WT2["/tmp/dugsyn-xxx/task-2<br/>-- 独立 worktree"]

    WT1 --> AGENT1["子 Agent 运行"]
    WT2 --> AGENT2["子 Agent 运行"]

    AGENT1 --> COMMIT["提交到 task branch"]
    AGENT2 --> COMMIT

    COMMIT --> VALIDATE["验证 changedFiles ⊆ writeScopes"]
    VALIDATE -->|"违规"| SCOPE_ERR["scope_violation → failed"]
```

每个 write 任务获得一个独立的 git worktree，在自己的 branch 上提交。完成后：
1. 验证所有变更文件在 `writeScopes` 内
2. 确保不是空提交
3. 生成 `SubagentArtifact` 引用

---

## 4. 能力削弱

```mermaid
flowchart TD
    PARENT["父 Agent 的 CapabilityGrant"] --> ATTEN["attenuateSubagentCapabilities()"]
    ATTEN --> FILTER["过滤: 只保留 requestedTools<br/>模式限制: read 不可有写工具"]
    FILTER --> SUB["EffectiveSubagentCapabilities<br/>-- tools: [...]<br/>-- maxSteps: ...<br/>-- sideEffects: ..."]
```

子代理的能力是父代理的子集 — 通过 `requestedTools` 白名单和 `mode` 限制衰减。即使父 Agent 有完整权限，子 Agent 也只能用申请的工具。

---

## 5. 集成流程

```mermaid
sequenceDiagram
    participant Coordinator
    participant Parent as Parent Git (主分支)
    participant Integration as Integration Worktree
    participant Test as 集成测试

    Coordinator->>Coordinator: 所有 write tasks 完成
    Coordinator->>Parent: 检查 HEAD == baseCommit
    Parent-->>Coordinator: ✓ 未变化
    Coordinator->>Parent: 检查 status 干净
    Parent-->>Coordinator: ✓ 无未提交变更
    Coordinator->>Integration: worktree add --detach
    loop 每个 artifact
        Coordinator->>Integration: merge --no-ff artifact.commit
    end
    Coordinator->>Test: 运行集成测试命令
    alt 测试通过
        Coordinator->>Parent: merge --ff-only integrationHead
        Parent-->>Coordinator: merged ✓
    else 测试失败 / 冲突
        Coordinator-->>Coordinator: rejected
    end
```

集成是原子操作：所有子任务都成功后，在一个 integration worktree 中合并所有 branch，运行集成测试，最后 fast-forward 到主分支。

---

## 6. Batch 与 dispose

```mermaid
flowchart LR
    CREATE["SubagentCoordinator.runBatch(tasks)"] --> B["SubagentBatch"]
    B --> INT["batch.integrate(command)"]
    B --> DISPOSE["batch.dispose()"]
    DISPOSE --> CLEAN["清理所有 worktrees<br/>删除临时目录<br/>删除 task branches"]
```

必须显式调用 `dispose()` 清理 worktree 和临时文件。不调用会导致 `/tmp` 下残留大量 worktree 目录。

---

## 7. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/subagents/coordinator.ts` | SubagentCoordinator + SubagentBatch |
| `dugsyn/src/subagents/capabilities.ts` | 能力衰减逻辑 |
| `dugsyn/src/runtime/coding-agent.ts` | CodingAgentRuntime — 子 Agent 运行时 |
| `dugsyn/src/tools/git/adapter.ts` | GitAdapter — 被 coordinator 复用 |
