# 第 9 章：CLI 交互、事件渲染和取消

第 8 章已经提供异步权限回调，但如果权限回调、REPL 和工具各自创建一个 `readline`，终端很快会出现多个消费者争抢 stdin、流式输出覆盖确认问题、Ctrl-C 直接杀死整个进程等故障。本章把终端收束为一条路径：

```text
stdin → NodeInputController → CliSession
                              ↘ PermissionHandler

RuntimeEvent → TerminalRenderer → stdout
Permission  ↗        ↑
Slash command ───────┘
```

对应代码快照：`chapter-09`。

## 1. 为什么终端也需要协议边界

Agent 内核已经产生 `RuntimeEvent`。CLI 不应再次猜测模型正在做什么，而应只根据事实渲染：

- `text_delta`：流式回复正文。
- `reasoning_summary_delta`：Provider 明确提供的行动摘要，不是隐藏思维链。
- `tool_call_started`：工具确实被模型请求。
- `tool_call_finished`：工具确实返回成功或错误。
- `permission_requested`：运行时请求了确认。
- `error` / `turn_finished`：真实错误和结束原因。

因此本章没有“正在分析 37%”一类由模型编造的进度，也不会把工具在 prompt 中声称的成功当成成功。

## 2. 全程只有一个 InputController

[`input.ts`](../../agent-code/src/cli/input.ts) 定义唯一输入边界：

```ts
interface InputController {
  readLine(prompt: string, options?: { signal?: AbortSignal }): Promise<string | null>;
  onInterrupt(handler: () => void): () => void;
  close(): void;
}
```

`NodeInputController` 在构造时创建一次 `readline.Interface`。REPL 和权限确认都复用它；工具实现完全看不到 stdin。

这里还有三个容易遗漏的细节：

1. 同时发起第二个 `readLine()` 会直接报错，避免两个消费者悄悄争抢输入。
2. 非 TTY 管道可能在下一次 `readLine()` 之前就发送多行，所以 controller 会缓存已经到达的行。
3. 权限读取接受 `AbortSignal`。当前 turn 被取消时，确认 Promise 也会结束，不会留下悬挂输入。

## 3. Renderer 是终端状态机

[`renderer.ts`](../../agent-code/src/cli/renderer.ts) 维护三类状态：

```text
当前是否正在输出 text / summary
toolCallId 对应的真实工具名
是否正在显示 permission prompt
```

文本流切换到工具事件时，Renderer 先结束当前行，再显示工具状态：

```text
Checking the source
→ read_file "src/config.ts"
✓ read_file
Applying the change
→ apply_patch "src/config.ts"
✓ apply_patch (update src/config.ts)
```

`(update src/config.ts)` 来自 `apply_patch` 的真实 `ToolResult.data`，不是模型提交的一对 original/modified 字符串。完整 unified diff、并发冲突和本回合变更归属会在第 11 章实现；本章只显示已经落盘的操作摘要。

工具结果的 `content` 是给模型消费的，可能很长，也可能包含不可信命令输出。默认终端状态只显示工具名、成功/失败和少量结构化结果，不直接倾倒原始内容。

## 4. 不显示原始思维链

CLI 对 `reasoning_summary_delta` 使用 `·` 前缀显示简短行动摘要，但没有任何“打印模型内部思考”的后门。

两者要区分：

```text
reasoning_summary  Provider 明确返回、可以向用户展示的摘要
hidden reasoning   Provider/模型内部状态，不进入 RuntimeEvent
```

如果某个 Provider 不提供 summary，CLI 就只显示正文和真实工具事件，不伪造一份。

## 5. 权限提示期间暂停事件渲染

[`permission-prompt.ts`](../../agent-code/src/cli/permission-prompt.ts) 把第 8 章的 `InteractivePermissionHandler` 接到相同的 InputController 和 Renderer：

```text
? Permission requested by run_shell
  Resources: effect:execute_process, effect:network, network:*, workspace:.
  Reason: confirmation required
  Request: "npm test"
Allow? [y] once / [a] session / [n] deny:
```

答案语义固定：

- `y` / `yes`：只允许本次。
- `a` / `session`：只为完整规范化请求保存 session grant。
- `n` / `no` / EOF：拒绝。

权限 prompt 激活期间，新到达的 RuntimeEvent 会进入 Renderer 自己的队列。回答完成后先显示权限结果，再按顺序冲刷事件。这样确认问题不会被一段异步输出切成两半。

用户输入的命令可能含 token，因此权限审计仍只持久化 fingerprint 和资源；确认界面为了让用户作出知情决定，会显示当前请求的有界摘要。

## 6. Ctrl-C 是状态相关的

[`session.ts`](../../agent-code/src/cli/session.ts) 保存当前 turn 的 `AbortController`：

```text
running / permission prompt + Ctrl-C
→ abort 当前 turn
→ Provider stream、权限读取和前台 shell 共用 signal 取消
→ REPL 继续存在

idle + Ctrl-C
→ 关闭 session
→ 关闭唯一 InputController
→ 清理 ProcessManager 中仍存活的任务
```

第一次 Ctrl-C 不是 `process.exit()`。否则 shell 子进程清理、`turn_finished: cancelled` 和 renderer 收尾都没有机会运行。

本章测试会先启动一个等待 signal 的 turn，确认第一次 Ctrl-C 只取消它；等 turn 结束后再次触发，才确认 session 退出。

## 7. 五个斜杠命令

斜杠命令由 Session 本地处理，不发送给模型：

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示可用命令 |
| `/status` | 显示 Provider、模型、workspace trust、sandbox 和消息数 |
| `/permissions` | 显示本会话 allow/deny 审计计数，不打印秘密参数 |
| `/clear` | 清空对话，同时清除精确 session grants |
| `/exit` | 正常关闭会话 |

