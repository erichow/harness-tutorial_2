# 第 13 章：Git 工具和用户修改保护

第 12 章已经能撤销文件工具的修改，但 Git 仍是一个独立的状态系统。工作区里可能同时存在用户的 unstaged、staged、untracked 文件和 Agent 刚写入的文件；一句方便的 `git add .` 会把这些来源全部混在一起。

本章增加五个专用工具：

```text
git_status
git_diff
git_log
git_prepare_commit
git_commit
```

前三个只读工具返回结构化数据；后两个组成两阶段安全提交。提交路径必须来自当前 checkpoint 的真实写入归属，预览使用临时 index，真正提交前再检查一次所有前提。

对应代码 tag：`chapter-13`。

## 1. 本章要解决的不是“怎么调用 Git”

直接开放 Shell 已经能运行 Git，专用工具的价值是缩小模型能表达的动作空间，并把安全条件写进程序：

```text
禁止：git add .
禁止：git add -A
禁止：默认提交整个工作区
禁止：改写用户已有 staged 状态
```

例如下面这个状态很常见：

```text
 M src/agent.ts       # Agent 修改
 M notes.md           # 用户未暂存修改
M  release.md         # 用户已暂存修改
?? scratch.txt        # 用户未跟踪文件
```

模型看到 `src/agent.ts` 并不等于它拥有这个路径。工具必须从文件写入日志取得归属，并确认磁盘当前版本仍等于 Agent 最后写入的 hash 和 mode。

## 2. 安全提交协议

本章的完整流程如下：

```text
apply_patch 成功
  ↓
checkpoint 记录 path + final hash + mode
  ↓
git_prepare_commit(paths)
  ├─ 拒绝已有 staged 状态
  ├─ 只接受 active checkpoint 拥有的显式路径
  ├─ 校验当前字节 hash 和权限 mode
  ├─ 临时 index 从 HEAD 初始化
  ├─ 临时 index 只 add 显式路径
  └─ 返回 proposed tree、完整 staged diff 和一次性 token
  ↓
模型和用户可以先看到 diff
  ↓
git_commit(token, message)
  ├─ HEAD 没变？
  ├─ 真实 index 仍没有 staged 修改？
  ├─ ownership 和文件版本没变？
  ├─ 显式 add 后 tree 与预览一致？
  └─ commit
```

这不是依赖提示词的约定。模型即使传入 `notes.md`，只要该路径不在当前 active checkpoint 中，工具就会拒绝。

## 3. Git 命令不经过 Shell

`GitAdapter` 使用 `execFile()` 和参数数组：

```ts
execFile("git", ["-C", workspaceRoot, ...args], {
  signal,
  maxBuffer,
});
```

路径总是在 `--` 后传递：

```ts
["add", "--", ...explicitPaths]
```

因此文件名不会被解释成 Git 选项，也没有 Shell 拼接、重定向、变量展开或命令替换。适配器还要求 Git repository top-level 与 workspace root 完全一致，防止一个子目录 workspace 意外读取或提交父仓库的其他内容。

所有调用都有取消信号和输出上限。这里仍把工具标记为 `execute_process`；“参数安全”不等于“没有启动进程”。只读工具同时标记 `read_workspace`，提交再增加 `write_workspace`，但不声明 `network`，因为专用工具没有 push/fetch 能力。

## 4. 结构化 `git_status`

适配器读取 NUL 分隔的 porcelain 输出：

```bash
git status --porcelain=v1 -z --untracked-files=all --ignored=no
```

不用面向人的普通 `git status`，因为它可能本地化，文本布局也不是稳定协议。`-z` 让带空格、换行或非 ASCII 字符的路径保持无歧义。

结果中的每项包含：

```ts
{
  path: "src/agent.ts",
  originalPath?: "src/old-agent.ts",
  index: "M",
  worktree: " ",
  kind: "ordinary" | "renamed" | "untracked" | "ignored",
}
```

`index` 是第一列，`worktree` 是第二列。rename/copy 在 `-z` 协议中还有第二个路径记录，解析器不会把它误当成另一个文件。

工具的 `content` 保留适合模型阅读的短行，`data.entries` 则供程序、事件日志和测试使用。仓库干净时明确返回 `clean: true`，而不是让调用方从空字符串猜测。

## 5. 结构化 `git_diff`

调用方必须明确选择 diff 视角：

```ts
git_diff({ mode: "worktree", paths: ["src/agent.ts"] });
git_diff({ mode: "staged", paths: [] });
```

