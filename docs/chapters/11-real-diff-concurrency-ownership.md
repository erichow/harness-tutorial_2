# 第 11 章：真实 Diff、并发冲突和变更归属

第一部分已经让 Agent 能完成真实编码任务，但“工具返回成功”还不足以支撑撤销、精确提交和审计。我们必须能回答四个更具体的问题：模型依据的是哪个文件版本、写入前文件是否仍是该版本、磁盘上究竟改变了哪些行，以及这些变化属于哪个用户回合。

本章把文件修改升级为一条可验证的数据链：

```text
read_file
  └─ version = SHA-256
       ↓ 作为 baseHash
apply_patch
  ├─ 唯一上下文匹配
  ├─ 同路径写锁
  ├─ 落盘前再次校验 SHA-256
  └─ 根据实际 before/after 生成 unified diff
                                      ↓
                         RuntimeEventLog.changesForTurn()
                         ├─ 本回合文件集合
                         ├─ 每次修改的真实 diff
                         └─ 新增/删除行数
```

对应代码 tag：`chapter-11`。

## 1. 本章问题

第 10 章已经要求 `apply_patch` 携带 `baseHash`，也会在原子 rename 前重新读取文件。但是还存在三个缺口。

第一，事件日志只保存 before/after hash。它能证明内容不同，却不能展示具体差异。根据模型提交的 patch 参数推导 diff 也不可靠：参数只表示意图，工具可能校验失败，也可能将上下文定位到另一个位置。

第二，单次 hash 校验无法协调同一进程中的并发工具。假设两个调用都读取版本 A，然后同时准备 A→B 和 A→C；如果它们都在对方 rename 前完成校验，最后一次 rename 可能覆盖第一次结果。

第三，旧实现只检查 hunk header 指定的行号。模型生成的行号可能偏移，而一段过短的上下文又可能在文件里出现多次。安全工具需要区分“唯一找到目标”“完全没找到”和“目标不唯一”，不能猜。

## 2. 行为规格

本章完成后的可观察行为如下：

1. `read_file` 同时返回兼容字段 `sha256` 和结构化 `version`。
2. Update/Delete 必须带上读取时得到的精确 `baseHash`；Add 必须使用 `null`。
3. 非空 hunk 上下文必须在当前 base version 中恰好匹配一次。
4. 同一路径的 Agent 写入按顺序执行，两个持有同一旧版本的调用最多一个成功。
5. 写入临时文件后、rename 前再次校验目标版本。
6. 成功结果包含由实际前后文本计算的 unified diff、增行数和删行数。
7. 只有成功写入的工具结果进入变更归属视图。
8. `changesForTurn(turnId)` 返回去重后的文件集合，同时保留同一文件在该回合内的每次修改。

失败必须保持原文件不变，也不能产生一条看起来成功的文件变更日志。

## 3. 威胁和失败模型

本章防止以下常见错误：

- 用户在模型思考期间修改了同一文件；
- 两个 Agent 工具使用同一个旧版本并发写同一文件；
- patch 上下文已经消失；
- 上下文太短，在多个位置都能匹配；
- 模型提交了形式上合法、实际上不改变文件的 patch；
- 日志把模型意图误记成已经发生的磁盘变化。

这里的锁是当前 `createWorkspaceFileTools()` 实例内的进程级协调器，不是跨进程文件锁。外部编辑器或另一个 CLI 进程由落盘前的第二次 hash 校验发现。便携式 Node 文件 API 没有“仅当文件仍为某 hash 时 rename”的原子 compare-and-swap，因此外部进程如果恰好在最后一次校验与 rename 之间写入，仍存在极短竞态窗口。后续 checkpoint/undo 也必须继续校验当前版本，不能把本章能力描述成全系统事务。

文件工具仍只处理受 Workspace Path Guard 保护的 UTF-8 普通文件。二进制 diff、跨文件原子事务和 Shell 命令产生的文件归属不属于本章范围。

## 4. 文件版本是一等数据

`read_file` 原本已经在文本头和 `data.sha256` 中返回 hash。本章保留这个对模型友好的简单字段，并增加结构化版本：

```ts
data: {
  path: "src/config.ts",
  sha256: "sha256:...",
  version: {
    algorithm: "sha256",
    value: "sha256:...",
  },
  // 分页和行数信息……
}
```

为什么不使用 mtime？因为时间戳粒度、文件系统行为和“改完又改回去”都会让 mtime 难以承担内容版本职责。SHA-256 直接绑定读取到的字节；BOM、CRLF 和末尾换行也都会进入 hash。

`apply_patch` 仍接收一个字符串 `baseHash`，而不是要求模型拼嵌套对象：

```ts
await apply_patch({
  baseHash: readResult.data.sha256,
  patch,
});
```

结构化 `version` 服务于程序化消费者和未来协议扩展，扁平 `sha256` 服务于当前模型工具调用。两者来自同一次字节读取，不能分别计算。

