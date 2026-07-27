# 第 20 章：可观测性和工作流 Eval

前面的章节已经让 `dugsyn` 能运行、修改文件、执行测试、持久化 Session，并通过
MCP、Hooks 和 Skills 扩展能力。但“能运行”不等于“知道运行得怎么样”：

- 一次 turn 为什么慢？
- 时间花在 Provider 还是工具上？
- token 由哪一次请求产生？
- 权限在哪个工具调用上被拒绝？
- 同一个修复任务重复运行十次，成功率是否稳定？
- Agent 说“测试通过”时，仓库里的真实测试是否真的通过？

本章增加两套互补能力：

1. `TraceRecorder`：把 Runtime Event 转成 session、turn、Provider request 和
   tool call span。
2. `EvalRunner`：在全新的临时 Git 仓库中运行真实 Agent，再独立执行测试并读取
   diff/status 评分。

普通测试仍然使用 `MockProvider`，不会访问 OpenAI 或 DeepSeek。

## 1. Runtime Event 和 Trace 不是一回事

Runtime Event 是按顺序发生的事实，例如：

```text
turn_started
provider_request_started
usage
provider_response
tool_call_started
permission_decided
tool_call_finished
turn_finished
```

它适合终端渲染、Session 回放和协议传输。Trace 则回答父子关系、起止时间和聚合
指标：

```text
session
└── turn
    ├── provider request #1
    ├── tool call: apply_patch
    ├── tool call: run_tests
    └── provider request #2
```

因此本章没有另造一条执行管线。`TraceRecorder` 只观察已经存在的 Runtime Event，
执行结果仍由 Agent Loop 决定。

## 2. 增加 Provider 请求开始边界

第 9 章已经有 `provider_response`，但只有结束事件无法准确计算耗时。本章在真正
调用 `provider.stream()` 前发出：

```ts
export interface ProviderRequestStartedEvent extends EventBase {
  readonly type: "provider_request_started";
  readonly provider: string;
  readonly step: number;
}
```

结束时仍使用已有事件：

```ts
export interface ProviderResponseEvent extends EventBase {
  readonly type: "provider_response";
  readonly provider: string;
  readonly requestId: string;
  readonly finishReason: string;
}
```

`step` 是当前 turn 内从 1 开始的 Provider 调用序号。它不是全局 ID；跨 session
关联使用 trace/span ID。

`tool_call_started` 也被移动到真正调用工具执行器之前。如果在模型刚流出工具参数
时就开始计时，Provider 剩余流式时间会被错误算进工具 latency。现在时间线是：

```text
provider_request_started
        │
        ├── 流式 text / reasoning / tool arguments
        └── provider_response
                        │
                        └── tool_call_started
                                  │
                                  └── tool_call_finished
```

## 3. Trace 数据模型

`src/observability/trace.ts` 定义四类 span：

```ts
export type TraceSpanKind =
  | "session"
  | "turn"
  | "provider_request"
  | "tool_call";
```

每个 span 包含：

- `spanId` 和可选的 `parentSpanId`；
- `kind` 和低基数 `name`；
- `startedAt`、`endedAt` 和 `durationMs`；
- `running`、`ok`、`error` 或 `cancelled` 状态；
- 安全的结构化 attributes；
- token usage；
- 权限结论。

Runtime 创建时建立 session span。每个 `turn_started` 建立一个子 span；
Provider 和工具 span 都以对应 turn 为父节点。Runtime dispose 时关闭 session
以及意外遗留的子 span。

可以在代码中读取不可变快照：

```ts
const runtime = await CodingAgentRuntime.create({
  provider,
  workspaceRoot,
});

try {
  await runtime.runTurn({ transcript });
} finally {
  await runtime.dispose();
}

const trace = runtime.trace.snapshot();
console.log(JSON.stringify(trace, null, 2));
```

快照顶层也提供聚合指标：

```json
{
  "protocolVersion": 1,
  "traceId": "…",
  "sessionId": "…",
  "totals": {
    "usage": {
      "inputTokens": 1200,
      "outputTokens": 180,
      "cachedInputTokens": 600
    },
    "errors": 0,
    "permissionDecisions": 2
  }
}
```

token 只从 Provider span 聚合一次，不从 turn 和 session 重复相加。

## 4. 错误和未完整结束的 span

正常 Provider 请求由 `provider_response` 关闭。若流在完成前失败：

