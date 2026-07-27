# 第 12 章：Checkpoint 和 Undo

第 11 章已经能证明 Agent 在一个回合里真正改了哪些文件，但“知道发生了什么”和“能安全恢复”仍是两回事。最危险的实现是把旧内容直接写回：如果用户在 Agent 完成后又保存了文件，所谓撤销反而会覆盖用户的新工作。

本章增加一个只负责文件工具写入的回合级恢复日志：

```text
用户消息
  ↓
begin checkpoint
  ↓
apply_patch
  ├─ 持有规范化路径锁
  ├─ prepare：保存第一次写入前的原始字节与 mode
  ├─ 执行已校验的原子写入
  └─ commit：记录 Agent 留下的最终 hash 与 mode
  ↓
finish checkpoint
  ↓
/undo
  ├─ 一次性预检所有目标文件
  ├─ 当前版本必须仍等于 Agent 最终版本
  └─ 恢复原始字节、权限或“不存在”状态
```

对应代码 tag：`chapter-12`。

## 1. 本章要解决的问题

我们需要同时满足四个约束：

1. 每条用户消息在模型运行前建立新的恢复边界。
2. Update、Delete 和 Add 都能恢复，不依赖当前目录是不是 Git 仓库。
3. 同一回合多次修改同一个文件时，撤销回到该回合开始前，而不是只退最后一步。
4. 用户在 Agent 写入后产生的新修改绝不能被静默覆盖。

第四条比“尽量撤销成功”更重要。无法证明安全时，`/undo` 应整次拒绝，并说明冲突文件；用户可以查看 diff 后人工合并。

## 2. Checkpoint 不是 `git reset --hard`

用 Git 回退看起来很省事，却不符合 coding agent 的边界：

- workspace 可能不是 Git 仓库；
- 用户在回合开始前可能已有未提交或 staged 修改；
- `git reset --hard` 会把 Agent 不拥有的修改一起清掉；
- 新增的 untracked 文件和嵌套仓库还有额外语义；
- Git 只能看到最终工作树，不能自动说明某个修改属于哪个回合。

因此 checkpoint 以文件工具观察到的真实写入为单位，不读取 HEAD，也不移动分支。Git 工具和精确 stage 归属留到第 13 章。

## 3. 恢复状态模型

每个被当前回合成功修改的路径只保留一条聚合记录：

```ts
interface CheckpointEntry {
  path: string;
  original: {
    version: { hash: string; mode: number } | null;
    content: Buffer | null;
  };
  expected: { hash: string; mode: number } | null;
  chainIntact: boolean;
}
```

`original` 是该路径在本回合第一次 Agent 写入前的状态，之后不会改变。`expected` 每次成功写入后更新，表示 Agent 最终留在磁盘上的版本。`null` 表示路径不存在。

三类操作的恢复规则如下：

| Agent 操作 | original | expected | Undo |
| --- | --- | --- | --- |
| Add | 不存在 | 新文件版本 | 仅当版本仍匹配时删除 |
| Update | 原始字节与 mode | 新文件版本 | 原样写回原始字节与 mode |
| Delete | 原始字节与 mode | 不存在 | 仅当路径仍不存在时重建 |

这里保存的是字节而不是解码后的字符串，因此 UTF-8 BOM、CRLF/LF 和末尾换行都能精确恢复。mode 也进入版本校验；用户只修改权限位而不改内容时，撤销同样会拒绝。

恢复字节只存在于内部 checkpoint manager，不进入 ToolResult、Transcript 或 RuntimeEventLog。模型仍只看到 diff 和 hash，避免把完整旧文件再次塞进上下文。

## 4. 为什么必须在写入前 prepare

文件工具不能在写完后才去读取“旧内容”。正确顺序是：

```ts
const recovery = checkpoints.prepareMutation(path, beforeSnapshot);
try {
  await atomicWrite(...);
  recovery.commit(afterVersion);
} catch (error) {
  recovery.abort();
  throw error;
}
```

`prepareMutation()` 在路径锁内保存恢复信息，然后才允许写磁盘。成功后 `commit()` 发布最终版本；失败则 `abort()` 移除这次尚未发生的记录。

这条顺序保证恢复材料来自工具已经校验过的 base version，也避免失败 patch 被当成可撤销变更。当前实现是进程内 checkpoint；进程崩溃后的 durable session 恢复会在后续 Session 章节持久化协议中完成。本章不声称内存日志可以跨进程存活。

## 5. 同一文件多次修改

假设同一回合产生：

```text
A --Agent--> B --Agent--> C
```

第一次 prepare 保存 A，commit 后 expected=B；第二次 prepare 的 before 必须等于 B，commit 后只把 expected 更新为 C。撤销只需验证当前仍是 C，然后恢复 A。

