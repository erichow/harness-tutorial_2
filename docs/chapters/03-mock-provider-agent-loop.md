# 第 3 章：Mock Provider 和最小 Agent Loop

前两章已经有 CLI 外壳、Transcript 和 RuntimeEvent，但还没有任何组件驱动一次对话。本章先不连接真实 API，而是用可编排的 Mock Provider 把 Agent 最重要的控制流做对。

对应代码快照：`chapter-03`。

## 1. 本章问题

Coding Agent 不是一次 `model.generate()` 调用。模型可能先回答，也可能请求一个或多个工具；工具结果要回填 Transcript，再次请求模型，直到模型明确结束、达到限制或用户取消。

如果这段循环和某家 SDK 写在一起，后面接入 GPT、DeepSeek、测试替身和不同 UI 时都会重复实现控制流。因此本章先建立一个厂商无关的核心。

## 2. 行为规格

本章结束后，运行时可以：

- 消费文本、推理摘要、usage 和完整工具调用事件。
- 把多个文本 delta 合并为稳定的 Transcript 内容块，同时原样发出 RuntimeEvent。
- 执行一次或连续多次工具调用，并把结果放进下一次 Provider 请求。
- 将未知工具、无效参数和工具异常变成 `tool_result` 错误，让模型有机会恢复。
- 在 `maxSteps` 耗尽时以 `max_steps` 结束。
- 在 Provider 流等待期间响应 `AbortSignal`，以 `cancelled` 结束。
- 拒绝缺少 `response_completed` 或结束原因自相矛盾的 Provider 流。

普通测试仍然不需要 API key，也不会产生模型费用。

## 3. 威胁和失败模型

本章主要防止失控循环、Provider 半截流、工具异常击穿进程，以及取消信号只停 UI 不停运行时。

这里的 `InMemoryToolExecutor` 不是安全边界：它没有工作区路径限制、权限确认或 OS 沙箱。它只是验证 Agent Loop 的最小执行端口。第 5 章会加入正式的 Tool Registry 和运行时 schema，后续安全章节再加入权限与执行隔离。

## 4. 控制流

一次 turn 的状态变化如下：

```text
turn_started
    │
    ▼
Provider.stream(transcript, tools, signal)
    │
    ├── text / reasoning / usage ──► RuntimeEvent + 聚合内容
    │
    └── tool_call ─────────────────► assistant message
                                      │
                                      ▼
                                  执行工具
                                      │
                                      ▼
                                   tool message
                                      │
                         未超限 ──────┘ 再次请求 Provider
    │
    ├── stop ───────────► completed
    ├── 达到 maxSteps ──► max_steps
    ├── AbortSignal ─────► cancelled
    └── 协议/调用错误 ───► error
```

`maxSteps` 统计 Provider response 的数量，而不是文本 delta 数量或工具个数。这样一个包含一千个 delta 的回答仍然只算一步。

## 5. Provider 契约

核心接口只有一个流方法：

```ts
interface Provider {
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
```

`ProviderRequest` 只包含内部 `Transcript`、工具定义和 `AbortSignal`。它不包含 OpenAI、DeepSeek 或其他 SDK 类型。

本章的流事件是：

- `text_delta`
- `reasoning_summary_delta`
- `tool_call`
- `usage`
- `response_completed`

最后一个事件是必要的。AsyncIterable 自然结束只能说明网络流关闭，不能说明模型正常完成。`response_completed.finishReason` 必须是 `stop` 或 `tool_calls`；下一章的真实适配器负责把各家 finish reason 翻译成这两个内部值。

查看 [`provider.ts`](../../dugsyn/src/providers/provider.ts)。

## 6. 可编排的 Mock Provider

Mock Provider 接收一组 response 脚本，每次 `stream()` 消费一个：

```ts
const provider = new MockProvider([
  {
    events: [
      {
        type: "tool_call",
        call: {
          type: "tool_call",
          id: "call-1",
          name: "echo",
          input: { text: "hello" },
        },
      },
      { type: "response_completed", finishReason: "tool_calls" },
    ],
  },
  {
    events: [
      { type: "text_delta", delta: "工具返回了 hello" },
      { type: "response_completed", finishReason: "stop" },
    ],
  },
]);
```

它还保存收到的 `requests`。测试可以直接确认第二次请求确实看到了第一次的 assistant tool call 和 tool result，而不是只检查最终字符串。

特殊脚本事件 `wait_for_abort` 只属于 Mock，不会进入公共 Provider 协议。它让取消测试可以稳定地停在一个未完成的流上，而不依赖计时器和真实网络。