1. Agent Loop 发出不含栈信息的公开 `error` Runtime Event；
2. Trace 把当前 Provider span 标为 `error` 或 `cancelled`；
3. `turn_finished` 关闭 turn span；
4. Runtime dispose 最终关闭 session span。

工具结果为错误信封时，工具 span 记录：

```json
{
  "status": "error",
  "attributes": {
    "result": "error",
    "errorCode": "permission_denied"
  }
}
```

它不会复制完整错误正文。即使调用方异常中断，`finish()` 也会关闭仍在运行的
Provider、工具和 turn span，避免导出永远处于 `running` 的历史记录。

## 5. 默认不追踪敏感正文

可观测性最危险的错误，是为了调试方便把整个上下文复制到日志平台。本章的 trace
明确不保存：

- system/user prompt；
- Provider 请求 body；
- 工具 input；
- 工具 output；
- Hook payload 和子进程环境变量；
- MCP 鉴权信息；
- 权限 reason 原文；
- Provider 或工具错误正文。

它只保留 Provider 名称、工具名称、状态、稳定错误码、token、耗时、请求 ID 和
权限的 allow/deny/scope。这样仍能回答“哪个阶段失败”，又不会让 trace 变成第二份
Session 或 secret 仓库。

`RuntimeEvent` 与 Session 在前面章节已有自己的审计和持久化契约。生产部署若要把
trace 发往外部系统，还应在 exporter 边界再次应用字段 allowlist，而不是直接序列化
任意对象。

## 6. 为什么 Eval 必须使用临时 Git 仓库

只断言模型最后说了“完成”不是 Coding Agent Eval。模型可能：

- 没有修改文件；
- 修改了错误目录；
- 只更新测试来掩盖 bug；
- 声称测试通过但从未运行；
- 在已经被上一次运行修好的仓库中得到虚假成功。

本章每次重复运行都创建独立仓库：

```text
mkdtemp()
   │
   ├── 写入 fixture 文件
   ├── git init + initial commit
   ├── 创建绑定该 workspaceRoot 的 CodingAgentRuntime
   ├── 运行 Agent turn
   ├── 读取 Agent 产生的 git diff 和 git status
   ├── 独立执行验收命令
   ├── 计算正式得分
   └── 用 fs.rm() 清理准确的 mkdtemp 目录
```

每次运行从同一个 initial commit 开始，因此重复结果可比较。

## 7. `runAgent()` 是真实实现

`src/evals/runner.ts` 中的 `EvalRunner.runAgent()` 不是留给读者补写的抽象方法。
它会真正完成：

```ts
const trust = await WorkspaceTrust.create({
  workspaceRoot,
  trustedRoots: [workspaceRoot],
});

const runtime = await CodingAgentRuntime.create({
  provider,
  workspaceRoot,
  permissions: new PermissionEngine({
    trust,
    defaultDecision: "allow",
  }),
  observability: {
    sessionId: `eval:${scenario.name}`,
  },
});
```

把 `workspaceRoot` 传给完整 Runtime 非常关键。Runtime 再把同一个 canonical root
交给：

- 文件发现、读取和 Patch 工具；
- Checkpoint；
- Git 工具；
- Shell ProcessManager；
- `run_tests`；
- Context/Instructions。

不能只给 `apply_patch` 设置临时路径，而让 shell 或 Git 仍指向运行 Eval 的源码
仓库。

Eval 默认允许工具，是因为 fixture 本身就是受控、一次性的测试环境。生产 CLI 的
权限策略没有因此改变。

## 8. 定义一个可重复场景

场景由 fixture、prompt、Provider 工厂、独立测试命令和可选预期文件组成：

```ts
const scenario = {
  name: "repair answer",
  prompt: "把 answer 修复为 2，并运行测试。",
  files: {
    "package.json": JSON.stringify({ type: "module" }),
    "src/answer.js": "export const answer = 1;\n",
    "test/answer.test.js": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { answer } from "../src/answer.js";',
      'test("answer", () => assert.equal(answer, 2));',
      "",
    ].join("\n"),
  },
  provider: ({ workspaceRoot, runIndex }) => {
    // 普通测试返回新的 MockProvider。
    // 真实模型 Eval 也应在每次 run 创建新的 Provider 实例。
    return createScenarioProvider(workspaceRoot, runIndex);
  },
  test: {
    file: process.execPath,
    args: ["--test", "test/answer.test.js"],
    timeoutMs: 10_000,
  },
  expectedChangedFiles: ["src/answer.js"],
} satisfies EvalScenario;

const report = await new EvalRunner(scenario, {
  repeats: 5,
  preserveWorkspaces: "failures",
}).run();
```