工具执行带 `--no-ext-diff` 的 patch 读取，避免用户配置的 external diff 程序改变语义或启动额外进程；`--binary` 保留 Git 能表达的二进制变化。另一次 `--name-status -z` 调用产生结构化文件列表：

```ts
data: {
  mode: "worktree",
  paths: ["src/agent.ts"],
  empty: false,
  files: [{ status: "M", path: "src/agent.ts" }],
}
```

原始 patch 仍放在 `content` 中，因为 unified diff 本来就是模型和开发者最容易审阅的协议；结构化数据负责说明视角、筛选路径、是否为空以及变更文件身份。

## 6. 结构化 `git_log`

`git_log` 只接受 `1..100` 的 limit，不启动 pager。适配器通过固定控制字符分隔字段，返回：

```ts
{
  hash: "...",
  parents: ["..."],
  author: "Ada",
  authoredAt: "2026-07-23T08:00:00+08:00",
  subject: "add safe commit",
}
```

空的 unborn repository 返回 `commits: []`，不是把正常状态当成工具故障。限制条数既控制 token，也避免大仓库的一次调用读完整历史。

## 7. 归属来自 checkpoint，而不是模型

第 12 章的 checkpoint 已经在每次文件工具写入前后记录：

```ts
interface ActiveOwnedFile {
  path: string;
  version: { hash: string; mode: number } | null;
  chainIntact: boolean;
}
```

本章只增加一个只读视图 `activeOwnedFiles()`。它仅在 runtime turn 正在运行时返回数据，因此旧回合、Shell 修改和用户口头指定的路径都不会自动获得提交资格。

`version: null` 表示 Agent 删除了文件。普通版本同时验证完整字节 SHA-256 和 permission bits。只校验 diff 不够，因为用户可能在预览后修改文件；只校验内容也不够，因为 executable bit 变化会进入 Git tree。

同一回合多次写一个路径时，checkpoint 提供最终版本；如果用户修改夹在两次 Agent 写入之间，`chainIntact` 为 false，安全提交与 undo 都拒绝声称完整归属。

## 8. 为什么预览要使用临时 index

一种看似自然的两阶段做法是：先对真实 index 执行 `git add`，展示 `git diff --cached`，再等待 commit。问题是模型可能停止、Provider 可能报错、用户也可能取消回合，真实 index 会残留 staged 状态。

本章为预览创建临时目录并设置：

```ts
const env = {
  ...process.env,
  GIT_INDEX_FILE: temporaryIndex,
};
```

有 HEAD 时执行 `read-tree HEAD`，unborn repository 使用 `read-tree --empty`。之后只在临时 index 中 add 明确路径，调用 `write-tree` 得到 proposed tree，再读取 staged diff。`finally` 总会删除临时目录。若完整 diff 超过工具输出预算，prepare 会拒绝并要求减少路径或缩小修改，而不是返回一个截断后仍可提交的预览；token 放在输出开头，但只有完整预览通过预算检查后才会生效。

临时 `git add`/`write-tree` 可能在 `.git/objects` 中留下不可达 blob/tree 对象，所以 prepare 仍声明 `write_workspace` 权限；它保证不污染的是用户可见的 index、refs 和工作区。完成后：

- workspace 文件不变；
- 真实 `.git/index` 不变；
- HEAD 不变；
- 用户可以先看到将提交的精确 diff；
- token 绑定 HEAD、tree、路径和文件版本。

## 9. 为什么已有 staged 内容时直接拒绝

理论上可以创建新 commit 同时保留用户 index，但 HEAD 移动后，旧 index 的基准语义也会变化。复制和恢复 `.git/index` 字节并不能让它继续相对于新 HEAD 表达原来的 staged diff；临时 index + `commit-tree` 也不能消除这个问题。

因此本章选择可解释的安全默认值：只要真实 index 已有任何 staged 条目，`git_prepare_commit` 和 `git_commit` 都拒绝，要求用户先处理自己的 staged 状态。

这比“偷偷 stash”“提交后重建 index”保守，却满足最重要的约束：Agent 不覆盖、不合并、也不重新解释用户已有的 staged 内容。用户的 unstaged 和 untracked 文件不影响提交，只要它们不是 Agent 声称拥有的同一路径。

## 10. 真正提交前必须重做校验

预览通过不代表几秒后的提交仍安全。`git_commit` 使用一次性 token 找回 proposal，并重新检查：

