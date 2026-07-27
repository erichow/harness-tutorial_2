# 第 10 章：MVP 端到端验收

前九章分别实现了协议、Provider、Agent Loop、工具、文件编辑、Shell、权限和 CLI。本章不再添加一个孤立功能，而是回答一个更重要的问题：这些部件连在一起时，能否安全、可重复地完成一次真实编码任务？

本章结束后，我们会得到一条自动化验收路径：

```text
用户任务
  ↓
Mock Provider
  ↓
search_text → read_file → apply_patch → run_shell
  ↓              ↓              ↓
权限决策日志    文件哈希变化     真实退出码
  └──────────────┴──────────────┘
                  ↓
           RuntimeEventLog
```

对应代码 tag：`chapter-10`。

## 1. 验收场景

临时项目一开始有下面的配置：

```js
export const config = { timeout: 5000 };
```

测试要求 `timeout` 必须等于 `10000`。用户只说：

```text
把 timeout 从 5000 改为 10000，并运行测试。
```

Agent 必须完成以下步骤：

1. 用 `search_text` 找到配置。
2. 用 `read_file` 取得原文和 SHA-256。
3. 用该 hash 调用 `apply_patch`。
4. 修改前获得写入权限。
5. 用 `run_shell` 运行真实的 `node --test`。
6. 执行前获得进程权限。
7. 根据工具返回的真实 `exitCode` 生成总结。

这比“最后文件内容正确”更严格。Agent 如果猜测文件位置、伪造测试成功、跳过 hash 或绕过权限，即使结果碰巧正确，也不算通过。

## 2. 先补上权限事件缺口

第 8 章的 `PermissionEngine` 已经有内部 audit log，第 9 章的运行时协议也定义了 `permission_requested`。但是原来的 `ToolRegistry` 调用权限引擎时，没有把权限过程送回 Agent Loop。因此界面能直接显示交互提示，统一事件日志却看不到完整决策。

本章为 `authorize` 增加一个可选 observer：

```ts
await permissions.authorize(request, signal, async (event) => {
  // requested 或 decided
});
```

权限事件分成两类：

- `permission_requested`：只有真正需要用户确认时才产生。
- `permission_decided`：每次有效权限检查都会产生，包括规则自动允许、规则拒绝、会话授权复用和用户选择。

这个区分很重要。把每次策略检查都叫作“请求用户授权”，会让日志失真；只记录弹窗又无法证明自动规则是否生效。

`ToolRegistry` 负责把权限观察事件关联到当前 `toolCallId`。`requestId` 使用完整规范化请求的 SHA-256 fingerprint，因此相同的精确请求可以关联起来，而不会把一个长命令的前缀误当作同一授权。

最终事件形状如下：

```ts
interface PermissionDecidedEvent {
  type: "permission_decided";
  requestId: string;
  toolCallId: string;
  toolName: string;
  decision: "allow" | "deny";
  scope?: "once" | "session";
  reason: string;
}
```

所有事件仍由 `runTurn` 统一添加 `turnId`、`sequence` 和 `timestamp`。权限引擎不负责制造运行时序号，这避免了多个组件各自维护时钟和序列。

## 3. RuntimeEventLog 不是随手 push 的数组

`src/runtime/event-log.ts` 新增了 `RuntimeEventLog`。它在 append 时做三件事：

1. 用 Zod 的 `runtimeEventSchema` 验证事件。
2. 检查每个 turn 必须从 sequence 0 的 `turn_started` 开始，且序号连续。
3. 拒绝 `turn_finished` 之后继续追加事件。

```ts
const log = new RuntimeEventLog();

await runTurn({
  // ...
  emit(event) {
    log.append(event);
  },
});
```

日志还提供两个只读投影视图：

- `permissionDecisions`：本次或历次 turn 的权限结论。
- `fileChanges`：从成功的 `apply_patch` 结果中提取 `operation`、`path`、`beforeHash` 和 `afterHash`。

文件变化必须来自工具的真实 `ToolResult.data`。不能从模型文本里正则匹配“我修改了某文件”，也不能从模型提交的 patch 参数推断已经落盘。模型的意图和工具成功完成的事实不是一回事。

`toJSONLines()` 可以把日志转成 NDJSON：一行一个协议事件。当前章节只保存在内存中；后续加入 session 持久化时，可以直接使用这条稳定边界。

注意，事件日志包含工具参数和输出。将来落盘时仍需设置文件权限、保留周期和脱敏策略，不能因为它叫“日志”就默认可以公开。

## 4. 用 CodingAgentRuntime 统一产品组装

