# 第 4 章：GPT / DeepSeek Provider 和流式工具调用

上一章已经用 Mock Provider 验证了 Agent Loop。本章接入两种真实协议：GPT 使用 OpenAI Responses API，DeepSeek 使用 OpenAI-compatible Chat Completions API。两者最终都只向运行时暴露第 3 章定义的 `ProviderStreamEvent`。

对应代码快照：`chapter-04`。

> 本章协议根据 2026-07-22 的官方文档核对。模型名称变化比协议更频繁，所以源码没有默认 model；请填写自己账户当前可用的模型 ID。

## 1. 本章问题

“OpenAI-compatible”不等于所有接口完全相同。OpenAI Responses API 把输出组织成 response item；DeepSeek 的兼容接口使用 Chat Completions message 和 choice delta。文本看起来都能流式输出，但工具调用、usage、完成原因和多轮状态的形状并不一样。

如果 Agent Loop 直接判断这些厂商事件，它很快会变成两套交错的状态机。本章把差异限制在适配器内部：

```text
OpenAI Responses SSE ──► OpenAIResponsesProvider ──┐
                                                   ├──► ProviderStreamEvent
DeepSeek Chat SSE ─────► DeepSeekChatProvider ─────┘
```

官方资料：

- [OpenAI Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)

## 2. 行为规格

本章结束后：

- GPT 文本、reasoning summary、工具参数 delta 和 usage 能被解析。
- DeepSeek 文本、工具参数 delta、usage 和 finish reason 能被解析。
- 同一次工具调用跨多个 delta 的 JSON 参数只在完整后解析。
- 两个适配器都记录 Provider 名称、请求 ID 和原始完成原因。
- HTTP 错误不会泄漏 API key，并区分可重试状态。
- 流中断时，已经展示的文本会保留进 Transcript，同时 turn 明确以 `error` 结束。
- 原始 reasoning/thinking 不进入公共 RuntimeEvent。
- 普通测试只读取录制 SSE fixture，不连接网络。
- GPT 和 DeepSeek 的真实 smoke test 可以彼此独立运行。

## 3. 两种协议的差异

| 能力 | OpenAI Responses | DeepSeek Chat Completions |
| --- | --- | --- |
| Endpoint | `/v1/responses` | `/chat/completions` |
| 文本 delta | `response.output_text.delta` | `choices[0].delta.content` |
| 工具身份 | `item_id` + `call_id` | `tool_calls[].index` + `id` |
| 工具参数 | `response.function_call_arguments.delta` | `delta.tool_calls[].function.arguments` |
| 完成 | `response.completed` | `finish_reason` 后以 `data: [DONE]` 终止 |
| Usage | completed response 内 | `include_usage` 的额外 chunk |
| 多轮状态 | 可用 `previous_response_id` | 每次发送完整 messages |
| 可公开推理信息 | reasoning summary | 没有独立 summary；`reasoning_content` 是原始 thinking |

适配器不能因为字段名字相似就共用一套未经验证的 parser。真正共用的是输出契约和 SSE/HTTP 基础设施。

## 4. 不使用厂商 SDK 的原因

本章使用 Node.js 22 自带的 `fetch` 和 Web Streams，不增加 npm 依赖。这样做不是否定官方 SDK，而是让教程直接展示协议边界：

- `http.ts` 只负责认证头、POST、HTTP 状态和有限长度的错误文本。
- `sse.ts` 只负责按 Server-Sent Events 规则读取 `data:`，并忽略 keep-alive comment。
- 两个 Provider 各自验证和解释 JSON event。

网络层支持注入 `FetchLike`。测试可以返回标准 `Response`，生产代码则使用 `globalThis.fetch`。

查看 [`http.ts`](../../agent-code/src/providers/http.ts) 和 [`sse.ts`](../../agent-code/src/providers/sse.ts)。

## 5. OpenAI Responses Provider

创建 Provider 时必须传入 key 和 model：

```ts
const provider = new OpenAIResponsesProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  reasoning: {
    effort: "medium",
    summary: "auto",
  },
});
```

示例中的 reasoning 参数不是全局默认值。不同模型支持的 effort 可能不同，调用者应按所选模型配置；不需要 summary 时可以完全省略 `reasoning`。

### 5.1 请求映射

