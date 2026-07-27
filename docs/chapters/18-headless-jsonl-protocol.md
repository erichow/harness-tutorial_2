# 第 18 章：Headless 和 JSONL 协议

交互式终端适合人直接使用，但 CI、编辑器、脚本和上层编排器需要另一种接口：
输入必须可管道化，输出必须能稳定解析，权限请求不能等待一个永远不会出现的人。

本章在同一个 `dugsyn` Runtime 上增加 Headless 模式。它不是第二套 Agent
实现；交互模式和 Headless 模式共享 Provider、工具、权限、上下文、预算、
Checkpoint 和 Session。

## 1. 本章目标

完成后，CLI 支持：

```text
--print [prompt]
--input-format text|jsonl
--output-format text|json|jsonl
```

并建立以下契约：

- stdin 可以提供单个文本请求或多个 JSONL 请求。
- stdout 只包含所选输出格式，不混入提示语、进度或报错。
- stderr 只承载面向操作人员的诊断。
- JSONL 事件通过 `requestId` 和输入关联。
- 多个 JSONL 请求在同一个 Session 中顺序执行。
- 需要交互确认的权限在 Headless 中安全拒绝。
- 成功、错误、预算耗尽、权限拒绝和取消具有稳定退出码。

## 2. 为什么不能复用交互渲染器

第 9 章的 `TerminalRenderer` 会输出提示、状态和适合人阅读的事件。机器接口如果
复用这些文本，上层程序就必须猜测哪些行是结果、哪些行是装饰。

本章采用明确分层：

```text
stdin
  │
  ├─ text ───────────────► 一个请求
  │
  └─ JSONL request ──────► 多个顺序请求
                              │
                              ▼
                    同一个 CodingAgentRuntime
                              │
                              ├─ RuntimeEvent
                              └─ RunTurnResult
                                      │
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
                text                 json                jsonl
             最终回答          一个批次文档        事件流 + 结果行
```

Headless 层只负责协议和进程语义，不重新解释工具结果或 Provider 事件。

## 3. 命令行入口

直接传入单个 prompt：

```bash
OPENAI_API_KEY=... dugsyn \
  --print "检查当前项目并给出最重要的三个问题" \
  --provider openai \
  --model gpt-5.6-sol
```

也可以保留显式的 `chat` 子命令：

```bash
DEEPSEEK_API_KEY=... dugsyn chat \
  --print "解释 package.json" \
  --provider deepseek \
  --model deepseek-v4-pro
```

省略 `--print` 后面的 prompt 时，从 stdin 读取：

```bash
printf '%s\n' '总结当前项目结构' |
  OPENAI_API_KEY=... dugsyn \
    --print \
    --provider openai \
    --model gpt-5.6-sol
```

Provider、模型、workspace、Session 目录、resume 和 fork 仍使用前面章节的参数与
配置优先级。

## 4. text 输入

`--input-format text` 是默认值。CLI 读取完整 stdin，只移除一个常见的末尾换行，
不会 `trim()` 整个 prompt，因此代码缩进和开头空格不会丢失。

下面两条命令等价：

```bash
dugsyn --print "describe src" --provider openai --model gpt-5.6-sol
```

```bash
printf 'describe src\n' |
  dugsyn --print --provider openai --model gpt-5.6-sol
```

空 prompt 和空 stdin 是输入错误，退出码为 `2`。

## 5. JSONL 输入协议

JSONL 每行是一个完整 JSON 对象。空行被忽略。当前协议版本是 `1`：

```json
{"protocolVersion":1,"type":"request","requestId":"inspect","prompt":"检查项目结构"}
{"protocolVersion":1,"type":"request","requestId":"tests","prompt":"根据刚才的结果给出测试建议"}
```

调用方式：

```bash
dugsyn \
  --print \
  --input-format jsonl \
  --output-format jsonl \
  --provider openai \
  --model gpt-5.6-sol < requests.jsonl
```

字段契约：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `protocolVersion` | 是 | 当前必须为 `1` |
| `type` | 是 | 当前必须为 `"request"` |
| `requestId` | 否 | 调用方关联 ID；省略时由 CLI 生成 |
| `prompt` | 是 | 非空用户请求 |