如果端到端测试自己临时拼一套组件，而 CLI 使用另一套组装逻辑，测试很容易“全绿但产品不能用”。因此本章增加 `src/runtime/coding-agent.ts`，并让 CLI 也使用它。

`CodingAgentRuntime` 统一拥有：

- Provider；
- 文件工具和 Shell 工具；
- Tool Registry；
- RuntimeEventLog；
- ProcessManager 的生命周期。

创建方式如下：

```ts
const runtime = await CodingAgentRuntime.create({
  provider,
  workspaceRoot,
  permissions,
  shell: { runner },
});

try {
  const result = await runtime.runTurn({ transcript, signal });
} finally {
  await runtime.dispose();
}
```

`runTurn` 每次都会从 Registry 创建新的 executor。第 5 章的重复调用检测是“单回合限制”；如果在整个 CLI 会话中复用同一个 executor，相同工具参数会在后续正常回合里被错误累计。本章通过统一组装顺便修正了这个生命周期边界。

`dispose()` 则终止 ProcessManager 仍持有的子进程，并且可以重复调用。CLI 在 `finally` 中调用它，因此 Provider 报错、输入结束或会话异常退出时，都会经过同一清理路径。

## 5. Mock Provider 需要根据真实结果继续回答

固定脚本适合测试简单流式协议，但最终总结必须依赖 Shell 的真实退出码。如果最后一句话也提前写死，测试只能证明“模型脚本会说测试成功”，不能证明它看过工具结果。

本章让 `MockProvider` 的每一步既可以是静态 response，也可以是函数：

```ts
new MockProvider([
  staticSearchCall,
  staticReadCall,
  staticPatchCall,
  staticShellCall,
  (request) => {
    const exitCode = readLastToolExitCode(request);
    return exitCode === 0
      ? textResponse("Tests passed with exit code 0.")
      : textResponse(`Tests failed with exit code ${exitCode}.`);
  },
]);
```

这个函数收到下一次真实 `ProviderRequest`。请求 transcript 中包含刚刚由 `run_shell` 返回的工具结果，因此最终回答由真实 `exitCode` 决定，同时整个测试仍然离线、确定且不消耗模型额度。

## 6. 完整事件时间线

成功验收时，核心事件顺序如下。中间的 `provider_response` 也会保留，这里为了阅读省略部分字段：

```text
turn_started

tool_call_started(search_text)
permission_decided(search_text, allow)       # 用户规则自动允许
tool_call_finished(search_text, success)

tool_call_started(read_file)
permission_decided(read_file, allow)          # 用户规则自动允许
tool_call_finished(read_file, success + hash)

tool_call_started(apply_patch)
permission_requested(apply_patch)
permission_decided(apply_patch, allow once)
tool_call_finished(apply_patch, success + before/after hash)

tool_call_started(run_shell)
permission_requested(run_shell)
permission_decided(run_shell, allow once)
tool_call_finished(run_shell, success + exitCode 0)

text_delta(final report)
turn_finished(completed)
```

测试会交叉核对：

- `tool_call_started` 的工具名正好是预期的四个步骤；
- 每个实际执行的工具都有 `permission_decided`；
- 只有写文件和启动进程产生交互提示；
- `fileChanges` 只有一条真实 update；
- Shell 工具结果中 `exitReason` 为 `exit`、`exitCode` 为 `0`；
- 最终文本报告相同退出码。

这类断言比快照整段终端文本更稳定，也更能定位故障属于 Provider、权限、工具还是渲染层。

## 7. 失败验收：文件和进程都要收干净

第二个场景故意制造两类故障：

1. `apply_patch` 使用正确 base hash，但 hunk 上下文不匹配。
2. 启动一个长时间运行的后台 Node 进程后，让 Provider stream 在 `response_completed` 前断开。

测试确认：

- `runTurn` 以 `error` 结束；
- 原文件逐字节保持原样；
- 目录里没有 `.dugsyn-*.tmp` 临时文件；
- EventLog 没有虚假的 `fileChanges`；
- 调用 `runtime.dispose()` 后，后台进程 PID 不再存活。

这里有一个重要边界：后台 job 在正常 CLI 会话中允许跨 turn 存活，因此“某个 turn 出错”不能擅自杀掉用户有意启动的所有 job。拥有应用生命周期的 `CodingAgentRuntime.dispose()` 才负责最终回收；CLI 必须把它放在 `finally` 中。

文件安全则由第 6 章的原子写入保证：先写同目录临时文件、同步、重新校验 base hash，最后 rename。任何前置失败都会保持目标文件不变，并在 `finally` 中清理临时文件。