内部工具定义映射为 Responses function tool：

```ts
{
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
}
```

Transcript 中的工具调用映射为 `function_call`，结果映射为 `function_call_output`。这里必须使用 `call_id` 关联结果，不能拿 response item 的 `id` 代替。

### 5.2 参数累积

Responses API 会先发送 `response.output_item.added`，随后发送多个 `response.function_call_arguments.delta`，最后发送 done event。适配器以 `item_id` 找到累积器，持续拼接字符串，只在 done 后执行一次 `JSON.parse`。

模型生成的 JSON 即使语法正确也仍是不可信输入。第 5 章的 Tool Registry 会继续用工具 schema 校验字段；本章只保证它是 JSON object。

### 5.3 reasoning 和续接

OpenAI 官方文档要求 reasoning model 在工具回合中保留对应 reasoning item。当前实现为每个会话使用一个 Provider 实例，并在成功响应后记录 `previous_response_id`：

```text
第一次请求：完整 Transcript
第二次请求：previous_response_id + 新增 function_call_output
下一用户回合：previous_response_id + 新增 user message
```

请求显式使用 `store: true`。这是一项真实的数据治理取舍，不应被隐藏：如果你的政策不允许服务端保存 response，不要直接使用这一续接方式。后续会话章节可以改为保存并回传加密 reasoning item，或限制到不需要 reasoning continuation 的模型配置。

只有 `response.reasoning_summary_text.delta` 会成为 `reasoning_summary_delta`。原始 `response.reasoning_text.delta` 被忽略。

查看 [`openai-responses.ts`](../../agent-code/src/providers/openai-responses.ts)。

## 6. DeepSeek Chat Provider

创建 DeepSeek Provider：

```ts
const provider = new DeepSeekChatProvider({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.DEEPSEEK_MODEL!,
  thinking: "disabled",
});
```

教程默认显式发送 `thinking: { type: "disabled" }`。如果需要 thinking，可以改为 `enabled` 并按模型支持范围设置 `reasoningEffort`。

### 6.1 Chat 消息映射

DeepSeek 是无状态 Chat API，因此每次都发送完整 messages：

- system/user/assistant 文本映射为同名 role。
- assistant 的工具调用映射为 `tool_calls`。
- 每个内部 `tool_result` 展开为单独的 tool message。
- 工具定义使用 Chat Completions 的 `{ type, function: { ... } }` 包装。

### 6.2 按 index 累积工具调用

后续 delta 可能不重复发送工具 ID 和函数名，但会保留 `index`。所以适配器以 index 建表，分别累积 `id`、`name` 和 `arguments`，收到 `[DONE]` 后按 index 排序并输出工具调用。

只有 `stop` 和 `tool_calls` 能进入公共完成事件。`length`、`content_filter` 或资源不足不会伪装成正常答案，而是产生带原始 code 的 `ProviderError`。

### 6.3 不展示原始 thinking

DeepSeek 的 `reasoning_content` 是原始 thinking，不是面向用户生成的 summary。本项目不会把它发成 `reasoning_summary_delta`。

thinking 模式产生工具调用时，适配器会在内存中暂存该字段，只回填给紧接着的 DeepSeek 工具续接请求。它不会进入 Transcript、日志或 CLI 事件。Provider 实例丢失后这段暂存状态也会丢失，因此会话恢复需要在后续章节设计独立的私有 Provider state。

查看 [`deepseek-chat.ts`](../../agent-code/src/providers/deepseek-chat.ts)。

## 7. Provider 元数据事件

第 3 章的 `response_completed` 现在包含：

```ts
{
  type: "response_completed";
  finishReason: "stop" | "tool_calls";
  requestId: string;
  providerFinishReason: string;
}
```

Agent Loop 把它转换为可序列化的 `provider_response` RuntimeEvent：

```ts
{
  type: "provider_response";
  provider: string; // 例如 openai、deepseek 或 mock
  requestId: string;
  finishReason: string;
}
```

一次用户 turn 可能调用 Provider 多次，所以这些字段不能塞进唯一的 `turn_finished`。每个 response 单独记录，才能计算 usage、定位厂商请求日志并分析停止原因。

## 8. HTTP 错误、断流和重试边界

