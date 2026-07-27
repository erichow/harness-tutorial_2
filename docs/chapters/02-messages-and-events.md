# 第 2 章：类型化消息和事件协议

上一章只有 CLI 外壳。本章先不接模型，而是定义所有模型适配器、工具、UI 和日志都必须遵守的内部语言。

对应代码快照：`chapter-02`。

## 1. 本章问题

如果运行时直接保存 OpenAI 或 DeepSeek SDK 返回对象，会产生三个问题：切换 Provider 时整条调用链都要修改；流式事件无法被不同 UI 重放；旧会话可能在 SDK 升级后无法读取。

所以系统需要两种稳定协议：

- `Transcript` 保存会话已经发生的事实。
- `RuntimeEvent` 描述一次运行正在发生什么。

前者是状态，后者是事件流。不能用一套“万能消息”混在一起。

## 2. 行为规格

本章结束后：

- 文本、工具调用、工具结果和推理摘要都能 JSON round-trip。
- 每个运行时事件都带协议版本、序号、时间和 turn ID。
- 未知协议版本会得到明确的 `ProtocolDecodeError`。
- 非法 JSON、未知 block、额外字段或错误字段类型不会静默进入运行时。
- 协议类型中不会 import 任何 Provider SDK。

## 3. 威胁和失败模型

本章防止格式漂移、厂商对象泄漏、损坏的持久化数据和无法识别的未来版本进入核心运行时。

它不保证来源可信，也不对文本内容做安全判断。JSON 验证不是权限控制；会话文件的信任边界会在后续章节处理。

## 4. 接口设计

内容块使用可辨识联合类型：

```ts
type ContentBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningSummaryBlock;
```

工具结果同时保存两种表达：

- `content` 是稳定文本，可以交还给模型。
- `data` 是可选 JSON，供 CLI、JSONL 消费者和审计使用。

运行时事件也使用 `type` 判别，并共享：

```ts
interface EventBase {
  protocolVersion: 1;
  sequence: number;
  timestamp: string;
  turnId: string;
}
```

`sequence` 在一个 turn 内单调递增。第 3 章的 Agent Loop 负责生成它；本章只定义不变量。

错误类别被限制为 `user | tool | provider | cancelled | internal`。这比一个布尔 `success` 更有用：CLI 可以决定展示方式，重试器也能只处理允许重试的 Provider 错误。

## 5. 完整实现

本章增加三层文件：

```text
src/
├── protocol/
│   ├── json.ts
│   └── serde.ts
├── messages/
│   ├── blocks.ts
│   ├── transcript.ts
│   └── schemas.ts
└── runtime/
    ├── events.ts
    └── event-schemas.ts
```

TypeScript 接口是编译期契约，Zod schema 是不可信 JSON 进入系统时的运行时契约。`serde.ts` 先读取版本，再用对应 schema 验证。因此版本 2 不会被误报成一串无关字段错误。

查看真实源码：

- [`blocks.ts`](../../dugsyn/src/messages/blocks.ts)
- [`transcript.ts`](../../dugsyn/src/messages/transcript.ts)
- [`events.ts`](../../dugsyn/src/runtime/events.ts)
- [`serde.ts`](../../dugsyn/src/protocol/serde.ts)
- [`protocol-serde.test.ts`](../../dugsyn/tests/unit/protocol-serde.test.ts)

协议只允许 `JsonValue`，不能携带 `Date`、`Error`、函数、流或 SDK class instance。这是以后写 JSONL 和会话存储的前提。

## 6. 从第 1 章迁移

检出前一章并安装新增依赖：

```bash
git switch --detach chapter-01
cd dugsyn
npm install zod
```

然后加入上述协议文件和测试。真实开发应回到分支继续；detach 命令只是让读者检查历史快照。

本章 tag：

```bash
git tag -a chapter-02 -m "Chapter 02: typed messages and events"
```

## 7. 测试

`protocol-serde.test.ts` 构造了全部四种内容块和九种事件，逐个执行：

```text
typed value → JSON string → unknown → runtime validation → typed value
```

测试还主动传入版本 2、版本 99、未知 vendor block 和截断 JSON。任何一种都必须失败，且错误类型稳定。

## 8. 动手实验

在一条 `text_delta` JSON 中加入 `providerResponseId` 字段，再调用 `decodeRuntimeEvent()`。由于 schema 使用 `.strict()`，它会拒绝这个字段。这个实验说明 Provider 元数据不能未经设计就污染公共协议。

然后把 `protocolVersion` 改成 2。观察错误先报告“不支持的版本”，而不是字段校验细节。

## 9. 完成检查

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

普通测试不连接 GPT 或 DeepSeek。

## 10. 下一章留下的问题

协议已经存在，但还没有组件产生这些事件。下一章会实现可脚本化的 Mock Provider 与最小 Agent Loop，用确定性测试覆盖纯文本、工具调用、最大步数和取消，而不消耗真实模型额度。
