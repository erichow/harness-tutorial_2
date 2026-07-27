# 第 14 章：测试—诊断—修复循环

第 13 章让 Agent 能安全提交自己拥有的修改，但验证仍只有通用 `run_shell`：模型能看到进程输出，却没有一个稳定字段说明“测试到底通过了吗”。如果把模型生成的总结当成结果，`command finished`、`0 tests found`、超时甚至启动失败都可能被误报成成功。

本章增加专用 `run_tests` 工具和回合级测试策略。退出原因与退出码由运行时读取，stdout、stderr 分开保留；测试失败不会终止 Agent Loop，Agent 可以读取相关代码、继续修改并重新测试。运行时同时限制测试次数、修复轮数、总时长和 Provider 报告的 token。

对应代码 tag：`chapter-14`。

## 1. 为什么不能只提示模型“记得运行测试”

通用 Shell 只回答进程发生了什么：

```text
status: exited
exit_reason: exit
exit_code: 1
```

“进程已经退出”和“测试通过”是两个判断。退出码 `0` 通常表示测试 runner 成功；非零退出可能是断言失败、配置错误或测试文件无法加载；没有正常退出则可能是超时、信号终止或启动失败。

这条分类必须由程序完成：

```text
exit + code 0      → passed
exit + nonzero     → failed
timeout            → timed_out
signal/stopped     → signalled
spawn_error        → spawn_failed
```

模型可以解释错误原因，但不能决定真实退出码，也不能把自己的自然语言结论升级成自动化事实。

## 2. 专用 `run_tests` 工具

工具输入保持很小：

```ts
run_tests({
  command: "npm test",
  cwd: ".",
  timeoutMs: 120_000,
});
```

测试脚本本质上仍能启动任意项目代码，因此 `run_tests` 与 `run_shell` 一样声明：

```ts
sideEffects: ["execute_process", "network"]
```

它不会因为名字里有 test 就自动获得较低权限。Workspace Trust、沙箱和权限引擎仍在工具执行前生效；默认 CLI 沙箱关闭网络，平台无法提供沙箱时按第 8 章的 fail-closed 策略处理。

工具复用第 7 章的 `ProcessManager`，所以 cwd 仍必须位于 workspace 内，环境变量仍经过 allowlist，子进程仍有超时、取消、进程树清理和有界输出。

## 3. Tool 成功不等于 Test 通过

这是本章最重要的结果语义。一次断言失败时：

```ts
{
  status: "success",       // run_tests 工具正常完成并取得了进程结果
  data: {
    testStatus: "failed",  // 测试没有通过
    outcome: "failed",
    exitReason: "exit",
    exitCode: 1
  }
}
```

如果把非零退出直接做成 `ToolResult.status: "error"`，Agent 会难以区分“测试如预期运行并发现 bug”和“工具输入无效、权限被拒或执行器自身坏了”。本章把两层状态分开：

- `ToolResult.status` 描述工具协议是否成功；
- `data.testStatus` 描述测试是否通过；
- `data.outcome` 描述失败类别；
- `error.code` 只用于参数、权限、重复调用、预算等工具级错误。

这样失败结果仍能作为正常观察进入下一次 Provider 请求，Agent 可以据此诊断。

## 4. stdout 和 stderr 必须分开

第 7 章为人类阅读保留了按到达顺序合并的输出，并用 `[stdout]`、`[stderr]` 标记来源。测试诊断还需要独立通道，因为许多 runner 把失败摘要、stack trace 或编译错误写入 stderr。

`ProcessManager` 现在同时维护：

```text
combined arrival-order output
stdout-only bounded output
stderr-only bounded output
```

`run_tests` 的模型可读内容明确分段：

```text
test_status: failed
outcome: failed
exit_reason: exit
exit_code: 1

stdout:
...

stderr:
...
```

结构化数据不复制大段文本，只记录每个通道的 `totalBytes`、`retainedBytes`、`omittedBytes`、`pageTruncated` 和 `empty`。真实输出继续受 byte budget 限制；超大日志不会无限进入内存或上下文，但 stderr 的存在与来源不会被吞掉。

## 5. 失败以后为什么 Agent Loop 不停止

测试失败是编码循环中的观察，不是 Provider 或 Runtime 故障。一次正常修复流程是：

```text
run_tests → failed
    ↓
read_file / search_text 定位相关实现
    ↓
apply_patch 修改
    ↓
run_tests → passed 或再次 failed
    ↓
最终报告
```

现有 Agent Loop 本来就会把每批 ToolResult 追加到 Transcript，再请求下一次 Provider 响应。本章不增加一个写死的“自动修 bug 算法”，而是在这个通用循环外包一层确定性测试策略。模型仍负责选择读哪些代码、如何修复；运行时负责事实和预算。