## 8. 运行确定性 MVP 验收

普通测试不读取 `.env.local`，也不访问网络：

```bash
cd dugsyn
npm run test:mvp
```

它会创建临时目录，并在该目录里执行固定的 `node --test test/config.test.js`。测试使用 `HostSandboxRunner`，但作用域只有测试自己创建的 fixture 和固定命令；实际 CLI 仍使用第 8 章的“平台沙箱，否则 fail closed”策略。

完整项目验收仍然是：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## 9. OpenAI 与 DeepSeek 的真实 smoke test

离线 Mock 验收负责确定性，真实 Provider smoke test 负责验证模型确实会遵守工具协议。它默认跳过，只有显式选择 Provider 时才运行，避免普通 `npm test` 消耗额度。

如果 key 和 model 已放进 `dugsyn/.env.local`：

```bash
npm run test:mvp:live:local -- openai
npm run test:mvp:live:local -- deepseek
```

脚本只把所选 Provider 对应的 key/model 注入子测试进程，不会打印 key。需要的变量分别是：

```text
OPENAI_API_KEY + OPENAI_MODEL
DEEPSEEK_API_KEY + DEEPSEEK_MODEL
```

也可以自行准备环境变量后运行：

```bash
MVP_LIVE_PROVIDER=openai npm run test:mvp:live
MVP_LIVE_PROVIDER=deepseek npm run test:mvp:live
```

真实 smoke test 与 Mock 使用相同临时项目和 `CodingAgentRuntime`，并明确要求模型依次调用 `search_text`、`read_file`、`apply_patch`、`run_shell`。它验证最终文件、真实 Shell 成功结果和事件日志中的文件变化。

第一次实际运行 DeepSeek smoke test 时，Provider 连接、搜索和读取都成功，但模型连续生成了 8 个不符合自定义语法的 Patch，最终触发 `max_steps`。这暴露了一个 Mock 无法发现的问题：工具 schema 只说明参数是字符串，并不等于模型知道字符串内部的微型语言。

因此 `apply_patch` 现在同时在工具描述、`patch` 字段描述和格式错误结果中提供同一份完整契约：

```text
*** Begin Patch
*** Update File: path/to/file
@@ -1,1 +1,1 @@
-old line
+new line
*** End Patch
```

说明还明确要求不使用 Markdown fence，解释 hunk header、上下文/增删行前缀，以及 Add/Delete 的不同形式。格式解析失败时，模型会收到原始错误和这份可直接照用的示例，而不是只看到“header 不正确”。加入该契约后，相同 DeepSeek 端到端场景完成了 Patch、真实测试命令和最终总结。

这说明真实 Provider 测试的价值不只是检查 HTTP 适配器：它还能验证工具是否真正“对模型可用”。工具契约中的枚举、正则和类型约束服务于机器校验；描述、示例和可操作错误则服务于模型纠错，两者缺一不可。

这仍然是 smoke test，不应成为每次提交的硬门槛：模型服务可能限流、网络可能波动、模型输出也存在概率性。确定性回归应由 Mock 承担，真实测试用于发布前或 Provider 适配器变更后的兼容性检查。

## 10. 本章验收清单

- [x] Mock Provider 可以确定性完成搜索、读取、hash patch 和测试命令。
- [x] 最终总结由真实 Shell `exitCode` 驱动。
- [x] 每个工具调用都进入统一运行时事件日志。
- [x] 每次权限结论都产生 `permission_decided`。
- [x] 交互式授权额外产生 `permission_requested`。
- [x] 文件变化来自成功 ToolResult 的真实 before/after hash。
- [x] patch 失败不改变原文件、不遗留临时文件。
- [x] 应用释放时终止仍存活的进程树。
- [x] OpenAI/DeepSeek 都有显式启用的完整 smoke test。
- [x] `apply_patch` 契约经过真实 DeepSeek 测试并可完成完整流程。
- [x] CLI 和验收测试共用 `CodingAgentRuntime` 组装路径。

## 11. 下一章留下的问题

当前 `apply_patch` 已经使用 base hash 防止覆盖旧版本，事件日志也知道某个文件从哪个 hash 变到哪个 hash。但它还没有保存真正的 unified diff，也不能清楚回答“哪些行由本回合 Agent 修改”。如果文件在模型读取之后被用户或另一个工具修改，我们只能返回 hash 冲突，无法展示更完整的变更归属。

下一章会实现真实 Diff、并发冲突测试和本回合文件变更集合，为后续 checkpoint 与 `/undo` 打基础。
