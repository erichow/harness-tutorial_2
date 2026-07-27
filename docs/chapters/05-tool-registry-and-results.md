# 第 5 章：Tool Registry、Schema 和结果信封

上一章已经让 GPT 和 DeepSeek 能够生成结构化工具调用，但 `InMemoryToolExecutor.validate()` 依赖每个工具手写校验，返回值也只有松散的 `content` 和 `data`。本章把这条临时路径升级为正式的 Tool Registry。

对应代码快照：`chapter-05`。

## 1. 本章问题

工具调用来自模型，因此即使它已经是合法 JSON，也不能直接交给文件系统或 Shell handler。至少还要回答四个问题：

1. 工具名是否存在？
2. 参数是否严格符合该工具声明的 JSON Schema？
3. handler 的成功、失败、超长输出和后续分页怎样使用同一种格式？
4. 模型不断发送相同调用时，怎样避免重复执行副作用？

本章实现的实际执行路径是：

```text
查找工具
→ AJV 校验参数
→ 计算规范化调用签名并检查重复次数
→ 执行 handler
→ 验证 handler 返回值
→ 按 UTF-8 字节限制 content
→ 生成统一 ToolResult
→ Agent Loop 发出 tool_call_finished
→ 把有界结果信封发回模型
```

权限决策、审计存储和 OS 沙箱还没有加入。`sideEffects` 只是下一阶段的机器可读输入，不是安全边界。

## 2. Tool 的正式接口

工具分成模型可见的定义、Harness 可见的副作用和真正执行的 handler：

```ts
interface Tool {
  definition: {
    name: string;
    description: string;
    inputSchema: JsonObject;
  };
  sideEffects: readonly ToolSideEffect[];
  handler(input: JsonObject, context: ToolHandlerContext): Promise<ToolHandlerOutput>;
}
```

当前支持四种副作用标签：

```ts
type ToolSideEffect =
  | "read_workspace"
  | "write_workspace"
  | "execute_process"
  | "network";
```

纯计算工具使用空数组。一个 Shell 工具以后可能同时声明 `execute_process`、`write_workspace` 和 `network`。第 8 章的 PermissionPolicy 会读取这些标签，但最终约束进程能力的仍应是 SandboxRunner。

查看 [`tool.ts`](../../dugsyn/src/tools/tool.ts)。

## 3. 用 AJV 编译 JSON Schema

`ToolRegistry` 在构造时使用 AJV 2020 编译每个 schema。无效 schema、空名称、空描述和重复名称会立即让启动失败，而不是等模型调用后才暴露配置错误。

```ts
const registry = new ToolRegistry([
  {
    definition: {
      name: "echo",
      description: "Echo a string",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    sideEffects: [],
    async handler(input) {
      return { content: String(input.text) };
    },
  },
]);
```

`required` 负责缺少字段，属性 schema 负责类型，`additionalProperties: false` 负责拒绝额外字段。这些语义必须由工具 schema 明确表达；Registry 不会暗中把所有 object 改成封闭对象。

AJV 的错误会被压缩成稳定的 `invalid_arguments` 结果。handler 不会看到未通过校验的输入，也不会靠 TypeScript 类型假装运行时数据可信。

查看 [`registry.ts`](../../dugsyn/src/tools/registry.ts)。

## 4. 每个 turn 使用独立 Executor

Registry 保存不可变的工具目录和已经编译的校验函数；重复调用计数属于一个用户 turn：

```ts
const tools = registry.createExecutor();

await runTurn({
  provider,
  transcript,
  tools,
});
```

下一次用户输入应再次调用 `createExecutor()`。这样相同的 `read_file` 在后续 turn 可以合法重试，同时同一 turn 中失控的调用循环能够被限制。

调用签名由工具名和递归排序键名后的 JSON 输入组成，不包含 Provider 生成的 call ID。因此下面两个输入被视为同一个调用：

```json
{"left":"a","right":"b"}
{"right":"b","left":"a"}
```

默认允许同一签名执行三次；第四次返回 `repeated_call`，handler 不再执行。可以通过 `maxIdenticalCalls` 收紧，但不能设为零或负数。

重复检测不是幂等性保证。对于写文件、执行命令或网络请求，后续权限、checkpoint 和沙箱章节仍要建立真实边界。


## 工具调用前置约束

工具描述是软约束——模型可以选择忽略。当某个工作流对正确性至关重要时，需要硬约束兜底。

### 问题：`read_file` 盲目调用

真实使用中模型经常跳过 `stat_file` 直接调 `read_file`，遇到不存在的文件路径后返回 `✗ (failed)`，不仅浪费 step 配额，还容易引发错误的后续重试。

### 方案：`enforceStatBeforeRead`

