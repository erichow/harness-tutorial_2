# 第 23 章：插件、IDE、Web 和团队策略

前二十二章已经得到一个可用的 Coding Agent CLI：它有真实 Provider、文件和 Shell
工具、权限与沙箱、Session、Headless 协议、MCP、Hooks、Skills、Subagent、Eval
和可选 LSP。

最后一章不再往核心仓库塞一个半成品 VS Code 扩展和一个半成品 Web 服务。我们的目标
是把稳定边界写成代码，让后续宿主可以复用同一个 Agent runtime：

```text
Agent runtime
├── CLI Renderer adapter
├── IDE transport adapter
├── WebSocket event protocol
├── Plugin manifest + managed policy
└── redacted remote audit exporter
```

本章仍不访问真实模型、WebSocket 服务或审计服务器。所有契约都由内存 transport 和
假的 `fetch` 验证。

## 1. 先写行为规格

完成本章后，用户能观察到以下行为：

1. CLI renderer 通过宿主无关接口消费 `RuntimeEvent`；
2. IDE 和 WebSocket 使用同一个版本化消息协议；
3. 客户端必须先握手，版本不兼容会得到协议错误；
4. 一个宿主 session 同时只运行一个 turn；
5. `cancel_turn` 能在模型仍运行时中止 turn；
6. 工具输入、工具输出和错误正文不会跨 IDE/Web 边界；
7. 插件代码执行前，manifest 已经过 schema 与团队策略检查；
8. `teamPolicy` 只能来自 managed 配置；
9. 远程审计只发送低基数元数据，不发送 prompt、文本增量或工具正文；
10. 审计失败采用 managed 配置指定的 fail-open 或 fail-closed 语义。

这些接口不是安全沙箱。第三方 JavaScript 一旦在主进程加载，就拥有 Node.js 进程权限。
所以本章只验证和发现 manifest，不实现任意目录的动态 `import()`。

## 2. Renderer 是接口，不是终端本身

第 9 章的 `TerminalRenderer` 已经正确处理流式文本、工具状态、ANSI 清理和权限提示。
现在把它显式放在一个最小接口后面：

```ts
export interface RuntimeRenderer {
  render(event: RuntimeEvent): void;
  notice(message: string): void;
  finish(): void;
}

export class TerminalRenderer implements RuntimeRenderer {
  // 原有终端状态机
}
```

接口故意不包含光标位置、终端颜色或 readline。IDE 不应该假装成终端；它应使用事件
transport，把事件映射为自己的 progress、diff 和 diagnostics UI。

## 3. 一个协议服务 IDE 和 WebSocket

`src/hosts/protocol.ts` 定义 `HOST_PROTOCOL_VERSION = 1`。客户端命令只有三种：

```json
{"protocolVersion":1,"type":"hello","client":"example-ide"}
{"protocolVersion":1,"type":"start_turn","requestId":"r1","prompt":"检查项目"}
{"protocolVersion":1,"type":"cancel_turn","requestId":"r1"}
```

服务端事件有四类：

```text
ready
runtime_event
turn_result
protocol_error
```

每一条消息都带 `protocolVersion`。这里不使用“没有版本时猜成 v1”的兼容逻辑，因为
错误猜测会让客户端把字段解释成错误含义。升级协议时应增加新版本和迁移测试。

`HostTransport` 只抽象消息来源和去向：

```ts
export interface HostTransport {
  readonly kind: "ide" | "websocket";
  readonly messages: AsyncIterable<unknown>;
  send(event: HostEvent): void | Promise<void>;
  close(): void | Promise<void>;
}
```

IDE 可以把它接到编辑器 RPC channel，Web 服务可以把它接到已经完成认证和 origin
检查的 WebSocket。核心包不负责打开公网端口。

`createIdeTransportAdapter()` 和 `createWebSocketTransportAdapter()` 只是给 transport
标记明确宿主类型；真正的状态机只有一个 `HostSessionAdapter`。这样不会出现 CLI、
IDE 和 Web 三套取消语义逐渐分叉的问题。

## 4. 取消不能被串行读取阻塞

一个常见错误是这样写：

```ts
for await (const command of transport.messages) {
  await runTurn(command);
}
```

当 `runTurn()` 未结束时，循环无法读取下一条 `cancel_turn`，所以取消永远到不了
`AbortController`。

本章启动 active promise 后继续读取 transport：

```ts
const controller = new AbortController();
const promise = runner.runTurn({
  prompt,
  signal: controller.signal,
  emit,
});

active = { requestId, controller, promise };
```

收到匹配的取消命令时立即：

```ts
active.controller.abort(new Error("Cancelled by host"));
```

同时规定一个 host session 只能有一个 active turn。并行任务应创建独立 Session 或
使用第 21 章的 Subagent/worktree，而不是把两个 turn 写入同一 Transcript。