如果实际链路是：

```text
A --Agent--> B --用户--> U --Agent--> C
```

第二次 prepare 会发现 `before=U`，不等于上次 Agent 承诺的 `expected=B`，于是把 `chainIntact` 标为 false。即便磁盘最终仍是 C，`/undo` 也不会恢复 A，因为那会同时删除用户引入的 U。

理论上可以尝试把逆向 patch 三方合并到 U，但那是一个新的合并功能，不应伪装成确定性 undo。本章选择明确拒绝。

## 6. 多文件 Undo 必须先整体预检

如果一个回合改了 `a.ts` 和 `b.ts`，用户随后只编辑了 `b.ts`，实现不能先恢复 `a.ts`，再发现 `b.ts` 冲突。那会制造难以解释的半回滚。

`undoLatest()` 先按路径排序并持有所有进程内写锁，然后读取每个目标的当前版本：

```text
lock a.ts, b.ts
  ├─ verify a.ts == Agent expected A
  ├─ verify b.ts == Agent expected B
  ├─ 任意失败：一个文件也不动
  └─ 全部通过：反向恢复每个 original
unlock
```

排序取锁避免两个多路径操作以相反顺序等待造成死锁。恢复按反向顺序执行，语义上对应逆序撤销该回合记录。

Node 的便携文件 API 仍不提供“hash 相等时才 rename”的跨进程原子 CAS。与第 11 章一样，外部编辑器如果恰好在最后一次校验和 rename 之间写入，存在极短竞态窗口。本章保证 Agent 当前进程内的工具不会交错，并用写前复检缩小外部竞态，但不把它描述成文件系统事务。

## 7. 恢复也要使用受保护的原子写入

Undo 不是绕开安全层的特殊后门。每个路径仍经过 `WorkspacePathGuard`：

- 不能越出 workspace；
- 不能写受保护的 secret、metadata 或依赖目录；
- 不能通过 symlink 写入另一个目标；
- 父目录必须仍然合法。

恢复已有内容时，工具在目标同目录创建独占临时文件，写入、sync、设置原权限，再次检查 expected version，最后 rename。恢复“原本不存在”的路径时，删除前也再次校验当前 hash 和 mode。

如果用户把目标替换成目录、symlink 或不同内容，恢复返回 conflict，不猜测用户意图。

## 8. Runtime 如何划定回合

`CodingAgentRuntime.runTurn()` 在调用 agent loop 前开始 checkpoint：

```ts
const checkpointId = checkpoints.beginTurn();
try {
  return await runTurn({
    emit(event) {
      checkpoints.attachTurn(checkpointId, event.turnId);
      eventLog.append(event);
    },
  });
} finally {
  checkpoints.finishTurn(checkpointId);
}
```

turn ID 在 loop 发出第一条 `turn_started` 时绑定。`finally` 很重要：Provider 错误、取消或渲染回调异常都不能让 checkpoint 永远停在 active 状态。只要文件工具已经成功写入，失败回合仍可撤销。

每个新回合会成为唯一的“当前回合”。如果最新回合没有文件修改，`/undo` 返回“latest turn did not change files”，不会越过它偷偷撤销更早的回合。这让命令含义保持可预测。

当前 runtime 不允许两个回合共享一个 checkpoint manager 并发执行；第二个 begin 会直接报错。交互 CLI 本身一次只运行一个回合。

## 9. CLI 的 `/undo`

`CliSession` 把 undo 作为本地命令处理，不把字符串发送给模型：

```text
> /undo
Undid Agent file changes: src/config.ts.
Shell and other external side effects were not reverted.
```

成功撤销后，同一 checkpoint 不能再次撤销。无修改、已经撤销、回合仍在运行或版本冲突时，命令只展示原因，不改变文件。

Transcript 默认保留。`/undo` 表示撤销文件副作用，不是抹掉对话历史；保留历史能让后续消息说明“刚才的实现已撤销”以及继续讨论原因。

## 10. Shell 为什么不在保证范围内

Shell 命令可能：

- 写入文件工具没有观察到的文件；
- 修改数据库或系统服务；
- 启动子进程；
- 在获得网络权限时调用外部 API；
- 产生不可逆的远程副作用。

没有通用方式把这些操作还原成一组安全文件写入。因此 `/undo` 只承诺撤销 `apply_patch` 的成功修改，并始终提示 Shell 和其他外部副作用没有恢复。

未来可以为特定工具增加补偿动作或幂等 key，但必须由工具明确声明和验证，不能由 checkpoint manager 猜测。

## 11. 与原教程 ch21 的关系