单元测试用脚本 Provider 验证了完整序列：失败测试、读取源码、成功 patch、再次测试通过。最终摘要必须是 `runs: 2`、`repairRounds: 1`，而不是从最后一段模型文本推断。

## 6. 修复轮次怎样计数

“一次 patch 就算一轮”会过于严格：一个逻辑修复经常需要同时改实现、类型和测试。本章定义：

> 测试失败后，第一次成功的 `apply_patch` 开始一个修复轮次；下一次 `run_tests` 前的其他成功 patch 都属于同一轮。

例如：

```text
test failed
apply_patch src/a.ts    ┐
apply_patch src/a.test  ├─ repair round 1
apply_patch README      ┘
test failed
apply_patch src/a.ts    ── repair round 2
test passed
```

失败的 patch 不消耗修复轮次，因为磁盘没有发生成功修改。读取和搜索也不消耗轮次。下一次测试失败后才允许开始新一轮；达到上限时，新的 `apply_patch` 返回：

```ts
error.code = "limit_reached"
```

已有失败结果仍保留，Agent 应停止编辑并如实报告剩余问题。

## 7. 每回合的五种预算

`TurnLimits` 从单一的 `maxSteps` 扩展为：

```ts
{
  maxSteps: 12,
  maxDurationMs: 600_000,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 100_000,
  maxTestRuns: 4,
  maxRepairRounds: 3,
}
```

这些限制解决不同失控方式：

- `maxSteps` 防止 Provider/Tool 无限往返；
- `maxDurationMs` 覆盖 Provider、权限等待和工具执行的整回合墙钟时间；
- `maxInputTokens` / `maxOutputTokens` 累加 Provider usage 事件；
- `maxTestRuns` 防止反复运行昂贵测试；
- `maxRepairRounds` 防止失败后无休止改代码。

总时长使用组合 `AbortSignal`。到期时当前 Provider 或工具收到取消信号，子进程仍通过 ProcessManager 清理，回合结束原因是 `max_duration`，不会伪装成用户按 Ctrl-C 的 `cancelled`。

token 限制依赖 Provider 的结构化 usage。运行时在每次 Provider 响应后累计，超过预算便以 `max_tokens` 结束，并且不会执行这次响应中尚未开始的工具调用。它不是逐 token 的硬截断：Provider 必须先报告 usage，运行时才能核算，这一点不能靠估算隐藏。

## 8. 测试次数为什么只统计有效结构化结果

权限拒绝、Schema 错误或 `limit_reached` 没有真正取得测试进程结论，因此不增加 `runs`。一次 `run_tests` 只有在返回成功信封并包含受支持的 `outcome` 后才进入摘要。

当前 outcome 白名单是：

```text
passed
failed
timed_out
signalled
spawn_failed
```

最后一次有效结果通常决定最终 `status`。因此“先失败、修复、再通过”是 passed；“先通过、之后回归失败”是 failed。若通过后又发生成功的 `apply_patch`，原结果无法验证新字节，状态会失效为 `not_run`，直到重新测试；摘要仍保留历史 runs 和 lastOutcome 供审计。最后的具体 outcome 也让 CLI 能区分普通断言失败和超时。

## 9. 最终报告不能交给模型自证

模型最终可能说“所有测试都通过了”，但如果它没有调用 `run_tests`，运行时必须显示未运行。本章让 `RunTurnResult` 和 `turn_finished` 事件携带：

```ts
interface TestRunSummary {
  status: "not_run" | "passed" | "failed";
  runs: number;
  repairRounds: number;
  lastOutcome?: string;
}
```

CLI Renderer 根据这份结构化状态固定输出：

```text
Tests: passed (2 runs).
Tests: not run.
Tests: failed (timed_out).
```

这里的英文行来自运行时，不来自模型文本。为了兼容第 9 章已经保存的旧事件，event schema 读取时允许历史 `turn_finished` 不带 `tests`；本章新产生的事件总会带摘要。

要注意，“未运行”不是“失败”，也不是“通过”。例如只修改文档时，不运行测试可能完全合理，但报告必须让用户知道这个事实。

## 10. 通用 Shell 与测试工具的边界

`run_shell` 没有被删除。它仍适合：

- 查看版本；
- 运行生成器；
- 执行一次性诊断；
- 启动非测试命令。

但验证代码变更时应使用 `run_tests`。只有专用工具的结果会进入 `TestRunSummary`，所以通过 `run_shell({command: "npm test"})` 得到退出码 `0`，最终报告仍是 `not_run`。这是一条有意的协议边界：运行时不能仅凭任意 Shell 字符串安全判断它是不是测试。