独立测试命令使用 `file + args[]`，不拼接 shell 字符串。`cwd` 若提供，必须是
workspace 内的相对路径。子进程只继承 PATH、locale、临时目录等少量环境变量和场景
显式添加的值，不会默认继承模型 API key。

Provider 工厂每次接收新的 `workspaceRoot` 和 `runIndex`。不要跨 run 复用一个
已经消耗完脚本响应或保留对话状态的 Provider。

## 9. 使用真实测试、diff 和 status 评分

每次运行默认有三项检查：

| 检查 | 通过条件 |
| --- | --- |
| `agent_completed` | turn reason 为 `completed` |
| `tests_passed` | 独立验收进程未超时且 exit code 为 0 |
| `workspace_changed` | Git status 或 staged/worktree diff 非空 |

若场景提供 `expectedChangedFiles`，再增加：

| 检查 | 通过条件 |
| --- | --- |
| `expected_files_changed` | 每个预期路径都出现在 Git status 中 |

每个 `EvalRunResult` 有正式字段：

```ts
interface EvalRunResult {
  readonly passed: number;
  readonly total: number;
  readonly score: number;   // passed / total
  readonly success: boolean; // passed === total
}
```

不是把 `"3/4"` 塞进一段文本，调用方可以直接聚合、过滤或设 CI 阈值。Git 状态
在独立验收命令之前读取，避免 coverage 或临时产物被误算成 Agent 修改。结果同时
保留：

- Agent reason、step 数和测试循环摘要；
- 独立测试 stdout/stderr、exit code、超时和耗时；
- 真实 worktree/staged diff；
- 结构化 Git status；
- changed file 列表；
- 本次运行的 trace。

## 10. 重复运行的成功率和方差

单次成功不能证明工作流稳定。`repeats: 5` 会建立五个相互独立的仓库并产生：

```ts
interface EvalReport {
  readonly passed: number;       // 所有 run 通过的检查数之和
  readonly total: number;        // 所有 run 的检查数之和
  readonly successRate: number;  // 全项通过的 run 比例
  readonly scoreMean: number;    // 每次 passed/total 的平均值
  readonly scoreVariance: number;// 每次 score 的总体方差
}
```

例如五次得分为 `1, 1, 0.75, 1, 0.75`：

- `successRate = 3 / 5 = 0.6`；
- `scoreMean = 0.9`；
- `scoreVariance = 0.015`。

成功率回答“完整任务有多少次全对”；平均分回答“部分完成程度”；方差回答“表现是否
稳定”。三者不能互相替代。

普通 CI 应先使用确定性 Mock 场景验证 Eval 基础设施。真实模型 Eval 受采样、服务
状态和模型版本影响，应单独运行并记录 Provider/model 配置。

## 11. 临时目录安全

Eval 不构造：

```text
rm -rf <字符串>
```

它只删除 `mkdtemp()` 直接返回的准确目录：

```ts
const createdRoot = await mkdtemp(join(tempRoot, "dugsyn-eval-"));

try {
  // seed, Agent, test, score
} finally {
  await rm(createdRoot, { recursive: true, force: true });
}
```

fixture 文件名必须是 workspace 内的相对路径，`.git` 和逃逸路径会被拒绝；测试
`cwd` 同样不能逃逸。即使 seed 阶段失败，`finally` 仍会清理临时目录。

调试失败场景时可用：

```ts
preserveWorkspaces: "failures"
```

失败结果会返回 `workspaceRoot`。还可以设为 `"always"`；默认 `"never"`。

## 12. 验收

本章新增的测试覆盖：

- session/turn/Provider/tool 父子 span；
- Provider 和工具的非重叠执行边界；
- token 聚合、错误类别和权限结论；
- trace 中不存在 prompt、工具 input/output 和错误正文；
- Agent 在临时仓库中真实修改文件；
- 独立 Node test 的真实 exit code；
- worktree diff、Git status 和 changed files；
- 正式 `passed/total` 字段；
- 重复运行成功率、平均分和方差；
- 成功、失败和 seed 错误后的受控清理。

运行：

```bash
cd dugsyn
npm run typecheck
npm run test:eval
npm test
npm run build
npm run test:e2e
npm run test:mvp
```

这一章没有调用真实模型 API。完成后，`dugsyn` 不仅能执行 Coding Agent
工作流，还能用可检查、可重复的证据回答它执行得是否正确、稳定和安全。
