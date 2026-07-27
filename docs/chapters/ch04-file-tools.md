# 第 4 章：文件工具集

> dugsyn 的文件操作不直接用 `readFile` / `writeFile`，而是通过安全检查层 — 路径守卫、敏感文件拦截、分页输出、结构化 diff 和 checkpoint 回滚。

---

## 1. 工具一览

```mermaid
flowchart LR
    subgraph "文件工具"
        READ["read_file<br/>-- 读 UTF-8 文件<br/>+ 分页支持"]
        WRITE["write_file<br/>-- 覆盖写文件<br/>自动建父目录"]
        PATCH["apply_patch<br/>-- 结构化补丁<br/>read→edit→write"]
        DIFF["show_diff<br/>-- git diff 风格<br/>工作区变更"]
        CP["checkpoint<br/>-- 创建/列出/恢复<br/>工作区快照"]
    end

    READ --> PG["path-guard.ts<br/>路径安全检查"]
    WRITE --> PG
    PATCH --> PG
    DIFF --> PG

    PG --> POLICY["policy.ts<br/>敏感文件拦截"]
    PG --> CURSOR["cursor.ts<br/>分页读支持"]
```

---

## 2. 路径守卫 (path-guard)

```mermaid
flowchart TD
    INPUT["用户/模型传入 path"] --> NORM["normalize + resolve<br/>相对 workspace 根"]
    NORM --> INSIDE{"在 workspace 内?"}
    INSIDE -->|"否"| REJECT["拒绝: 路径越界"]
    INSIDE -->|"是"| SENSITIVE{"撞敏感文件名单?"}
    SENSITIVE -->|"是"| REJECT_S["拒绝: 敏感路径"]
    SENSITIVE -->|"否"| ALLOW["放行"]

    style REJECT fill:#ffcdd2
    style REJECT_S fill:#ffcdd2
    style ALLOW fill:#c8e6c9
```

敏感路径包括：`.git/`, `.env`, `.env.local`, `credentials`, 所有以 `.` 开头的密钥类文件。

---

## 3. apply_patch — 结构化编辑

```mermaid
flowchart TD
    P["apply_patch(file, patchText)"] --> PARSE["解析 patch 语法"]
    PARSE --> READ["readFile(target)"]
    READ --> APPLY["在内存中应用 hunks"]
    APPLY --> WRITE["writeFile(target, result)"]
    WRITE --> SUCCESS["返回 applied: true"]

    PARSE -->|"失败"| ERR1["parse error → 模型重试"]
    APPLY -->|"失败"| ERR2["apply error → 模型重试"]
```

不直接让模型写整个文件 — `apply_patch` 是一种更安全、更精确的编辑方式。

---

## 4. checkpoint — 工作区快照

```mermaid
flowchart TD
    CREATE["checkpoint_create(label)"] --> SAVE["复制当前文件状态<br/>→ 存入 checkpoint store"]
    LIST["checkpoint_list()"] --> READ["返回所有 checkpoint<br/>{ id, label, time }"]
    RESTORE["checkpoint_restore(id)"] --> ROLL["恢复文件到快照状态"]

    CREATE --> TREE["每个 checkpoint<br/>存储文件的 hash 树"]
```

checkpoint 不依赖 git — 直接在文件系统做快照，适用于 undo 操作。

---

## 5. diff — 工作区变更

```mermaid
flowchart LR
    S["show_diff()"] --> STAGED["git diff --cached<br/>+ 未暂存变更"]
    STAGED --> FMT["统一 diff 格式输出"]
    FMT --> TRUNC["超出 maxOutputBytes 截断"]
```

返回 git diff 风格的输出，让模型了解当前工作区的修改状态。

---

## 6. 文件分页 (cursor)

```mermaid
sequenceDiagram
    Model->>Tool: read_file(path)
    Tool->>Tool: 文件 > maxOutputBytes?<br/>→ 截断 + 返回 nextCursor
    Tool-->>Model: { content: "...", nextCursor: "offset:4096" }
    Model->>Tool: read_file(path, cursor: "offset:4096")
    Tool-->>Model: { content: "...", nextCursor: undefined }
```

大文件自动分页，cursor 是 tool handler 内部的 offset 编码。

---

## 7. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/tools/files/index.ts` | 文件工具统一导出 |
| `dugsyn/src/tools/files/text.ts` | read_file / write_file 实现 |
| `dugsyn/src/tools/files/patch.ts` | apply_patch 结构化编辑 |
| `dugsyn/src/tools/files/diff.ts` | show_diff 工作区变更 |
| `dugsyn/src/tools/files/checkpoint.ts` | 工作区快照创建/恢复 |
| `dugsyn/src/tools/files/cursor.ts` | 分页读取逻辑 |
| `dugsyn/src/tools/files/path-guard.ts` | 路径安全守卫 |
| `dugsyn/src/tools/files/policy.ts` | 敏感文件拦截规则 |