transport 关闭也会 abort active turn。`close()` 是幂等的，底层连接只关闭一次。

## 5. 跨边界事件必须脱敏

内部 `RuntimeEvent` 的工具事件包含完整 input 和 result。它们可能有：

- Shell command；
- 文件路径和文件正文；
- MCP 返回内容；
- 测试日志；
- Provider 错误消息。

这些字段适合受控的本地 Session，却不应自动发给浏览器或远程 IDE。函数
`toPublicRuntimeEvent()` 建立独立的 public projection：

| 内部事件 | 跨宿主保留 | 删除 |
| --- | --- | --- |
| `tool_call_started` | call id、tool name | 完整 input |
| `tool_call_finished` | call id、status、error code | content、data、error message |
| `error` | category、retryable | message |
| `usage` | token 计数 | 无正文 |
| `text_delta` | 文本增量 | 无额外字段 |

文本增量本身当然包含模型回答。IDE/Web 产品应再根据组织数据策略决定是否允许此类内容
离开本机。本章保证的是：选择显示回答不会顺带泄露工具内部数据。

权限 reason 被保留，因为客户端需要向用户解释确认原因；现有权限事件本来就不携带
工具 input。

## 6. WebSocket 协议不等于 WebSocket 服务器

本章定义 WebSocket 上承载的应用协议，但不监听端口。一个产品级服务器还必须负责：

- TLS 终止；
- 用户认证与 session 授权；
- `Origin` 校验；
- 每连接消息和带宽上限；
- prompt 大小上限；
- 反向代理超时；
- 心跳和断线恢复；
- 多租户 Session 隔离；
- CSRF、SSRF 和日志脱敏；
- 进程与工作区的租户级沙箱。

把这些问题藏在一个教程用的 `new WebSocketServer({ port: 8080 })` 后面，会造成危险的
“已经支持 Web”错觉。因此真正的服务只需实现 `HostTransport`，核心契约和测试可以
保持不变。

## 7. Plugin manifest 先于代码执行

插件 manifest 示例：

```json
{
  "apiVersion": 1,
  "id": "com.example.ide",
  "name": "Example IDE",
  "version": "1.0.0",
  "entrypoint": "dist/index.js",
  "capabilities": ["ide_transport"]
}
```

当前 capability 集合为：

```text
renderer
ide_transport
websocket_transport
tool
provider
event_exporter
```

schema 要求：

- API 版本精确匹配；
- id 是小写、带命名空间的稳定标识；
- version 是明确的语义版本；
- entrypoint 是插件目录内的可移植相对路径；
- 至少声明一个 capability；
- 未知字段被拒绝。

`PluginCatalog.add()` 只验证 metadata 并保存冻结副本，不 import entrypoint。宿主可以
先展示权限、验证签名、检查来源，再决定是否在隔离进程中加载。

## 8. Managed policy 不能被项目削弱

managed 配置可增加：

```json
{
  "teamPolicy": {
    "plugins": {
      "allowedIds": ["com.example.ide"],
      "deniedCapabilities": ["provider"]
    },
    "hosts": {
      "allowedKinds": ["cli", "ide"]
    },
    "audit": {
      "endpoint": "https://audit.example.com/agent-events",
      "headersFrom": {
        "authorization": "AGENT_CODE_AUDIT_AUTH"
      },
      "timeoutMs": 5000,
      "failureMode": "open"
    }
  }
}
```

`teamPolicy` 与普通偏好不同：

```text
managed: 允许设置
user:    拒绝整个配置文件
project: 拒绝整个配置文件
local:   拒绝整个配置文件
env/CLI: 没有覆盖入口
```

因此项目无法把 `allowedKinds` 改成 WebSocket，无法允许被组织禁止的 Provider 插件，
也无法把审计从 closed 改成 open。

`assertHostAllowed()` 在 CLI 和 Headless bootstrap 中执行。未来 IDE/Web 宿主也应在
创建 `HostSessionAdapter` 前调用它。`createManagedPluginCatalog()` 把相同策略转换为
manifest gate。

## 9. 远程审计只发送元数据

完整 RuntimeEvent 不适合远程审计。本章定义独立 `AuditRecord`：

```ts
interface AuditRecord {
  protocolVersion: 1;
  sessionId: string;
  eventType: RuntimeEvent["type"];
  turnId: string;
  sequence: number;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
}
```

它允许的属性包括：

- tool name 和结果状态；
- permission allow/deny 与 scope；
- Provider 名称和 finish reason；
- token 数；
- error category，不含 error message；
- turn finish reason。

`text_delta` 和 `reasoning_summary_delta` 根本不发往远程 exporter。工具 input、result、
prompt、API key 与审计认证 header 都不会进入 JSON body。

