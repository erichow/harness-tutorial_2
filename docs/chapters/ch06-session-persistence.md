# 第 6 章：会话持久化

> dugsyn 的 session 系统支持创建、恢复、fork、导出，通过 append-only 日志 + 文件锁实现崩溃安全。

---

## 1. Session 生命周期

```mermaid
stateDiagram-v2
    [*] --> Created: createSession()
    Created --> Active: appendMessage() / appendEvent()
    Active --> Completed: 用户 /exit
    Active --> Crashed: 进程意外退出
    Crashed --> Active: resume()
    Active --> Forced: forkSession()
    Forced --> Active

    Active --> Exported: session export
    Exported --> [*]
```

---

## 2. 存储结构

```
<sessionDirectory>/
  <sessionId>/
    metadata.json     # SessionMetadata (id, name, provider, model, parent...)
    transcript.log    # append-only: 每行一个 message record
    events.log        # append-only: 每行一个 runtime event record
    lock              # 进程锁文件 (含 PID + token)
```

```mermaid
flowchart TD
    META["metadata.json<br/>{ schemaVersion, sessionId, name, projectPath, provider, model, createdAt, updatedAt, parentSessionId? }"] --> STORE["SessionStore"]
    TRANS["transcript.log<br/>每行: { schemaVersion, type:'message', sequence, recordedAt, message }"] --> STORE
    EVENTS["events.log<br/>每行: { schemaVersion, type:'runtime_event', sequence, recordedAt, event }"] --> STORE

    STORE --> SNAPSHOT["SessionSnapshot<br/>{ metadata, transcript, events }"]
```

---

## 3. Append-Only 日志

```mermaid
flowchart LR
    W["writeFile(path, JSON(line)+'\n')"] --> APPEND["以 append 模式打开"]
    APPEND --> FLUSH["立即 fsync"]
    FLUSH --> SEQ["sequence 自增"]

    READ["加载时"] --> PARSE["逐行 parse JSON"]
    PARSE --> SKIP["跳过非法行（不污染 session）"]
    SKIP --> BUILD["重建 transcript + events 数组"]
```

设计要点：
- **每行是独立 JSON**，不需要一次读完整个文件
- **sequence 号单调递增**，用于检测丢失
- **非法行静默跳过**，不破坏 session

---

## 4. SessionStore 操作

| 操作 | 方法 | 说明 |
|------|------|------|
| 创建 | `create(options)` | 生成 UUID sessionId + 写 metadata |
| 加载 | `load(sessionId)` | 读取 metadata + replay 日志 → Snapshot |
| 追加消息 | `appendMessage(sessionId, message)` | 写入 transcript.log |
| 追加事件 | `appendEvent(sessionId, event)` | 写入 events.log |
| 更新元数据 | `updateMetadata(sessionId, patch)` | 原子更新 metadata.json |
| Fork | `fork(parentId, options)` | 复制父 session 元数据 |
| 列出 | `list()` | 读取所有 session 目录的 metadata |
| 删除 | `delete(sessionId)` | 删除 session 目录 |

---

## 5. Fork 语义

```mermaid
flowchart TD
    PARENT["父 session<br/>provider=openai, model=gpt-5"] --> FORK["forkSession(parentId, {provider:'deepseek'})"]
    FORK --> CHILD["子 session<br/>-- 继承: transcript 当前状态<br/>-- 可覆盖: provider, model, name<br/>-- 记录: parentSessionId"]
```

Fork 不是复制文件 — 子 session 有自己的 transcript.log，从父的当前状态开始。

---

## 6. 进程锁

```mermaid
flowchart LR
    ACQUIRE["获取锁"] --> TRY["try: 创建 lock 文件<br/>写 PID + token"]
    TRY --> EXISTS{"文件已存在?"}
    EXISTS -->|"否"| OWN["获得锁"]
    EXISTS -->|"是"| CHECK["读 lock → 检查 PID 是否存活"]
    CHECK -->|"存活"| WAIT["等待或拒绝"]
    CHECK -->|"已死"| STEAL["覆盖 lock → 获得锁"]
```

同一个 session 不能同时被两个进程打开。锁防止并发写破坏 append-only 日志。

---

## 7. 导出

```mermaid
flowchart TD
    EXPORT["session export <id>"] --> LOAD["加载 Snapshot"]
    LOAD --> SERIALIZE["JSON.stringify(snapshot)"]
    SERIALIZE --> OUTPUT["stdout 或文件"]
```

导出的是完整快照 — metadata + transcript + events，可用于迁移或存档。

---

## 8. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/sessions/store.ts` | SessionStore — 创建/加载/fork/导出/锁管理 |
| `dugsyn/src/sessions/export.ts` | 会话导出逻辑 |
| `dugsyn/src/messages/transcript.ts` | Transcript 类型 + 工厂 |
| `dugsyn/src/messages/blocks.ts` | ContentBlock 联合类型 |
| `dugsyn/src/messages/schemas.ts` | Zod schema (用于日志行校验) |
| `dugsyn/src/runtime/event-schemas.ts` | RuntimeEvent Zod schema |
