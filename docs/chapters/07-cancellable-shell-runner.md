# 第 7 章：可取消的 Shell 执行器

上一章让 Agent 能读写项目，但它还不能执行构建、测试或项目脚本。本章加入前台命令、后台任务、超时、取消和有界输出，并把它们统一放进一个 `ProcessManager`。

对应代码快照：`chapter-07`。

## 1. Shell 工具真正难在哪里

下面这段代码能启动命令，却还不是合格的 Agent 工具：

```ts
spawn(command, { shell: true });
```

生产环境至少还要回答：

- 命令超时或用户取消时，shell 创建的子进程会不会继续运行？
- stdout 无限输出时，CLI 会不会耗尽内存？
- 后台任务由谁保存、查询、停止和回收？
- 命令能看到哪些环境变量，是否会继承 API key？
- `cwd` 能否逃出 workspace？
- 当前实现是否真的限制了文件和网络访问？

本章的执行路径是：

```text
Tool Registry 校验参数
→ ProcessManager 解析 workspace 内 cwd
→ 最小环境变量集合
→ SandboxRunner 启动完整 shell 命令
→ 记录独立进程组 / PID
→ byte-bounded stdout + stderr
→ timeout / AbortSignal / stop 统一终止
→ job snapshot + opaque output cursor
```

## 2. 为什么前台和后台共用一个 ProcessManager

`run_shell` 和 `start_job` 的区别只在于调用方是否等待，不应该各自实现一套 spawn、timeout 和 kill 逻辑：

```ts
const shell = await createShellTools({
  workspaceRoot: process.cwd(),
  maxCaptureBytes: 1_048_576,
  terminationGraceMs: 250,
});

const registry = new ToolRegistry(shell.tools);

// CLI/session 结束时必须调用。
await shell.processManager.dispose();
```

`ProcessManager` 为每次执行创建 job id。前台调用等待完成后返回，记录仍短暂保留，因此它和后台任务一样能用 `read_job` 继续读取分页输出。默认最多保留 64 条记录；到达上限时先淘汰已完成记录。如果 64 个任务仍都在运行，则拒绝继续启动，而不是无限积累进程引用。

查看 [`process-manager.ts`](../../dugsyn/src/tools/shell/process-manager.ts)。

## 3. 四个正式工具

本章注册四个工具：

| 工具 | 等待命令完成 | 用途 |
| --- | --- | --- |
| `run_shell` | 是 | 构建、测试和短命令 |
| `start_job` | 否 | dev server、watcher 等长任务 |
| `read_job` | — | 查询状态并增量读取输出 |
| `stop_job` | 是 | 停止进程树并等待退出 |

前两个工具接收相同参数：

```json
{
  "command": "npm test -- --run tests/unit/example.test.ts",
  "cwd": "dugsyn",
  "timeoutMs": 120000
}
```

`command` 是一个完整的 shell program，可以包含管道、重定向、`&&` 和子 shell。它不是一个可安全拆成“第一个可执行文件 + 参数”的数组。

因此下面的调用必须按整体判断：

```sh
ls && some-destructive-command
```

不能因为前缀是 `ls` 就把整条命令分类为只读。本章直接把 `run_shell` 和 `start_job` 的 side effects 固定为：

```ts
["execute_process", "network"]
```

第 8 章的权限层会据此询问或拒绝，但不会尝试用命令前缀充当安全边界。

查看 [`index.ts`](../../dugsyn/src/tools/shell/index.ts)。

## 4. cwd 仍受 workspace 边界约束

`cwd` 必须是使用正斜杠的 workspace 相对路径。执行前依次完成：

1. 拒绝 NUL、反斜杠和绝对路径。
2. 对词法路径检查 workspace 边界。
3. `realpath` 解析符号链接。
4. 再检查真实路径边界。
5. 确认结果是目录。

内部目录 symlink 可以作为 cwd，指向 workspace 外的 symlink 不可以。这和文件工具一样能阻止普通路径逃逸，但仍不是针对恶意本机竞态的 OS 隔离。