对象使用严格 schema。未知字段、版本不匹配、空 prompt 和重复 `requestId` 都会
失败，而不是被静默忽略。

错误会报告准确行号：

```text
Input error: JSONL line 3 is not valid JSON: ...
```

多个请求共享当前 Transcript。第二个请求能看到第一个请求的用户消息、Agent
响应和工具结果。这使 JSONL 既可表达单请求，也可表达一个顺序工作流。

## 6. text 输出

`--output-format text` 是默认值，只把每个请求最后一条 assistant 消息中的文本
写入 stdout：

```text
The project contains a TypeScript CLI and a versioned runtime protocol.
```

以下内容不会进入 stdout：

- Session 创建提示。
- reasoning summary。
- 工具调用进度。
- 权限诊断。
- Provider 错误。
- 退出码说明。

多请求输入按完成顺序输出，每个最终回答以换行结束。需要无歧义边界时，应使用
`json` 或 `jsonl`。

## 7. json 输出

`--output-format json` 在所有输入处理完后输出一个 JSON 批次文档。即使只有一个
请求，顶层仍是 `batch_result`，避免单请求和多请求出现两种顶层形状：

```json
{
  "protocolVersion": 1,
  "type": "batch_result",
  "sessionId": "c5b8...",
  "results": [
    {
      "protocolVersion": 1,
      "type": "result",
      "requestId": "inspect",
      "sessionId": "c5b8...",
      "turnId": "a8dd...",
      "reason": "completed",
      "exitCode": 0,
      "text": "The project contains...",
      "steps": 1,
      "tests": {
        "status": "not_run",
        "runs": 0,
        "repairRounds": 0
      },
      "permissionDenials": []
    }
  ],
  "exitCode": 0
}
```

批次 `exitCode` 是所有结果的聚合值。调用方既可以读取进程退出码，也可以持久化
JSON 后再检查同一个值。

## 8. jsonl 输出

`--output-format jsonl` 在 Runtime 产生事件时立即输出，不等整批完成。

事件行使用 envelope：

```json
{"protocolVersion":1,"type":"event","requestId":"inspect","event":{"protocolVersion":1,"type":"turn_started","sequence":0,"timestamp":"...","turnId":"..."}}
```

请求完成后追加一行 `result`：

```json
{"protocolVersion":1,"type":"result","requestId":"inspect","sessionId":"...","turnId":"...","reason":"completed","exitCode":0,"text":"Done.","steps":1,"tests":{"status":"not_run","runs":0,"repairRounds":0},"permissionDenials":[]}
```

为什么 event 外面还要包一层：

- Runtime 的 `turnId` 标识 Agent turn，不等于调用方请求 ID。
- 一个 JSONL 输入流包含多个请求，需要稳定关联。
- 以后 Headless 协议可以增加批次级记录，而无需修改 RuntimeEvent。

RuntimeEvent 本身继续保留自己的 `protocolVersion`、`sequence`、`timestamp` 和
`turnId`。每个 turn 的 sequence 从 `0` 开始。

## 9. stdout 和 stderr

机器接口最重要的约束之一是：

```text
stdout = 用户选择的协议
stderr = 人类可读诊断
```

例如权限拒绝时：

```text
Request inspect denied by permission policy.
```

这行只写 stderr。若输出格式是 JSON/JSONL，结构化结果仍通过
`permissionDenials` 提供工具名和原因。

JSONL 的 Runtime `error` 事件仍属于协议，所以会出现在 stdout；stderr 同时给
CI 日志提供一条简短说明。调用方不应解析 stderr 来获得结构化状态。

## 10. 退出码

本章固定以下退出码：

| 退出码 | 含义 |
| ---: | --- |
| `0` | 所有请求完成且没有权限拒绝 |
| `1` | Provider 错误或内部错误 |
| `2` | CLI 参数、配置、凭据或输入协议错误 |
| `3` | `max_steps`、`max_duration` 或 `max_tokens` |
| `4` | 至少一个工具权限请求被拒绝 |
| `130` | SIGINT 或 AbortSignal 取消 |

如果批次包含多个不同失败，聚合优先级是：

```text
cancelled > error > budget > permission > success
```