在 `createExecutor` 中维护一个追踪集合，记录 `stat_file` 成功检查过的路径（`list_files` 返回的文件路径同样会被标记）。`read_file` 调用时先查集合——路径不在集合中就拦截，返回明确的错误提示：

```typescript
createExecutor(): ToolExecutor {
  const callCounts = new Map<string, number>();
  const statChecked = this.#enforceStatBeforeRead ? new Set<string>() : undefined;
  return {
    definitions: this.definitions,
    execute: async (call, context) =>
      await this.#execute(call, context, callCounts, statChecked),
  };
}
```

在 `#execute` 中，权限检查之前插入 guard：

```typescript
// 硬约束：read_file 需要先调用 stat_file
if (call.name === "read_file" && statChecked !== undefined) {
  const readPath = typeof call.input.path === "string"
    ? call.input.path.trim()
    : "";
  if (readPath.length > 0 && !statChecked.has(readPath)) {
    return createToolErrorResult(
      call.id,
      "permission_denied",
      `read_file blocked: call stat_file "${readPath}" first to confirm the file exists.`,
      { maxOutputBytes: this.#maxOutputBytes },
    );
  }
}
```

`stat_file` 和 `list_files` 成功后记录路径：

```typescript
if (call.name === "stat_file" && statChecked !== undefined) {
  const statPath = typeof call.input.path === "string"
    ? call.input.path.trim()
    : "";
  if (statPath.length > 0) statChecked.add(statPath);
}
```

`list_files` 成功后同样记录返回的所有常规文件路径（跳过目录和 symlink）：

```typescript
} else if (call.name === "list_files" && typeof output.content === "string") {
  for (const line of output.content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("workspace:")
      || trimmed.startsWith("entries:")) continue;
    if (trimmed.endsWith("/") || trimmed.endsWith(" [symlink]")) continue;
    statChecked.add(trimmed);
  }
}
```

### 配置

`enforceStatBeforeRead` 通过 `ToolRegistryOptions` 控制，默认关闭。仅在交互式 CLI 中通过 `CodingAgentRuntimeOptions` 开启：

```typescript
runtime = await CodingAgentRuntime.create({
  // ...
  enforceStatBeforeRead: true,
  // ...
});
```

测试和 headless 模式不下发此选项，不受影响。


## 5. 统一 ToolResult 信封

Registry 生成的成功结果包含：

```json
{
  "type": "tool_result",
  "toolCallId": "call-1",
  "status": "success",
  "content": "first page",
  "data": { "path": "src/index.ts" },
  "output": {
    "contentBytes": 10,
    "totalContentBytes": 10,
    "truncated": false,
    "nextCursor": "opaque-page-2"
  }
}
```

错误结果使用同一外壳，并增加稳定错误信息：

```json
{
  "status": "error",
  "content": "Invalid arguments for read_file: /path must be string",
  "error": {
    "code": "invalid_arguments",
    "message": "Invalid arguments for read_file: /path must be string",
    "retryable": false
  },
  "output": {
    "contentBytes": 57,
    "totalContentBytes": 57,
    "truncated": false
  }
}
```

本章定义四个 Harness 错误码：

| code | 含义 | handler 是否执行 |
| --- | --- | --- |
| `unknown_tool` | 工具未注册 | 否 |
| `invalid_arguments` | 输入不符合 schema | 否 |
| `execution_failed` | handler 抛错或返回非法结果 | 已尝试 |
| `repeated_call` | 同一 turn 超过重复阈值 | 否 |

`data` 用于本地 renderer、事件和未来审计，不发送给模型。Provider 收到的是有界的 `status`、`content`、`error` 和 `output`，避免把任意大的结构化数据重新塞进上下文。

为了兼容第 2–4 章已经产生的 transcript，`error` 和 `output` 在 schema 中保持可选；从第 5 章 Registry 产生的新结果始终包含 `output`，失败时始终包含 `error`。

查看 [`result.ts`](../../dugsyn/src/tools/result.ts) 和 [`blocks.ts`](../../dugsyn/src/messages/blocks.ts)。

## 6. 字节限制与分页 cursor

默认 `maxOutputBytes` 是 64 KiB。限制针对 UTF-8 字节而不是 JavaScript 字符数，并确保不会在多字节字符中间截断：

```text
原始内容：🙂🙂（8 bytes）
上限：5 bytes
返回内容：🙂（4 bytes）
truncated：true
```

Registry 的截断是最后一道上下文保护。真正支持大结果的工具还应主动分页：

1. handler 从 `context.maxOutputBytes` 得知页大小上限。
2. 当前页在 `content` 中返回。
3. 如果还有下一页，返回工具自己定义的 opaque `nextCursor`。
4. 该工具的 `inputSchema` 应声明可选 `cursor` 字段，并在下一次调用中解释它。