## 5. 最小环境，而不是复制 `process.env`

直接把 `process.env` 传给模型发起的命令，通常会泄露同一 CLI 进程中的模型 API key、云凭证和 CI token。

默认只继承运行 shell 所需的少量变量：

```text
PATH LANG LC_ALL LC_CTYPE TERM TMPDIR TMP TEMP
SystemRoot ComSpec PATHEXT
```

不默认传递 `HOME`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 等变量。应用确实需要额外变量时，宿主配置必须逐项添加：

```ts
await createShellTools({
  workspaceRoot,
  environment: {
    NODE_ENV: "test",
  },
});
```

这里的配置是显式授权，因此也可以有意传入凭证；CLI 不应偷偷猜测。

## 6. timeout、取消和停止共享终止路径

命令有六种退出原因：

```ts
type ProcessExitReason =
  | "exit"
  | "signal"
  | "timeout"
  | "cancelled"
  | "stopped"
  | "spawn_error";
```

- 正常或非零退出：`exit`，同时返回 `exitCode`。
- 外部信号退出：`signal`。
- 到达 deadline：`timeout`。
- 前台 `AbortSignal` 被触发：`cancelled`。
- 调用 `stop_job` 或 manager dispose：`stopped`。
- 进程无法启动：`spawn_error`。

timeout 是一条正常的工具结果，模型可以看到原因后调整命令。AbortSignal 不同：它代表整个当前 turn 被用户取消。`run_shell` 会先完成进程清理，再把取消向 Agent Loop 抛回，最终 turn 以 `cancelled` 结束，而不是把它伪装成普通工具错误。

第 9 章才会实现交互输入控制器和真实 SIGINT 绑定。本章已经固定底层契约：一次 Ctrl-C 只 abort 当前 turn 的 controller；ProcessManager 清理当前命令后仍可继续执行下一条命令，不能调用 `process.exit()`。

## 7. POSIX 进程组和 Windows 进程树

在 POSIX 上，shell 以 `detached: true` 启动，成为新进程组 leader。终止时向负 PID 发送信号：

```ts
process.kill(-pid, "SIGTERM");
```

grace period 后会再向整个组发送一次 `SIGKILL`；即使 shell leader 已先退出，也要清理可能忽略 TERM 的同组成员。正常退出的 close handler 还会 best-effort 清理命令遗留的同组进程。测试不是只检查父 shell，而是让后代进程延迟写 marker，确认 timeout 后 marker 永远没有出现。

Windows 没有等价的负 PID 进程组语义。本章使用：

```text
taskkill /pid <pid> /T /F
```

`/T` 请求终止整个子树，`/F` 强制关闭。Windows 的结束语义与 POSIX 的 TERM → grace → KILL 不完全相同，教程不会假装两者完全一致。后续 SandboxRunner 也必须分别实现平台行为。

## 8. 无限输出为什么不会撑爆内存

`BoundedProcessOutput` 按原始字节而不是 JavaScript 字符数计量。默认最多保留 1 MiB，并平均分成 head 和 tail：

```text
最早 512 KiB
... 被丢弃的中间区间 ...
最新 512 KiB
```

它同时记录 stdout/stderr 的来源和全局 byte offset。`read_job` 返回的 opaque cursor 绑定 job id 与 offset；把 A job 的 cursor 用到 B job 会被拒绝。

当输出还在增长时，cursor 指向当前末尾，可用于轮询新增内容。当输出超过保留上限时，结果明确报告：

- `totalBytes`
- `retainedBytes`
- `omittedBytes`
- 中间缺口提示

这比只截取前 100 KB 更有用：错误通常出现在输出尾部，同时开头仍保留命令初始化信息。它也准确承认被丢弃的中间内容无法恢复。

查看 [`output.ts`](../../dugsyn/src/tools/shell/output.ts)。

## 9. 后台任务的查询、停止与回收

启动：

```json
{
  "command": "npm run dev",
  "timeoutMs": 1800000
}
```

返回 `jobId` 后轮询：

```json
{
  "jobId": "...",
  "cursor": "上一页的 nextCursor"
}
```