认证 header 使用 `headersFrom` 映射到环境变量，密钥仍不写进配置。缺少指定环境变量时
bootstrap 失败，而不是发送一个未认证请求。

远程 endpoint 必须使用 HTTPS。测试通过注入假的 `fetch` 验证请求，无需网络。

## 10. Fail-open 与 fail-closed 是组织决定

两种失败策略都合理，但适用于不同环境：

- `open`：审计端暂时不可用时记录诊断，Agent 继续工作；
- `closed`：审计发送失败会让当前 turn 失败。

默认是 `open`，避免偶发审计故障让本地工作完全停摆。受监管环境可在 managed 配置中
选择 `closed`。项目配置不能改变它。

每次请求有独立 timeout，并组合调用者的 `AbortSignal`。取消 Agent turn 时不会留下
无限等待的审计请求。

## 11. 从第 22 章迁移

本章的迁移是增量式的：

1. 为 `TerminalRenderer` 增加 `RuntimeRenderer` 接口；
2. 添加 `hosts/protocol.ts` 和 `hosts/adapter.ts`；
3. 添加 plugin manifest schema 与 `PluginCatalog`；
4. 配置 schema 增加 managed-only `teamPolicy`；
5. 添加团队策略 helper；
6. 添加 metadata-only audit exporter；
7. Runtime 在事件路径中调用 exporter；
8. CLI 和 Headless bootstrap 检查 host policy 并创建 exporter；
9. 增加契约测试，不启动真实 IDE、浏览器或远程服务。

现有 CLI 参数、Headless JSONL 协议和 Session 文件格式都不改变。

## 12. 测试

只运行本章测试：

```bash
npm run test:hosts
```

`tests/unit/host-extensions.test.ts` 覆盖：

1. IDE 与 WebSocket 适配器共享协议；
2. 握手和版本错误返回结构化 protocol error；
3. active turn 能被后续消息取消；
4. close 只执行一次；
5. host 事件不包含工具 input、output 或错误正文；
6. 非法 entrypoint、未允许 id 和禁止 capability 被拒绝；
7. user 不能设置或放宽 `teamPolicy`；
8. WebSocket host 可以被 managed policy 禁止；
9. audit body 不包含工具正文或认证密钥；
10. fail-open 和 fail-closed 有确定行为。

完整验收：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:mvp
npm run test:eval
npm run test:subagents
npm run test:lsp
npm run test:hosts
```

所有普通测试都使用 Mock Provider、内存 transport 或本地假进程，不调用真实模型。

## 13. 动手实验

### 实验一：尝试泄露工具参数

在 host 契约测试里把 API key 放入 tool input，再序列化 public event。预期序列化结果
只包含 tool name 和 call id。

### 实验二：用项目配置放宽团队策略

在受信任项目的 `.dugsyn/config.json` 写入：

```json
{
  "teamPolicy": {
    "hosts": { "allowedKinds": ["websocket"] }
  }
}
```

预期配置加载直接失败，错误指出只有 managed 配置能设置组织策略。

### 实验三：让审计服务器失败

令假 `fetch` 抛出 `offline`。`failureMode: "open"` 时应记录诊断并继续；
`failureMode: "closed"` 时当前调用应失败。

### 实验四：取消慢 turn

让假的 runner 一直等待 `AbortSignal`，依次发送 `start_turn` 和 `cancel_turn`。预期
收到 reason 为 `cancelled` 的 `turn_result`，测试不会挂起。

## 14. 本章边界

本章故意没有实现：

- VS Code、JetBrains 或 Neovim 的具体扩展；
- 浏览器 UI；
- 监听公网端口的 WebSocket server；
- 任意第三方 JavaScript 的进程内动态加载；
- 插件下载、签名、升级和撤销服务；
- 多租户身份系统；
- 离线审计队列和重试存储；
- 完整 OpenTelemetry exporter。

这些是独立产品能力。当前接口确保实现它们时无需复制 Agent loop，也不会绕过统一事件、
取消、权限和 managed policy 边界。

## 15. 全书完成检查

到这里，23 章的纵向链路已经完整：

```text
模型流式输出
→ 类型化 Agent loop
→ schema 校验的工具
→ workspace / shell / sandbox
→ 权限与 managed policy
→ diff / checkpoint / Git / tests
→ session / context / headless
→ MCP / hooks / skills / eval
→ subagent / worktree / LSP
→ CLI / IDE / Web / plugin 稳定边界
```

当前仓库可以直接作为 CLI 使用；IDE 和 Web 部分提供的是可实现、可测试的宿主契约，
不是冒充成品的 UI。后续工作应根据真实产品需求在这些边界之外分别建设发布、认证、
插件签名和界面，而不把它们重新耦合进核心 runtime。