查看 [`mock.ts`](../../dugsyn/src/providers/mock.ts)。

## 7. 最小工具执行端口

Agent Loop 依赖 `ToolExecutor`，而不是具体工具 Map：

```ts
interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  execute(
    call: ToolCallBlock,
    context: ToolExecutionContext,
  ): Promise<ToolResultBlock>;
}
```

`InMemoryToolExecutor` 为本章提供三种稳定错误代码：

| 情况 | `data.code` |
| --- | --- |
| 找不到工具 | `unknown_tool` |
| 参数检查失败 | `invalid_arguments` |
| handler 抛出异常 | `execution_failed` |

这些是工具结果，不会直接终止 turn。相比“遇到异常就退出”，把错误送回模型能支持修正参数或选择另一工具。取消是例外：检测到 signal 已中止后，运行时不会把取消伪装成普通工具错误。

查看 [`executor.ts`](../../dugsyn/src/tools/executor.ts)。

## 8. 实现 `runTurn()`

调用入口使用配置对象：

```ts
const result = await runTurn({
  provider,
  transcript,
  tools,
  signal,
  limits: { maxSteps: 12 },
  emit(event) {
    render(event);
  },
});
```

函数返回新的 Transcript，不修改调用者传入的对象。每个 turn 生成一个 `turnId`，事件 `sequence` 从 0 开始单调递增。`now` 和 `createId` 是可选测试缝，生产调用不需要提供。

每次 Provider response 的处理顺序是：

1. 逐个消费流事件，并即时调用 `emit()`。
2. 把相邻同类型文本 delta 合并为一个内容块。
3. 要求流中恰好出现一个合法的 `response_completed`。
4. 追加 assistant message。
5. 如果有工具调用，则逐个执行并追加 tool message，然后进入下一步。
6. 如果没有工具调用且 finish reason 是 `stop`，结束 turn。

Provider 声称 `tool_calls` 却没有发出工具，或发出了工具却声称 `stop`，都会变成 `provider` 类错误。这让适配器 bug 尽早暴露，不会悄悄生成错误会话状态。

查看 [`agent.ts`](../../dugsyn/src/runtime/agent.ts)、[`limits.ts`](../../dugsyn/src/runtime/limits.ts) 和 [`cancellation.ts`](../../dugsyn/src/runtime/cancellation.ts)。

## 9. 从第 2 章迁移

从上一章快照开始阅读差异：

```bash
git diff chapter-02..chapter-03
```

本章没有新增 npm 依赖。新增目录是：

```text
src/
├── providers/
│   ├── provider.ts
│   └── mock.ts
├── runtime/
│   ├── agent.ts
│   ├── cancellation.ts
│   └── limits.ts
└── tools/
    └── executor.ts
```

本章 tag：

```bash
git tag -a chapter-03 -m "Chapter 03: mock provider and minimal agent loop"
```

## 10. 测试

[`agent-loop.test.ts`](../../dugsyn/tests/unit/agent-loop.test.ts) 覆盖：

- 纯文本 delta 聚合、usage 和事件序号。
- 一次工具调用后回答。
- 单轮多工具与连续多轮工具调用。
- 未知工具、无效参数和工具异常后的恢复。
- 达到最大步数。
- Provider 流仍在等待时取消。
- Provider 未发送完成事件。

确定性的 ID 和时间注入使测试不需要模糊匹配随机值，也没有依赖固定延时的脆弱用例。

## 11. 动手实验

先删除某个 Mock response 末尾的 `response_completed`，运行测试，观察结果变成 `provider` 错误。这个实验说明“流关闭”和“模型正常结束”是两件事。

再把 `maxSteps` 改为 1，并让第一步请求工具。工具结果仍会记录到 Transcript，但运行时不会发起第二次模型请求，而是以 `max_steps` 结束。这保证每个外部调用都有明确上限。

最后在 `emit()` 中打印事件 JSON，确认同一个 turn 的 `sequence` 严格递增，文本可以边生成边展示，而 Transcript 只保存合并后的稳定内容。

## 12. 完成检查

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

普通测试只使用 Mock Provider。

## 13. 下一章留下的问题

现在控制流已经可以完全离线验证，但还不能调用真实模型。下一章会先接 OpenAI Responses API，再接 DeepSeek 的 OpenAI-compatible Chat Completions API，并让两个适配器通过同一组 Provider 契约测试。模型 ID 和 API key 都由外部配置提供；读者只配置自己拥有的 Provider 即可。