原教程第 21 章关注 durable checkpoint、crash-resume 和 mutating tool 的幂等重放：它保存 transcript、plan、budget 和 tool-call 状态，解决“进程死后从哪里继续”。

本实战教程先处理 coding CLI 更早暴露的文件安全问题：用户需要立即撤销刚才一回合的 Agent 编辑，而且不能破坏工作区已有修改。因此本章借用了“副作用必须记录、重放前必须验证”的原则，但范围刻意缩小为进程内的文件 rollback journal。

两者不能混为一谈：

- 本章 checkpoint：为当前回合文件 undo 保存精确 preimage。
- 后续 session checkpoint：为进程重启保存可序列化会话状态和调用幂等信息。

等实现 durable session 时，不能直接把任意旧文件内容放进 transcript JSON；恢复日志需要独立存储、版本化并限制大小与权限。

## 12. 本章代码变化

```text
src/tools/files/checkpoint.ts        # 回合日志、整体预检与安全恢复
src/tools/files/patch.ts             # prepare/commit/abort 恢复协议
src/tools/files/index.ts             # 工具与 checkpoint 共享 guard/锁
src/runtime/coding-agent.ts          # 回合边界和 undo API
src/cli/session.ts                   # /undo 本地命令
src/cli/chat.ts                      # 将 runtime undo 接入 session
tests/unit/checkpoint.test.ts        # 精确恢复、冲突与多次写入
tests/unit/cli-session.test.ts       # 命令行为和 Shell 边界提示
tests/integration/mvp-flow.test.ts   # 完整回合修改后恢复
```

Provider 协议和工具 schema 没有改变。OpenAI 与 DeepSeek 都使用同一个文件工具实现，因此本章的验收不需要真实 API key，也不会发起模型请求。

## 13. 验收测试

新增测试覆盖以下场景：

### Update、Delete 和 Add 一起撤销

同一回合更新带 BOM/CRLF 的文件、删除另一个文件并新增第三个文件。撤销后断言：原始字节完全一致，权限位恢复，被删除文件重建，新增文件消失。

### 用户在回合后修改一个目标

Agent 修改两个文件，用户再写其中一个。撤销应报告 conflict；另一个原本可以恢复的文件也保持 Agent 版本，证明整体预检阻止了半回滚。

### 用户在两次 Agent 写入之间修改

Agent 写 B，用户写 U，Agent 基于 U 再写 C。即使最终文件仍等于 C，checkpoint 也因 ownership chain 中断而拒绝恢复 A。

### 最新回合没有文件变化

前一回合修改文件，下一回合只回答文本。此时 `/undo` 不跨越最新边界去撤销更早文件。

运行完整验收：

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## 14. 动手实验

启动交互 CLI，让模型通过 `apply_patch` 修改一个普通文件，然后执行 `/undo`。确认文件恢复，聊天记录仍在。

再次让模型修改文件，完成后先用编辑器保存一处新内容，再执行 `/undo`。命令应该拒绝，并保留编辑器内容。把文件手工恢复为 Agent 最终版本后可再次尝试 undo。

最后让 Agent 通过允许的 Shell 命令创建文件，再执行 `/undo`。该文件不会被删除，CLI 会明确提示 Shell 副作用不在恢复范围内。这是有意的安全边界，不是测试遗漏。

## 15. 本章验收清单

- [x] 每个 runtime turn 在模型运行前创建 checkpoint。
- [x] 文件工具在落盘前保存第一次写入前的原始字节与 mode。
- [x] 成功写入后记录 Agent 最终 hash 与 mode。
- [x] Add、Update 和 Delete 均可精确恢复。
- [x] 同一回合多次写同一文件回到回合开始前。
- [x] 用户夹在两次 Agent 写入之间的修改会中断 ownership chain。
- [x] Undo 在任何写入前预检全部目标，避免普通冲突导致半回滚。
- [x] 用户在回合后修改内容或权限时拒绝覆盖。
- [x] Git 和非 Git workspace 使用同一实现。
- [x] `/undo` 不调用模型，并明确排除 Shell 外部副作用。
- [x] 成功 checkpoint 只能撤销一次，空的最新回合不越界。
- [x] typecheck、测试、构建和 CLI E2E 全部通过。

## 16. 下一章留下的问题

现在 Agent 的文件工具修改可以安全撤销，但 Git 仍是一个未建模的高风险边界。若直接执行 `git add .`，用户原本的 unstaged、staged 或 untracked 文件可能被一起提交；若只依赖最终 `git diff`，又无法证明哪些路径属于 Agent。

第 13 章会增加结构化 `git_status`、`git_diff` 和 `git_log`，提交时只 stage 当前 Agent 明确拥有的文件，并在 commit 前展示精确 staged diff。push、rebase、reset 等操作仍保持高权限。
