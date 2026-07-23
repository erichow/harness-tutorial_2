# 第 21 章：Subagent 和 Worktree 隔离

上一章让单个 Agent 工作流可以被观测、重复运行和评分。它仍然只有一个执行上下文。
如果父 Agent 把两个写任务同时扔进同一个目录，文件工具的单次并发检查并不能解决所有
问题：两个任务可能都基于同一个旧版本完成修改，也可能让测试观察到另一个任务尚未完成
的中间状态。

本章实现一个可以离线测试的 Subagent 协调层。它不是把同一份 Transcript 复制两次，
而是建立四条边界：

1. 子 Agent 只有独立任务消息和独立 Transcript；
2. 子 Agent 的工具集只能比父任务授权更窄；
3. 每个任务在独立 Git worktree 和分支中执行；
4. 产物先在第三个集成 worktree 合并、测试，通过后才快进父分支。

本章不调用真实模型。集成测试继续使用 `MockProvider`。

## 1. 行为规格

给协调器两个独立写任务：

```ts
const batch = await coordinator.run([
  {
    id: "parser",
    prompt: "修复 parser 的边界条件",
    mode: "write",
    requestedTools: ["list_files", "read_file", "search_text", "apply_patch"],
    writeScopes: ["src/parser"],
  },
  {
    id: "renderer",
    prompt: "补上 renderer 的空状态",
    mode: "write",
    requestedTools: ["list_files", "read_file", "search_text", "apply_patch"],
    writeScopes: ["src/renderer"],
  },
]);
```

可以观察到：

- 两个 Provider context 中的 `workspaceRoot` 不同，也都不是父工作区；
- 每个 Provider 只看到自己的任务消息；
- Provider 收到的工具 schema 正好等于有效工具白名单；
- 两个子任务都从同一个父 `baseCommit` 开始；
- 协调器检查真实 Git status，而不是相信模型声称改了哪些文件；
- 父 Agent 得到 `summary`、trace 引用和 commit/diff 引用，不得到子 Transcript；
- 合并冲突、测试失败、父 HEAD 变化或父工作区变脏时，父分支不落地。

`SubagentBatch` 持有临时 worktree。调用者必须在 `finally` 中执行 `dispose()`：

```ts
const batch = await coordinator.run(tasks);
try {
  const result = await batch.integrate({
    file: "npm",
    args: ["test"],
    timeoutMs: 120_000,
  });
  console.log(result);
} finally {
  await batch.dispose();
}
```

## 2. 威胁和失败模型

### 2.1 本章要阻止什么

- 父任务没有授予 Shell，子任务却自行申请 `run_shell`；
- 父对话历史、其他子任务输出被自动复制进子 Transcript；
- 两个并行任务声明相同或祖先/后代写范围；
- 子 Agent 声明只改 `src/a`，实际修改 `src/b`；
- 子 Agent 自己提交或改写 Git 历史；
- 一个子 Agent 失败后，其他运行时仍在使用即将被清理的目录；
- 两个产物发生冲突时直接污染父工作区；
- 集成测试失败后仍把代码合进父分支；
- 子 Agent 运行期间用户改变父 HEAD 或留下未提交修改，协调器仍覆盖它。

### 2.2 本章不替代什么

worktree 是 Git 写隔离，不是完整安全沙箱。它不能单独阻止进程读取主机秘密、访问网络
或直接操作共享 `.git` 目录。

因此子运行时的进程工具仍使用第 8 章的 OS sandbox，并采用：

```text
network: blocked
fallback: closed
```

平台沙箱不可用时，`run_shell` / `run_tests` 不会悄悄退回主机执行。父任务还必须显式
授予这些工具。文件工具继续使用 workspace path guard 和敏感文件 deny。

集成测试命令由父协调器提供，不由模型拼接。它使用 executable + args 数组和固定 cwd，
不经过 shell；环境也只保留基础 locale、`PATH` 和显式传入项。

## 3. 能力只能收缩

新增文件：

```text
src/subagents/capabilities.ts
```

父任务先给出能力上限：

```ts
interface SubagentCapabilityGrant {
  readonly tools: readonly string[];
}
```

每个子任务再声明需要哪些工具。`attenuateSubagentCapabilities()` 验证：

```text
effective tools = requested tools
且 requested tools ⊆ parent grant
```

如果子任务申请了父任务没有授予的工具，协调器拒绝整个 batch，不会静默删除工具后让
任务以残缺能力继续运行。这样拼写错误和越权申请都能在启动前暴露。

另外有两条固定约束：

- read 模式只能使用只读工具；
- `git_prepare_commit` 和 `git_commit` 归协调器所有，子 Agent 不能申请。

第二条很重要。产物提交是可信边界的一部分：只有协调器检查真实变更范围后，才能创建
artifact commit。

## 4. Runtime 工具白名单

只在权限阶段拒绝工具还不够。模型如果仍然看见全部 tool schema，会为不可用工具制定
计划，并浪费一次调用。