停止：

```json
{
  "jobId": "..."
}
```

使用 `read_job` 清理已完成记录：

```json
{
  "jobId": "...",
  "cursor": "最后一页 cursor（如有）",
  "cleanup": true
}
```

运行中的任务不能 cleanup，仍有下一页输出时也不能 cleanup。session/CLI 关闭时无论模型是否主动停止 job，都必须调用 `dispose()`：它会停止全部运行中的进程，等待 close，然后清空引用。

## 10. SandboxRunner 边界与网络警告

ProcessManager 不直接承诺隔离。它只依赖一个可替换接口：

```ts
interface SandboxRunner {
  readonly status: {
    enforced: boolean;
    network: "isolated" | "unrestricted";
    warning?: string;
  };

  spawn(request: ShellSpawnRequest): ChildProcessWithoutNullStreams;
}
```

本章默认的 `HostSandboxRunner` 直接在宿主机执行，所以每次工具结果都会显示：

```text
warning: OS sandbox unavailable: command runs on the host and network access is not isolated.
```

它不通过禁止 `curl`、`wget` 来声称网络已关闭，因为 Node、Python、Git 或任意二进制都可以发网络请求。只有第 8 章接入的 OS sandbox runner 才能把 `network` 状态标成 `isolated`。

查看 [`sandbox-runner.ts`](../../dugsyn/src/tools/shell/sandbox-runner.ts)。

## 11. 测试策略

[`shell-tools.test.ts`](../../dugsyn/tests/unit/shell-tools.test.ts) 使用真实 shell 和真实 Node 子进程覆盖：

- timeout 终止 POSIX shell、子进程和孙进程。
- AbortSignal 清理当前命令，manager 随后仍可复用。
- 无限 stdout/stderr 的保留字节数不超过配置上限。
- 后台任务启动、轮询、停止和记录清理。
- workspace-relative cwd、`../` 逃逸和最小环境变量。
- 完整 compound command 不被 `ls` 等前缀降级为只读。
- 输出 cursor 分页及跨 job cursor 拒绝。
- 通过真实 Agent Loop 取消正在执行的 shell tool。
- 无沙箱时，工具结果包含明确网络警告。

Windows 使用独立实现分支；POSIX 进程组的 marker 测试只在 POSIX 运行。

## 12. 从第 6 章迁移

查看完整差异：

```bash
git diff chapter-06..chapter-07
```

新增结构：

```text
src/tools/shell/
├── index.ts             # 四个 Tool 定义与结果格式
├── output.ts            # byte-bounded head/tail 与 cursor
├── process-manager.ts   # 生命周期、timeout、取消和进程树
└── sandbox-runner.ts    # 可替换执行边界与宿主机 fallback

tests/unit/
└── shell-tools.test.ts
```

没有新增运行时依赖。

## 13. 完成检查

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

本章只测试本地进程工具，不需要 GPT 或 DeepSeek API，也不读取 `.env.local`。

本章 tag：

```bash
git tag -a chapter-07 -m "Chapter 07: add cancellable shell runner"
```

## 14. 动手实验

先把 `maxCaptureBytes` 临时设为 4 KiB，运行一个持续输出 stdout 和 stderr 的命令。观察 total、retained、omitted 三个计数，再沿 cursor 翻页，确认开头、缺口提示和结尾都可见。

然后启动一个每秒输出时间的后台 job，轮询两次，调用 `stop_job`，最后用 `cleanup: true` 读取并回收。确认回收后同一 job id 返回 `Unknown job`。

最后尝试输出一个只存在于父 CLI 环境中的临时变量，确认默认子进程看不到它；再通过 `environment` 显式加入并重试。

## 15. 下一章留下的问题

Agent 现在真的能执行任意 shell program，但默认 HostSandboxRunner 也意味着它继承当前用户权限，文件和网络都没有 OS 隔离。下一章会加入 Workspace Trust、allow/ask/deny 权限决策和真正可替换的沙箱执行策略，让“能执行”与“被允许执行”成为两个独立阶段。