## 5. Patch 必须唯一匹配

Hunk header 中的行号现在是提示和 diff 元数据，不再是唯一定位依据。工具从 hunk body 提取所有 context/removal 行，然后扫描当前 base version：

```ts
const expected = body
  .filter((line) => line[0] !== "+")
  .map((line) => line.slice(1));

const matches = matchingOffsets(currentLines, expected);

if (matches.length === 0) throw zeroMatchError();
if (matches.length > 1) throw ambiguousMatchError(matches.length);
```

三种结果有明确语义：

- 一次：在该位置应用替换；即使模型的 hunk 行号略有偏差也可以安全完成。
- 零次：文件内容与 patch 假设不符，要求重新读取。
- 多次：工具拒绝猜测，并要求模型加入更多不变上下文。

例如文件中有两个独立的 `return value`，只提供这一行会得到：

```text
Patch context matched 2 locations ...;
include more unchanged context so it matches exactly once
```

纯插入 hunk 的 expected 集合为空。空文件只有一个插入边界，可以唯一定位；非空文件有多个边界，因此必须带上一行不变上下文。这个约束会让 patch 稍长，但消除了“随便选一个位置”的静默错误。

工具在生成新字节后还会比较 hash。如果模型用 `-same/+same` 提交文本 no-op，调用返回错误，不执行 rename，也不会制造虚假的变更归属。

## 6. 同路径写锁和二次校验

`WorkspaceMutationCoordinator` 为规范化后的 workspace 相对路径维护 Promise 队列：

```ts
await mutations.runExclusive(normalizedPath, async () => {
  const before = await readCurrentFile();
  assertHash(before, baseHash);
  const temporary = await writeAndSyncTemporaryFile();
  await revalidate(normalizedPath, baseHash);
  await rename(temporary, target);
});
```

路径必须先经 `WorkspacePathGuard.normalize()`，再作为锁 key。否则 `src/a.ts` 和 `./src/a.ts` 会进入两把锁，却指向同一目标。

锁覆盖读取、计算、临时文件写入、最终校验和 rename。假设两个调用都持有版本 A：

```text
writer 1: lock → 校验 A → 写入 B → unlock
writer 2: wait → lock → 发现当前是 B，不再等于 A → conflict
```

不同路径使用不同 key，互不阻塞。等待者取得锁后会再次检查取消信号；已经取消的调用不会继续写入。

二次校验仍然有必要。进程内锁只协调本工具实例，用户编辑器不经过它。`atomicWrite()` 先在同目录创建独占临时文件，写入并 sync，然后重新读取目标 hash，最后用同文件系统 rename 替换。失败路径在 `finally` 中删除临时文件。

## 7. Diff 必须来自实际前后文本

新增的 `src/tools/files/diff.ts` 不读取模型 patch，而是接收工具实际读取和即将写入的 UTF-8 文本：

```ts
const change = createUnifiedDiff(path, decodedBefore.text, changedText);
```

内部优先使用 Myers shortest-edit-script 算法计算行级编辑序列，再按三行上下文合并为 unified diff hunk。它不需要建立“旧行数 × 新行数”的完整 LCS 矩阵。为了防止大量互不相同行构造出高 CPU/内存开销，实现还设置了固定步数预算；超过预算时退化为“删除全部旧行、加入全部新行”的精确但非最小 diff。审计信息不会丢失，展示只是不再追求最短。

Update 的结果类似：

```diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,3 @@
 export const config = {
-  timeout: 5000,
+  timeout: 10000,
 };
```

Add/Delete 使用标准 `/dev/null` 文件头。缺少末尾换行时会生成：

```text
\ No newline at end of file
```

工具结果中的结构化数据如下：

```ts
{
  operation: "update",
  path: "src/config.ts",
  beforeHash: "sha256:...",
  afterHash: "sha256:...",
  diff: "--- a/src/config.ts\n+++ b/src/config.ts\n...",
  additions: 1,
  deletions: 1,
}
```

hash 描述字节版本，diff 描述 UTF-8 文本的逻辑行变化。当前 patch 会保留 BOM、原有 CRLF/LF 风格和末尾换行；diff 则使用统一的 LF 协议文本展示行级变化。

## 8. 从工具事实推导变更归属

`RuntimeEventLog.fileChanges` 只检查满足以下条件的事件：

- 事件类型是 `tool_call_finished`；
- ToolResult 状态是 `success`；
- data 中 operation、path、hash、diff 和行数均通过运行时类型检查。

这样，失败 patch、模型口头声称修改、Shell 输出里的相似文本都不会进入文件归属。

每条 `LoggedFileChange` 保留：

```ts
interface LoggedFileChange {
  turnId: string;
  sequence: number;
  toolCallId: string;
  operation: "add" | "update" | "delete";
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  diff: string;
  additions: number;
  deletions: number;
}
```