`CodingAgentRuntimeOptions` 新增：

```ts
readonly tools?: {
  readonly allowedNames?: readonly string[];
};
```

运行时先构建完整内置工具集合，再调用 `selectTools()`：

```ts
const tools = selectTools(allTools, options.tools?.allowedNames);
const registry = new ToolRegistry(tools, { permissions, hooks });
```

白名单同时影响：

- Provider request 中的工具定义；
- ContextManager 的工具 schema 预算；
- ToolRegistry 可以真正执行的工具。

未知名字或重复名字会让 runtime construction 失败，不能因为配置错误意外回到“全部
工具”。

协调器还给子运行时建立 `PermissionEngine`：

```ts
new PermissionEngine({
  trust,
  managedRules: [{
    id: "subagent-parent-grant",
    action: "allow",
    tools: effective.tools,
  }],
  defaultDecision: "deny",
});
```

工具白名单回答“工具是否存在”；权限规则回答“本次规范化请求是否被允许”。内置的敏感
文件和外部路径 hard deny 仍有更高优先级。

## 5. 独立 Transcript

父运行时不把自己的 Transcript 传给子运行时。每个子 Agent 从一条消息开始：

```ts
createTranscript([{
  id: `subagent-task:${task.id}`,
  role: "user",
  content: [{ type: "text", text: task.prompt }],
  createdAt: new Date().toISOString(),
}]);
```

子运行时有固定 system prompt，说明任务边界、Git 所有权和输出要求。项目的
`AGENTS.md` 仍会从该 worktree 正常加载，因为它属于完成任务所需的项目上下文；父
对话、父工具结果和其他子 Agent Transcript 不会自动进入。

协调器从最后一条 assistant message 中提取最多 8192 字符的文本摘要。公开结果是：

```ts
interface SubagentResult {
  readonly taskId: string;
  readonly mode: "read" | "write";
  readonly status: "completed" | "failed" | "cancelled";
  readonly summary: string;
  readonly capabilities: EffectiveSubagentCapabilities;
  readonly trace: {
    readonly traceId: string;
    readonly sessionId: string;
  };
  readonly artifact?: SubagentArtifactReference;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
```

这里没有 `transcript` 字段。trace 也只返回引用；父 Agent 不自动接收工具输入、输出或
完整 span 集合。

“结构化摘要”不是“摘要绝对可信”。它仍然是模型输出，适合展示和辅助决策；是否可以
合并必须由 commit、changed files、diff hash、冲突检查和真实测试决定。

## 6. 写范围决定任务是否可并行

写任务必须声明至少一个仓库相对范围：

```ts
writeScopes: ["src/parser", "tests/parser.test.ts"]
```

以下值会在创建 worktree 前拒绝：

- 绝对路径；
- `..` 逃逸；
- `.git` 及其后代；
- NUL；
- Windows 反斜杠形式；
- 两个任务相同、祖先/后代或 `.` 全仓范围的重叠。

例如：

```text
src            与 src/parser       重叠
src/a.ts       与 src/a.ts         重叠
.              与任意范围          重叠
src/parser     与 src/renderer     独立
```

这是一条调度不变量，不是依赖模型自觉。协调器只对范围互不重叠的任务使用
`Promise.allSettled()` 并行运行。

子任务结束后还会读取真实 Git status。rename 的原路径和新路径都参与检查。任何范围外
路径都会把结果改为：

```text
status: failed
error.code: scope_violation
```

因此错误声明范围不能靠独立 worktree 混入最终提交。

## 7. Worktree 生命周期

启动 batch 前要求：

```text
父路径是 Git repository root
父 worktree clean
HEAD 存在
```

协调器记录 `baseCommit`，然后在 `mkdtemp()` 返回的 batch root 内为每个任务执行：

```text
git worktree add -b agent-code/subagent-<id>-<n> <path> <baseCommit>
```

创建 worktree 是顺序的，避免同时修改 Git worktree 元数据。全部创建完成后，子
runtime 才并行执行。这样每个子 Agent 都从完全相同的基线开始。

如果任一基础设施调用抛错，batch controller 会取消其他任务，并等待全部 Promise
settle、runtime dispose 完成后才清理目录。不会一边删除 worktree，一边让另一个子
进程继续访问它。

## 8. 从变更到 artifact

子 Agent 正常完成后，协调器依次验证：

1. worktree HEAD 仍等于 `baseCommit`；
2. read 任务没有产生修改；
3. write 任务有修改；
4. 所有 changed files 位于声明范围内。

通过后协调器自己执行 `git add --all` 和 `git commit`。Git identity 使用命令级
`-c user.name=...` / `-c user.email=...`，不修改用户配置。

artifact reference 包含：

```ts
interface SubagentArtifactReference {
  readonly baseCommit: string;
  readonly branch: string;
  readonly commit: string;
  readonly changedFiles: readonly string[];
  readonly diffSha256: string;
}
```