`/clear` 必须同时删除临时权限。否则用户以为开始了新会话，旧的 `allow_session` 却仍在生效。

## 8. ANSI、宽度和非 TTY

模型文本、错误消息、工具参数都属于不可信终端输入。`sanitizeTerminalText()` 会删除：

- CSI 控制序列，例如清屏和移动光标。
- OSC 控制序列，例如修改窗口标题和超链接。
- ESC、BEL、CR 及其他不应控制终端的 C0/C1 字符。

普通换行和 tab 保留。状态行根据 `output.columns` 截断；默认宽度为 100，最低按 20 处理。

当 `stdout.isTTY !== true` 时，Renderer 不生成颜色码。这样日志文件、CI 和管道输出保持纯文本。端到端测试会把三条斜杠命令通过 stdin 管道送入构建后的 CLI，并断言输出不含 ANSI、BEL 或 CR。

## 9. 接到 OpenAI 和 DeepSeek

本章新增真实入口：

```bash
cd agent-code
npm run build

OPENAI_API_KEY=... node dist/cli/bin.js chat \
  --provider openai \
  --model gpt-5 \
  --workspace .
```

或：

```bash
DEEPSEEK_API_KEY=... node dist/cli/bin.js chat \
  --provider deepseek \
  --model deepseek-chat \
  --workspace .
```

也可以省略 `--model`，分别使用 `OPENAI_MODEL` 或 `DEEPSEEK_MODEL`。

CLI 故意不自动读取 `.env.local`。这避免库代码擅自读取凭据文件，也保持“哪些环境变量会进入进程”清晰可见。若本地密钥保存在 `.env.local`，可由 shell 或受信任的启动脚本先加载；不要提交该文件。

[`chat.ts`](../../agent-code/src/cli/chat.ts) 负责组合：

```text
Provider
+ Workspace file tools
+ fail-closed platform sandbox shell tools
+ PermissionEngine
+ CliSession
```

当前命令不会自动信任 workspace，所以项目自带 config、Hooks、MCP 和 permission rules 仍禁用。后续配置章节会加入持久化 trust 管理；这里不能用“用户运行了 chat”来偷换成“项目配置可信”。

## 10. 为什么默认 shell 仍可能被阻止

`agent-code chat` 使用第 8 章的 `createPlatformSandboxRunner()`，配置是：

```ts
{
  allowNetwork: false,
  fallback: "closed",
}
```

支持且允许嵌套 Seatbelt 的 macOS 会运行 workspace-only、无网络 shell。其他平台或不允许嵌套沙箱的环境会 fail closed。`/status` 展示实际 sandbox 状态，不会把普通 host child process 标成已隔离。

## 11. 测试策略

[`cli-renderer.test.ts`](../../agent-code/tests/unit/cli-renderer.test.ts) 覆盖：

- 文本流、工具开始、真实工具结果和后续文本交错。
- 不把原始工具 output 默认打印到终端。
- 模型文本与 shell 参数中的 ANSI/OSC 无法控制终端。
- 权限提示期间事件排队，回答后顺序恢复。
- 非法确认答案会重试，且一直复用同一个 InputController。

[`cli-session.test.ts`](../../agent-code/tests/unit/cli-session.test.ts) 覆盖：

- 五个本地命令不调用模型。
- 第一次 Ctrl-C 取消 active turn，空闲 Ctrl-C 退出。
- `/clear` 同时清理 transcript 和 session grant。

[`cli.test.ts`](../../agent-code/tests/e2e/cli.test.ts) 使用构建后的 CLI 和管道 stdin 验证非 TTY 交互。它提供一个不会被使用的测试 key，只执行本地命令后退出，因此不访问 OpenAI/DeepSeek API。

## 12. 从第 8 章迁移

查看完整差异：

```bash
git diff chapter-08..chapter-09
```

新增结构：

```text
src/cli/
├── chat.ts                 # Provider、工具、安全层和 Session 的组合入口
├── input.ts                # 唯一 readline owner
├── permission-prompt.ts    # 权限确认适配器
├── renderer.ts             # RuntimeEvent 终端状态机
└── session.ts              # REPL、命令与 Ctrl-C 语义

tests/unit/
├── cli-renderer.test.ts
└── cli-session.test.ts
```

`bin.ts` 现在使用 top-level await 启动 `chat`，错误仍通过统一边界写入 stderr 并设置非零退出码。

## 13. 完成检查

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

普通测试不访问模型 API，也不会读取 `.env.local`。

本章 tag：

```bash
git tag -a chapter-09 -m "Chapter 09: add interactive CLI rendering and cancellation"
```

## 14. 动手实验

先把下面文本作为 mock `text_delta` 送给 Renderer：

```text
safe\x1b[2Jstill-safe
```

确认终端没有清屏，非 TTY 输出也不含 ESC。

然后让一个 turn 等待 `AbortSignal`，在运行时按一次 Ctrl-C，确认回到 prompt；空闲时再按一次，确认进程退出。

最后触发 `run_shell` 权限请求，在确认界面选择 `a`。用完全相同的参数再次调用应复用授权；修改命令任意一个字符则必须重新询问。

## 15. 下一章留下的问题

CLI 的交互骨架已经能连接真实 Provider，但还缺少一个确定性的完整产品验收：在临时项目中让 Mock Provider 搜索、读取、带 hash 修改文件、请求 shell 权限、运行测试并根据真实退出码总结。下一章会把这些章节能力串成 MVP 端到端场景，并验证失败时不会留下半写文件或失控子进程。