`ProviderError` 保存 `status`、`code`、`requestId` 和 `retryable`。当前只把 408、409、429 和 5xx HTTP 状态标为可重试。

本章没有自动重试。原因是“可重试”只表示错误类型可能暂时恢复，不表示重放整个 Agent turn 一定安全。未来加入 retry 时，只能自动重试尚未执行工具副作用的 Provider 阶段。

如果流已经输出文本后断开：

1. 文本 delta 已经通过 RuntimeEvent 展示。
2. Agent Loop 把完整的文本和 summary 内容块保存为一条 assistant message。
3. 未完成的工具调用不会保存，也不会执行。
4. 发出 provider 类 error 和 `turn_finished: error`。

这样 UI 展示和 Transcript 不会互相矛盾，也不会误执行半截 JSON 工具调用。

## 9. 录制协议测试

测试 fixture 位于 `tests/fixtures/providers/`，包含：

- OpenAI 工具调用、文本完成和截断流。
- DeepSeek 工具调用、文本完成、keep-alive 和截断流。
- 跨多个 delta 的 `{"city":"Shenzhen"}` 参数。
- input/output/cache token usage。

[`provider-adapters.test.ts`](../../agent-code/tests/unit/provider-adapters.test.ts) 对两个 Provider 运行同一份归一化契约断言：

```text
text_delta
→ tool_call
→ usage
→ response_completed
```

测试还检查两家的请求 body，而不仅是输出事件，防止适配器“测试能过但真实请求格式错误”。

## 10. 配置和真实 smoke test

不要把 key 写入源码、fixture、Git 配置或教程命令历史。当前 `.gitignore` 已排除 `.env` 和 `.env.*`（但允许无密钥的 `.env.example`）；本章示例使用临时环境变量：

只测试 GPT：

```bash
cd agent-code
read -s OPENAI_API_KEY
export OPENAI_API_KEY
export OPENAI_MODEL='<model-id-available-to-you>'
npm run test:smoke
unset OPENAI_API_KEY OPENAI_MODEL
```

只测试 DeepSeek：

```bash
cd agent-code
read -s DEEPSEEK_API_KEY
export DEEPSEEK_API_KEY
export DEEPSEEK_MODEL='<model-id-available-to-you>'
npm run test:smoke
unset DEEPSEEK_API_KEY DEEPSEEK_MODEL
```

两组测试分别判断自己的 key 和 model。没有配置的一组显示 skipped，不会阻止另一组运行。普通 `npm test` 也会跳过全部真实 API 测试。

模型 ID 不设默认值，是为了避免教程把已经迁移或即将弃用的名字长期固化在源码里。运行 smoke test 前请在对应厂商控制台或官方模型页面确认你账户可用的 ID。

## 11. 从第 3 章迁移

查看完整差异：

```bash
git diff chapter-03..chapter-04
```

本章没有新增 npm 包。主要新增文件：

```text
src/providers/
├── http.ts
├── sse.ts
├── openai-responses.ts
└── deepseek-chat.ts

tests/
├── fixtures/providers/*.sse
├── unit/provider-adapters.test.ts
└── integration/provider-smoke.test.ts
```

本章 tag：

```bash
git tag -a chapter-04 -m "Chapter 04: add GPT and DeepSeek providers"
```

## 12. 完成检查

离线验收：

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

可选联网验收使用上一节的 `npm run test:smoke`。没有 key 时不应把 smoke test 当作失败。

## 13. 动手实验

把任一工具 fixture 的参数第二个 delta 删除，运行测试。JSON parse 应明确失败，并且工具 handler 不会执行。

再删除 DeepSeek fixture 的 `data: [DONE]`。即使已经出现 `finish_reason`，适配器仍应报告截断，因为官方 SSE 终止标记没有到达。

最后把 DeepSeek fixture 中的 `reasoning_content` 改成一个容易识别的字符串，确认它只出现在下一次发给 DeepSeek 的私有 request body 中，不出现在 ProviderStreamEvent 或 Transcript。

## 14. 下一章留下的问题

真实模型现在可以请求工具，但本章的 `InMemoryToolExecutor.validate()` 仍然只是临时接口。下一章会实现正式 Tool Registry、运行时 JSON Schema 验证、统一结果信封、输出大小限制和重复调用检测。