1. 当前 HEAD 等于预览时的 HEAD；
2. 当前 index 仍没有 staged 内容；
3. 每个路径仍属于 active checkpoint；
4. ownership version 没有变化；
5. 磁盘 hash 和 mode 仍等于 Agent 最终版本；
6. 真实 index 显式 add 后的 `write-tree` 等于预览 tree。

只要一项不满足就拒绝。若真实 add 已发生而后续步骤失败，工具只对 proposal 的明确路径执行 scoped unstage，不使用 `git reset --hard`，也不触碰工作区文件。

commit 使用 `--no-gpg-sign` 避免交互签名卡住 CLI，并使用 `--no-verify` 防止仓库 hook 在安全提交边界内执行未建模的任意副作用。需要签名或 hook 的项目应由用户审阅后手工提交，或在后续章节为这些行为建立单独权限和结果协议。

## 11. push、rebase、reset 为什么没有专用工具

本章没有实现 `git_push`、`git_rebase`、`git_reset`：

- push 会改变远程状态并需要 network 权限；
- rebase 会批量重写提交与工作区；
- reset 容易同时改变 HEAD、index 和文件；
- checkout/switch 也可能覆盖未提交内容。

用户仍可明确授权 Shell 执行这些操作，但它们不会因为增加 Git 只读工具而获得低权限捷径。尤其不能用 `git reset --hard` 代替第 12 章的 ownership-aware undo。

## 12. 测试安全属性

测试在独立临时仓库中设置本地 author，不修改教程仓库。关键断言包括：

- status 区分 unstaged 与 untracked；
- diff 同时返回 patch 和结构化 name-status；
- log 返回限定数量的结构化 commit；
- prepare 后真实 `git diff --cached` 仍为空；
- commit 只包含 Agent-owned 文件；
- 用户 unstaged/untracked 文件保持原样；
- 用户已有 staged 内容时拒绝且 index 保持不变；
- 非 owned 路径不能进入 proposal；
- 预览后用户编辑 owned 文件会让 commit 拒绝；
- 失败时不产生 commit，也不遗留 staged 内容。

运行本章验收：

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

这些测试不访问 OpenAI 或 DeepSeek API。

## 13. 已知边界

当前 Git 工具的锁和校验是进程内协议。另一个 Git 进程若恰好在“最后检查 index”和“真实 add”之间并发修改 index，仍存在很短竞态；工具会尽量通过 tree 对比发现异常，但它不是跨进程事务锁。

归属只覆盖 `apply_patch`。`run_shell` 创建或修改的文件没有被文件 checkpoint 观察到，因此不能由 `git_prepare_commit` 自动提交。这个限制是有意的：无法证明来源时，宁可要求用户显式处理，也不伪造归属。

提交成功后，第 12 章的文件 checkpoint 仍可恢复工作区字节，但不会回退 Git HEAD。`/undo` 不是 Git history rewrite。已经 commit 的回合应通过新的 Git commit 反向修改，不能静默移动分支。

## 14. 本章验收清单

- [x] Git 子进程只使用参数数组，不拼 Shell 字符串。
- [x] repository root 必须等于 workspace root。
- [x] `git_status` 解析 NUL 分隔 porcelain 数据。
- [x] `git_diff` 区分 worktree/staged 并返回结构化文件列表。
- [x] `git_log` 有固定结构与条数上限。
- [x] 提交路径必须来自 active checkpoint ownership。
- [x] hash、mode 和 ownership chain 都进入提交前校验。
- [x] 临时 index 在不污染真实 staged 的情况下生成预览。
- [x] 真实 index 已有 staged 内容时拒绝。
- [x] commit 前重新检查 HEAD、index、文件与 proposed tree。
- [x] 失败清理只操作显式 Agent 路径。
- [x] 没有 `git add .`、`git add -A` 或整个工作区提交。
- [x] push、rebase、reset 没有低权限专用工具。

## 15. 下一章留下的问题

现在 Agent 能读取 Git 状态并安全提交自己的文件，但“运行测试”仍只是通用 Shell 输出。运行时还不能结构化地区分测试通过、命令启动失败、超时、取消和断言失败，也没有自动修复轮数与总预算。

第 14 章会建立测试—诊断—修复循环：以退出码和结构化 ToolResult 判断测试结果，保留 stderr，限制最大修复轮数、耗时和 token，并让最终报告明确区分“通过”“失败”和“未运行”。