Registry 不解析 cursor，也不会为了取下一页而偷偷重放 handler，因为重放有副作用的工具是不安全的。cursor 最多 512 bytes；空字符串或超限 cursor 会变成 `execution_failed`。

如果 handler 仍返回超大页面，Registry 会截断并保留它给出的 cursor。没有 cursor 时，模型只能知道结果被截断，不能恢复丢失部分；这是工具实现缺少分页能力，而不是 Registry 应该通过重执行猜测的事情。

## 7. Provider 为什么接收 JSON 信封

第 4 章只把 `result.content` 作为 function output 发回模型。现在两个 Provider 都调用同一个序列化函数：

```ts
serializeToolResultForProvider(result);
```

OpenAI Responses 把字符串放入 `function_call_output.output`，DeepSeek Chat Completions 把它放入 tool message 的 `content`。两者看到相同 JSON 语义：

```json
{
  "status": "success",
  "content": "tool-ok",
  "output": {
    "contentBytes": 7,
    "totalContentBytes": 7,
    "truncated": false
  }
}
```

这让模型能区分“工具成功但内容为空”“工具失败”和“输出被截断”，无需从自然语言前缀猜测状态。

## 8. Handler 返回值也要验证

输入验证不能替代输出验证。Registry 在 handler 返回后检查：

- 顶层必须是 object。
- `content` 必须是 string。
- `data` 必须是有限数字、字符串、布尔值、null、数组或普通 JSON object。
- `nextCursor` 必须是非空且不超过 512 bytes 的字符串。

`Date`、函数、`undefined`、`NaN` 和带自定义 prototype 的实例都不是允许的 `JsonValue`。非法返回值统一转换为 `execution_failed`，不会击穿 Agent Loop。

如果 turn 已经取消，Registry 不会把取消伪装成普通工具错误，而是继续抛出，让 Agent Runtime 走 `cancelled` 分支。

## 9. 测试策略

[`tool-registry.test.ts`](../../dugsyn/tests/unit/tool-registry.test.ts) 覆盖：

- 未知工具。
- 缺少字段、类型错误和额外字段。
- handler 异常及非法 JSON data。
- UTF-8 多字节截断和 cursor。
- 对象键顺序无关的重复调用签名。
- 新 executor 重置 turn-local 计数。
- 重复工具名和非法限制配置。

[`agent-loop.test.ts`](../../dugsyn/tests/unit/agent-loop.test.ts) 还验证 `repeated_call` 确实进入下一次 Provider 请求，并且 handler 没有再次执行。

Provider fixture 测试现在断言 OpenAI 和 DeepSeek 都收到相同的 JSON 结果信封。DeepSeek 的真实 smoke test 也重新完成了文本流和工具调用闭环；真实测试仍不进入普通 CI。

## 10. 从第 4 章迁移

查看完整差异：

```bash
git diff chapter-04..chapter-05
```

主要变化：

```text
src/tools/
├── executor.ts   # 保留旧 InMemoryToolExecutor，改用统一结果工厂
├── registry.ts   # 正式 Registry、AJV 和重复调用检测
├── result.ts     # 结果信封、字节限制和 Provider 序列化
└── tool.ts       # Tool、side effects、handler 类型

tests/unit/
└── tool-registry.test.ts
```

`InMemoryToolExecutor` 暂时保留，方便前几章的最小测试和对照学习；从需要真实工具的后续章节开始，应构造 `ToolRegistry` 并为每个 turn 创建 executor。

本章新增运行时依赖 `ajv`，使用 draft 2020-12 校验器。

## 11. 完成检查

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

真实 DeepSeek 回归：

```bash
npm run test:smoke:local -- -t DeepSeek
```

本章 tag：

```bash
git tag -a chapter-05 -m "Chapter 05: add the tool registry and result envelopes"
```

## 12. 动手实验

把示例 schema 的 `additionalProperties: false` 删除，再传入额外字段。观察 AJV 会按 JSON Schema 标准接受它，说明“严格”必须体现在 schema 中。

然后把 `maxOutputBytes` 改成 5，让 handler 返回两个 emoji，确认返回值只保留一个完整 emoji，而不是产生替换字符。

最后把 `maxIdenticalCalls` 改成 1，让 Mock Provider 连续两次以不同 call ID、不同键顺序调用相同工具。第二次应得到 `repeated_call`，handler 总执行次数仍为 1。

## 13. 下一章留下的问题

Registry 现在能安全地拒绝错误形状和控制返回大小，但还没有任何真正的项目工具。下一章会实现 `list_files`、`search_text`、`read_file` 和基于 patch 的编辑，并建立 workspace root、realpath、符号链接与敏感路径边界。