权限拒绝即使被模型观察到并生成了最终回答，进程仍返回 `4`。这样 CI 不会把
“Agent 解释了为什么没做”误判为“操作已经成功”。

## 11. Headless 权限模型

交互模式向 `PermissionEngine` 提供终端确认回调；Headless 模式故意不提供。

因此：

- managed/user/project 的显式 `allow` 仍可授权。
- 任意层级的 `deny` 仍然优先。
- 显式 `ask` 或默认 `ask` 没有交互处理器时安全转为 `deny`。
- Headless 不会等待 stdin 上的 `y/n`，也不会把业务输入误当授权回答。

拒绝事件包含：

```json
{
  "type": "permission_decided",
  "decision": "deny",
  "reason": "No interactive permission handler is available; denied safely."
}
```

这正是 CI 的 fail-closed 行为。若流水线确实需要某个工具，应在受控的 managed
或 user 配置中添加精确 allow 规则，而不是把 Headless 默认策略改成全局 allow。

## 12. Session 和持久化

Headless 与交互模式使用同一个 `SessionStore`：

1. Provider 调用前先持久化 user message。
2. 每个 RuntimeEvent 产生后追加到 `events.jsonl`。
3. turn 完成后持久化新的 Transcript。
4. 多个输入请求依次更新同一个 Session。

可以继续使用：

```bash
dugsyn --print "继续检查" --resume <session-id>
```

或：

```bash
dugsyn --print "尝试另一种方案" --fork-session <session-id>
```

resume 保留原 Session 的 Provider、模型和 workspace；fork 沿用第 15 章的覆盖
规则。

## 13. 取消

Headless 启动路径监听 SIGINT，并把它转换成 AbortSignal。Runtime 继续负责：

- 中断 Provider 流。
- 中断工具执行。
- 发送 `error(category="cancelled")`。
- 发送 `turn_finished(reason="cancelled")`。
- 清理子进程和 Session lock。

最终退出码为 `130`。如果取消发生在 Runtime 启动前，CLI 仍返回 `130` 并把诊断
写入 stderr，但可能还没有可输出的 turn/result 记录。

## 14. 实现结构

本章新增：

```text
dugsyn/src/cli/
├── headless-protocol.ts  # 输入 schema、输出类型、版本和退出码
└── headless.ts           # 参数、stdin、协议渲染和 Runtime 启动
```

`headless-protocol.ts` 不依赖终端；它定义稳定的边界类型。

`headless.ts` 分成两层：

- `runHeadlessCli`：加载配置、Session、Provider、权限和 Runtime。
- `runHeadless`：处理请求流、持久化、事件 envelope、结果与退出码。

测试可以给 `runHeadless` 注入确定性的 Session/turn runner，或给
`runHeadlessCli` 注入 `MockProvider`，因此普通测试不需要 API key 或网络。

第 17 章的若干启动辅助函数从 `chat.ts` 导出，交互和 Headless 由此共享完全相同
的配置优先级、API key 规则和 Session 恢复逻辑。

## 15. 验收测试

本章新增的确定性测试覆盖：

- inline prompt 和 stdin text。
- 多请求 JSONL 输入。
- JSONL 事件顺序与 `requestId` 关联。
- 单个 JSON batch 输出。
- stdout 协议纯净。
- JSONL 行号和严格 schema。
- 重复 request ID。
- Provider/内部错误退出码。
- 预算耗尽退出码。
- 完整 Tool Registry 中的非交互权限拒绝。
- 实际 AbortSignal 取消。
- built CLI 的 stdin/JSONL 路由。

运行：

```bash
cd dugsyn
npm run typecheck
npm test
npm run build
npm run test:e2e
```

普通测试不会读取 `.env.local`，也不会访问 OpenAI 或 DeepSeek。

## 16. 从第 17 章迁移

第 17 章的交互命令保持不变。新增能力是可选的：

```bash
# 原交互模式
dugsyn chat

# 单次非交互模式
dugsyn --print "review this repository"

# 流式机器协议
dugsyn --print --input-format jsonl --output-format jsonl
```

不要把终端输出抓取脚本继续扩展成正则解析器。自动化调用从本章开始应使用
`json` 或 `jsonl`，并同时检查进程退出码。