`diffSha256` 来自 `git show --binary` 的真实输出。父 Agent 可以用引用进一步检查
产物，而不必接收整个 diff 作为对话正文。

## 9. 在第三个 worktree 合并

协调器绝不在父工作区试合并。`batch.integrate()` 先再次确认父 HEAD 和 clean 状态，
再从 `baseCommit` 创建 detached integration worktree。

流程如下：

```text
artifact commits
      │
      ▼
integration worktree
  merge --no-ff each commit
      │
      ├── conflict ──> rejected，父分支不变
      │
      ▼
executable + args test
      │
      ├── non-zero / timeout ──> rejected，父分支不变
      │
      ▼
再次检查父 HEAD + status
      │
      ▼
parent merge --ff-only <validated integration head>
```

使用 `--no-ff` 让多个独立产物在集成历史中有明确边界；最终父分支只做 fast-forward，
不会在最后一步重新解释或重新解决冲突。

`IntegrationResult` 的拒绝原因是稳定枚举：

```text
subagent_failed
parent_changed
parent_dirty
conflict
tests_failed
```

测试 stdout/stderr、exit code 和 timeout 结论作为结构化字段返回。

## 10. 取消与清理

子任务共享 batch cancellation signal，但各自持有独立 runtime 和进程管理器。一个
基础设施错误会触发 batch controller；协调器使用 `Promise.allSettled()` 等所有子
runtime 退出。

`SubagentBatch.dispose()`：

1. 逆序执行 `git worktree remove --force <exact path>`；
2. 删除 `mkdtemp()` 返回的精确 batch root，并 prune 可能残留的 worktree metadata；
3. 删除协调器创建的精确临时 branch。

调用者传入的 workspace、glob、环境变量或模型文本都不会成为递归删除目标。`--force`
只针对协调器创建并拥有的临时 worktree。

## 11. 使用示例

```ts
const coordinator = new SubagentCoordinator({
  repositoryRoot,
  parentGrant: {
    tools: [
      "list_files",
      "search_text",
      "read_file",
      "apply_patch",
    ],
  },
  provider: async ({ taskId, workspaceRoot }) => {
    return createProviderForChild({ taskId, workspaceRoot });
  },
});

const batch = await coordinator.run(tasks, signal);
try {
  for (const result of batch.results) {
    console.log(result.taskId, result.status, result.summary);
    console.log(result.artifact);
  }

  const integration = await batch.integrate({
    file: "npm",
    args: ["test"],
  }, signal);

  if (integration.status === "rejected") {
    console.error(integration.reason, integration.detail);
  }
} finally {
  await batch.dispose();
}
```

Provider factory 必须为每个任务返回独立 Provider 实例。不能让两个子 Agent 共享一个
带可变请求游标或连接状态的 adapter。

## 12. 测试

新增：

```text
tests/integration/subagent-worktree.test.ts
```

确定性测试覆盖：

- 两个独立任务得到不同 workspace；
- 子 Provider 只收到独立任务 Transcript；
- Provider 工具定义严格等于子工具白名单；
- 父授权外工具在 Provider 创建前被拒绝；
- 重叠写范围在创建 worktree 前被拒绝；
- 范围外写入产生结构化失败且不能集成；
- 父结果没有 Transcript；
- artifact 含 changed files、commit 和 diff SHA-256；
- 两个产物在集成 worktree 合并并通过真实 Node 进程测试；
- 冲突在临时集成 worktree 被发现，父文件不变；
- 测试返回非零时父分支不变；
- 用户产生未提交修改后拒绝落地并保留用户文件。

运行本章专项测试：

```bash
cd agent-code
npm run test:subagents
```

## 13. 动手实验

### 实验一：申请越权工具

父 grant 只放入 `read_file`，子任务申请 `run_shell`。确认 Provider factory 没有被
调用，错误中列出未授权工具。

### 实验二：谎报写范围

任务声明 `writeScopes: ["src/a"]`，让 Mock Provider 修改 `src/b`。确认子回合可以
完成，但最终结果是 `scope_violation`，且没有 artifact。

### 实验三：制造冲突

从同一个 base 创建两个 artifact，都修改同一行，然后放入防御性 integration 测试。
确认 `reason` 是 `conflict`，主工作区内容和 HEAD 不变。

### 实验四：测试期间改变父工作区

在 batch 完成后、integrate 前新增用户文件。确认结果为 `parent_dirty`，用户文件被
保留。

## 14. 完成检查

```bash
cd agent-code
npm run typecheck
npm run test:subagents
npm test
npm run build
npm run test:e2e
npm run test:mvp
```

普通测试不需要 API key，也不会访问真实 Provider。

完成本章后，Subagent 已经是一个可执行、可验证的协调边界，而不是“再调一次模型”的
别名。下一章会把 LSP 放在可选插件边界：可用时增加语义信息，不可用时继续依赖已经
可靠的搜索、读取和测试工具。