上层用 turn ID 查询聚合结果：

```ts
const changes = runtime.eventLog.changesForTurn(result.turnId);

changes.files;      // ["src/config.ts"]
changes.additions;  // 1
changes.deletions;  // 1
changes.changes;    // 该回合按事件顺序发生的每一次修改
```

如果同一回合修改同一文件两次，`files` 只出现一次，但 `changes` 保留两条 diff。不能只保存最后一条，因为第 12 章构造 checkpoint 和 undo 时需要知道完整修改链。

当前归属只覆盖文件工具。Shell 可以执行任意允许的命令并间接修改文件，但本章没有可靠的跨平台文件系统追踪器，因此不能把 Shell 副作用伪装成精确的 Agent diff。

## 9. 从第 10 章迁移

本章的修改集中在以下文件：

```text
src/tools/files/diff.ts             # 实际文本 → unified diff
src/tools/files/patch.ts            # 唯一匹配、同路径锁、diff 结果
src/tools/files/index.ts            # 共享协调器、结构化 version
src/runtime/event-log.ts            # 行级变更与 turn 聚合
tests/unit/file-diff.test.ts         # diff 格式和末尾换行
tests/unit/file-tools.test.ts        # stale/zero/multiple/concurrent
tests/unit/runtime-event-log.test.ts # 变更归属聚合
tests/integration/mvp-flow.test.ts   # 完整运行时接线
```

没有修改 Provider 请求格式，也没有增加新的模型 API 配置。OpenAI 和 DeepSeek 仍调用同一个 `apply_patch` 工具，只会在成功结果中看到更完整的 diff 文本。因此本章的确定性回归不需要访问真实 Provider 或消耗额度。

## 10. 验收测试

### 用户在 Agent 思考期间修改文件

测试先通过 `read_file` 取得版本 A，再模拟用户写入版本 B，最后让 Agent 用 A 调用 patch。预期结果是 `execution_failed`，错误要求重新读取，磁盘保持 B。

### 两个工具并发编辑同一文件

两个调用共享同一个 `WorkspaceMutationCoordinator`，也共享 base version A，并通过 `Promise.all()` 同时开始。断言恰好一个成功，另一个得到版本冲突；最终内容只能是两个完整候选之一，不能是混合内容。

### Patch 匹配一次、零次和多次

- 唯一上下文：成功，即使 header 行号故意写成 99。
- 零匹配：失败，原文件不变。
- 两处匹配：失败，并提示增加不变上下文。

测试还覆盖 Add/Update/Delete diff、末尾无换行、CRLF、BOM、no-op、临时文件清理，以及同一 turn 两次修改同一文件时的聚合。

运行本章完整验收：

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

本章快照中的预期结果是单元/集成测试全部通过，真实 Provider 测试保持显式跳过；E2E CLI 测试全部通过。

## 11. 动手实验

可以在临时目录中准备下面的文件：

```text
start
target
middle
target
end
```

先提交只包含 `-target/+changed` 的 patch，观察多匹配错误。然后加入 `start` 或 `middle` 作为 context，再次执行，确认只有目标位置改变，并检查 ToolResult 中的 unified diff。

接着打开编辑器：先让 `read_file` 返回 hash，在模型调用 `apply_patch` 前手动保存文件。工具应报告 expected/found hash 不同，而不是覆盖你的保存结果。

最后在测试中将同一 baseHash 交给两个并发 patch，重复运行多次。无论调度顺序怎样，都应始终只有一个成功。

## 12. 本章验收清单

- [x] 每次 `read_file` 返回字节级 SHA-256 版本。
- [x] Update/Delete 必须携带读取时的 base version。
- [x] Patch 上下文明确区分一次、零次和多次匹配。
- [x] 同一规范化路径的工具写入串行化。
- [x] rename 前再次校验目标版本。
- [x] unified diff 根据实际 before/after 文本生成。
- [x] Add/Delete 使用 `/dev/null`，末尾换行差异可见。
- [x] 成功结果记录 diff、增行数、删行数和前后 hash。
- [x] `changesForTurn()` 返回去重文件集并保留逐次 diff。
- [x] stale、并发、no-op 和歧义失败都不改变原文件。
- [x] 完整 typecheck、测试、构建和 CLI E2E 通过。

## 13. 下一章留下的问题

现在系统知道本回合真正修改了哪些文件和行，但这些信息仍只用于观察：用户还不能要求 Agent 撤销刚才的变更。简单地把 before 内容写回去会覆盖用户在 Agent 完成后产生的新修改，也无法处理同一回合多次编辑同一文件的恢复顺序。

第 12 章会在每条用户消息开始前创建 checkpoint，保存恢复所需的最小信息，并让 `/undo` 只在当前版本仍符合预期时撤销 Agent 修改。Git 仓库和普通目录都要工作，Shell 的外部副作用则会被明确标为不可保证回滚。