同理，`run_tests` 不自动选择测试命令。不同仓库可能使用 npm、pnpm、pytest、cargo 或自定义脚本；模型根据项目文件选择命令，权限层决定是否允许，结果层只负责准确分类。

## 11. 取消、超时与清理

测试工具自己的 `timeoutMs` 到期时，ProcessManager 终止进程树并返回 `outcome: timed_out`，这是一个可诊断的测试失败，Agent 还可以决定缩小测试范围或修复挂起代码。

用户 Ctrl-C 不同：活动回合的 signal 会取消 `run_tests`，ProcessManager 清理子进程后把取消传播给 Runtime，整回合以 `cancelled` 结束。用户明确取消后不应让模型继续自动修复。

总回合时长到期也会取消当前进程，但结束原因是 `max_duration`。这三个状态不能合并：

```text
test timeout      → 测试结果 timed_out，可继续循环
user Ctrl-C       → 回合 cancelled
turn wall clock   → 回合 max_duration
```

## 12. 测试覆盖

本章新增的离线测试覆盖：

- exit code 0 映射为 passed；
- exit code 7 映射为 failed，但 ToolResult 仍成功；
- stdout 与 stderr 分开返回；
- 测试超时映射为 timed_out；
- 失败后可读取、patch、重新测试并通过；
- 同一失败后的多个 patch 只算一轮；
- 下一修复轮超过上限时被阻止；
- 测试次数超过上限时被阻止；
- 测试通过后的新 patch 会让通过结论失效；
- token 超限后不执行尚未开始的工具；
- 墙钟超时能取消挂起 Provider；
- CLI 分别渲染 passed、failed、not run。

运行本章验收：

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

测试使用临时 workspace 和本机 Node 子进程，不访问 OpenAI 或 DeepSeek API。

## 13. 已知边界

测试成功依赖命令自身遵守“退出码表达结果”的惯例。若项目脚本吞掉内部 runner 的非零退出并强制 `exit 0`，外层运行时无法知道断言其实失败；应先修复项目脚本。

本章不解析 Jest、Vitest、pytest 或 cargo 的框架专属报告，所以没有精确的 passed/failed case 数量。后续可在不改变基础 outcome 协议的前提下增加 JUnit/JSON adapter。

stdout/stderr 是按通道独立有界保存的，两个通道之间的精确交错顺序仍以 ProcessManager 的 combined output 为准。`run_tests` 优先提供诊断来源，不承诺重放终端动画、颜色或交互式 TTY。

修复轮次只观察专用 `apply_patch`。模型若经授权用 `run_shell` 改文件，这些修改既不计入 repair round，也不获得第 13 章的 Git ownership；因此编码变更仍应使用文件工具。

## 14. 本章验收清单

- [x] 新增专用 `run_tests`，不从任意 Shell 字符串猜测试。
- [x] 运行时根据 exit reason/code 生成测试结论。
- [x] Tool 成功和 Test 通过是两个独立状态。
- [x] stdout、stderr 独立有界保存，stderr 不被吞掉。
- [x] 测试失败后 Agent Loop 可以继续读取和修改。
- [x] 第一次成功 patch 开始修复轮次，同轮可包含多个 patch。
- [x] 最大测试次数和最大修复轮次由运行时强制执行。
- [x] 总时长通过取消信号覆盖 Provider 与工具。
- [x] Provider usage 累计进入 input/output token 上限。
- [x] 最终事件和 CLI 区分 passed、failed、not run。
- [x] 通过后继续修改会失效为 not run，不能复用旧结论。
- [x] 用户取消、测试超时和回合超时语义不同。
- [x] 所有新增验收均为离线测试。

## 15. 与原教程的关系

本章主要吸收原教程的三组能力：ch17 的代码智能闭环、ch27 的内置命令入口和 ch34 的任务状态思想。实战实现没有照搬某个框架，而是把它们收敛成当前 TypeScript Runtime 已有的 Provider、ToolResult、ProcessManager、RuntimeEvent 四条协议边界。

## 16. 下一章留下的问题

现在一次进程内回合能完成有预算的测试—修复循环，但 CLI 退出后 Transcript、RuntimeEvent、测试摘要和权限审计都会丢失。异常退出也无法恢复到上次对话，多个进程还可能同时写同一份会话。

第 15 章会实现 Session 持久化、恢复和分支：版本化 JSONL、session metadata、`--resume`、`--fork-session`、Schema 迁移、单写者锁和人类可读导出。
