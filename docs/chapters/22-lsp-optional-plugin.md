# 第 22 章：LSP 作为可选插件

前二十一章已经让 Agent 可以搜索、读取、修改、测试代码，也可以把独立任务分派到
worktree。它不认识语言服务器，仍然可以完成完整工作流。

本章增加 LSP（Language Server Protocol）查询，但先确定一条产品边界：

```text
LSP 是增强，不是 Coding Agent 的生存条件。
```

因此本章不会用 LSP 替换 `search_text`、`read_file` 或 `run_tests`，也不会把语言
服务器的重构结果直接写进工作区。我们只添加只读分析工具，并让任何启动、协议或超时
错误都退回已有核心工具。

本章使用 `vscode-jsonrpc` 的 `StreamMessageReader` 和 `StreamMessageWriter` 处理
stdio 上的 `Content-Length` framing，不手写 JSON-RPC 拆包器。测试使用本地假语言
服务器，不调用真实模型，也不要求安装 TypeScript、Rust 或 Python 语言服务器。

## 1. 先写行为规格

配置一个 TypeScript 语言服务器：

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "languageIds": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      },
      "timeoutMs": 5000
    }
  }
}
```

连接成功后，Provider 多看到一个工具：

```text
lsp_typescript_query
```

它支持四种只读请求：

```text
hover
definition
references
document_symbols
```

例如：

```json
{
  "operation": "definition",
  "path": "src/index.ts",
  "line": 18,
  "character": 11
}
```

`line` 和 `character` 都是 LSP 原生的零基坐标；`character` 按默认 UTF-16 code unit
计算。`document_symbols` 不需要位置。

语言服务器不存在或初始化失败时：

- CLI 仍然启动；
- 不注册该服务器的 LSP 工具；
- stderr 解释失败原因和回退工具；
- `search_text`、`read_file`、`run_tests` 继续可用。

这不是把失败伪装成成功。工具不存在能阻止模型继续依赖坏掉的服务器，诊断则告诉用户
如何恢复增强能力。

## 2. 为什么不手写 Content-Length framing

LSP 的 stdio 不是“一行一个 JSON”。每条消息包含 ASCII header 和按字节计数的正文：

```text
Content-Length: 123\r\n
\r\n
{...123 bytes...}
```

一个 `data` 事件可能只有半条消息，也可能同时包含多条消息。正文中的非 ASCII 字符还
意味着 JavaScript 字符数不等于 UTF-8 字节数。可靠实现必须处理：

- header 与 body 分段到达；
- 多条消息粘在同一个 chunk；
- UTF-8 字节长度；
- writer backpressure；
- request id、response 和错误；
- `$/cancelRequest`；
- connection close 与 pending request。

这些问题与 Agent 的产品价值无关，却很容易制造偶现死锁。因此安装成熟库：

```bash
npm install vscode-jsonrpc
```

客户端只组合库提供的 reader、writer 和 connection：

```ts
const reader = new StreamMessageReader(child.stdout);
const writer = new StreamMessageWriter(child.stdin);
const connection = createMessageConnection(reader, writer);

connection.listen();
```

本章的假语言服务器也使用同一协议库。集成测试由两个真实 Node 子进程通过
Content-Length stdio 通信，所以测试覆盖的不是内存 mock 接口。

## 3. 可选 Toolset，而不是核心 Runtime 分支

新增：

```text
src/extensions/lsp.ts
```

入口和第 19 章 MCP 扩展保持同一种结构：

```ts
interface LspToolset {
  readonly tools: readonly Tool[];
  readonly connectedServers: readonly string[];
  readonly failures: Readonly<Record<string, string>>;
  readonly fallbackTools: readonly string[];
  dispose(): Promise<void>;
}
```

`createLspToolset()` 逐个初始化服务器。一个服务器失败不会阻止其他服务器连接：

```ts
for (const [name, configuration] of Object.entries(options.servers ?? {})) {
  try {
    const client = await factory(name, configuration, workspaceRoot, environment);
    await client.initialize();
    tools.push(createLspQueryTool(name, client));
  } catch (error) {
    failures[name] = describeError(error);
    diagnostic?.(
      `LSP server ${name} unavailable: ... ` +
      "Falling back to search_text, read_file, run_tests.",
    );
  }
}
```

没有 `lspServers` 配置时，循环为空，不启动子进程，也不注册工具。默认核心因此不依赖
LSP 可执行文件。

Runtime 只是把成功创建的工具并入普通注册表：

```ts
const allTools = [
  ...fileToolset.tools,
  ...gitTools,
  ...shell.tools,
  ...testTools,
  ...mcp.tools,
  ...lsp.tools,
];
```

后续的 schema 校验、重复调用保护、Hook 和 Permission Engine 全部复用现有路径。
LSP 查询声明：

```ts
sideEffects: ["read_workspace", "execute_process"]
```

语言服务器在扩展发现阶段启动，所以项目配置只有在第 17 章的 workspace trust 通过后
才会被读取。信任陌生仓库前，不应允许其配置任意语言服务器命令。查询工具仍然经过普通
权限规则。

## 4. 安全启动语言服务器

语言服务器命令使用 executable 和 args 数组：

```ts
spawn(configuration.command, configuration.args ?? [], {
  cwd: canonicalWorkspaceRoot,
  env: extensionEnvironment(environment, configuration.envFrom),
  shell: false,
  stdio: "pipe",
});
```

这里有四个约束：

1. `shell: false`，配置值不经过 shell 插值；
2. cwd 固定为规范化后的 workspace root；
3. 默认环境只保留 `PATH`、locale、临时目录和 Windows 启动必需字段；
4. 额外变量只能通过 `envFrom` 显式映射。

因此 `OPENAI_API_KEY` 和 `DEEPSEEK_API_KEY` 不会自动传给语言服务器。若某个可信服务
确实需要变量，可以显式声明：

```json
{
  "envFrom": {
    "SERVER_LICENSE": "MY_LSP_LICENSE"
  }
}
```

客户端先等待子进程的 `spawn` 事件，再发送 initialize。不存在的命令会在任何协议写入
之前失败，避免“spawn error 与 stdin write error”竞态。

LSP 子进程本身不是第 8 章 Shell 工具启动的短任务，不能假设所有第三方语言服务器都
安全。配置语言服务器等于授权一个长期本地进程读取工作区；这正是它必须属于可信用户
配置或已信任项目配置的原因。

## 5. 正确初始化 workspace

工作区路径不能直接拼成 `file://` 字符串。空格、中文、`#` 和平台路径格式都可能产生
无效 URI。本章对规范化路径调用：

```ts
const workspaceUri = pathToFileURL(canonicalWorkspaceRoot).href;
```

initialize 请求同时设置旧服务器常用的 `rootUri` 和支持 workspace folders 的字段：

```ts
{
  processId: process.pid,
  clientInfo: { name: "dugsyn", version: "0.1.0" },
  rootUri: workspaceUri,
  capabilities: {
    workspace: {
      workspaceFolders: true,
      configuration: true
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        didSave: false
      },
      hover: { dynamicRegistration: false },
      definition: { dynamicRegistration: false },
      references: { dynamicRegistration: false },
      documentSymbol: {
        dynamicRegistration: false,
        hierarchicalDocumentSymbolSupport: true
      }
    }
  },
  workspaceFolders: [{
    uri: workspaceUri,
    name: basename(canonicalWorkspaceRoot)
  }]
}
```

收到合法 initialize result 后，客户端发送 `initialized`。同时为常见的
`workspace/configuration`、`client/registerCapability` 和
`client/unregisterCapability` 请求提供最小响应，避免服务器在启动时永久等待。

客户端不注册 `workspace/applyEdit`。即使服务器建议编辑，也不能绕开第 6、11 和
12 章的 path guard、版本哈希、checkpoint 和冲突检测。

## 6. 文档 URI、语言 ID 和版本

每次查询先通过 `WorkspacePathGuard` 解析相对路径：

```ts
const resolved = await guard.resolveExisting(path);
```

它继续拒绝绝对路径、`..` 逃逸、敏感文件和指向工作区外的 symlink。文件还必须：

- 是普通文件；
- 不超过 `maxDocumentBytes`，默认 1 MiB；
- 是无 NUL 的合法 UTF-8 文本；
- 后缀能匹配配置中的 `languageIds`。

首次查询文件时发送：

```ts
connection.sendNotification("textDocument/didOpen", {
  textDocument: {
    uri,
    languageId,
    version: 1,
    text
  }
});
```

客户端缓存实际文本。再次查询前重新读取文件；内容相同时沿用版本，内容变化时版本加一：

```ts
connection.sendNotification("textDocument/didChange", {
  textDocument: {
    uri,
    version: previous.version + 1
  },
  contentChanges: [{ text }]
});
```

本章使用 full-text synchronization。它多传一些文本，但状态模型简单且容易验证，不会
因为自行计算增量 range 而让客户端和服务器版本分叉。

注意：工具输入的位置来自模型，客户端不会尝试把人类的一基行列“自动修正”为零基。工具
描述明确说明坐标约定，测试也断言原值到达服务器。

## 7. 请求超时和取消

长期运行的语言服务器仍可能卡住。每个请求同时受两类信号控制：

- 当前 Agent turn 的 `AbortSignal`；
- LSP server 配置的 `timeoutMs`。

请求创建 `CancellationTokenSource` 并传给协议库：

```ts
const source = new CancellationTokenSource();
const request = connection.sendRequest(method, params, source.token);
```

用户取消或 timer 到期时调用：

```ts
source.cancel();
```

协议库负责向服务器发送 `$/cancelRequest`。客户端自己也让等待中的 Promise 立即失败，
不要求坏掉的服务器必须正确响应取消。

错误信息包含明确回退建议：

```text
LSP hover failed: ... Use search_text, read_file, and run_tests.
```

取消当前请求不会自动杀死健康连接；CLI 退出时才走完整生命周期：

```text
shutdown request
  → exit notification
  → 短暂等待服务自行退出
  → dispose connection
  → 必要时 SIGTERM
  → 最后才 SIGKILL
```

`CodingAgentRuntime.dispose()` 同时等待 Shell、MCP 和 LSP 资源释放。

## 8. LSP 输出仍然不可信

语言服务器通常分析项目源码，而源码可能包含提示注入文本；第三方服务器也可能返回任意
字符串。因此工具结果有显式边界：

```text
[Untrusted LSP analysis from server "typescript"]
...
[End untrusted LSP analysis]
```

结构化数据也带 provenance：

```json
{
  "provenance": {
    "trust": "external_untrusted",
    "server": "typescript",
    "protocol": "lsp"
  },
  "path": "src/index.ts",
  "operation": "definition",
  "documentVersion": 1
}
```

“definition 返回这个位置”适合帮助导航，不等于代码正确。关键结论仍要读取目标文件，
修改后仍要运行测试。

## 9. 配置层接线

第 17 章配置 schema 新增 `lspServers`。每个服务器要求：

```text
command       非空 executable
languageIds   至少一个 “.suffix” → “language-id”
```

可选字段：

```text
args
timeoutMs
maxDocumentBytes
envFrom
initializationOptions
enabled
```

不同配置层按服务器名字合并。后层可以替换同名服务器；不同名字可以并存。project 和
local 配置仍然只有在 workspace 已由 managed/user 配置列入 `trustedWorkspaces`
之后才读取。

配置本身只声明服务器，不保证机器上已经安装对应 executable。安装与版本管理属于每种
语言的部署问题；失败隔离正是可选插件设计的一部分。

## 10. 集成测试

运行本章专项测试：

```bash
npm run test:lsp
```

`tests/integration/lsp-plugin.test.ts` 启动一个真实 Node 子进程作为假语言服务器。客户端
和服务器两端都使用 `vscode-jsonrpc`，覆盖：

1. Content-Length framing 可以完成真实 initialize 和 query；
2. `rootUri` 与 `workspaceFolders[].uri` 使用规范化 file URI；
3. API key 不进入语言服务器环境；
4. `.ts` 映射为 `typescript`；
5. 首次 `didOpen` 的 version 是 1；
6. 文件内容变化后 `didChange` 的 version 是 2；
7. hover/definition 的零基位置没有被改写；
8. 慢请求超时并向服务器发送取消；
9. dispose 发送 shutdown 和 exit；
10. executable 不存在时不注册 LSP 工具，核心搜索、读取和测试工具仍存在。

最后运行全套验收：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:mvp
npm run test:eval
npm run test:subagents
npm run test:lsp
```

这些测试都不访问真实语言服务器或模型 API。

## 11. 本章边界

本章故意没有实现：

- completion 和 code action；
- server 发起的 workspace edit；
- rename 自动落盘；
- 增量文本 diff；
- 多 root workspace；
- TCP、socket 或远程 LSP；
- 自动下载语言服务器；
- 为所有语言猜测默认命令；
- 把 diagnostics 自动塞进每轮 prompt。

这些功能都可能有价值，但会扩大写权限、部署面或上下文成本。当前接口已经能让后续插件
按需添加操作，而无需让核心 Agent 依赖任何一个语言生态。

## 12. 验收清单

完成本章后应满足：

- [x] 默认 runtime 没有 LSP 配置也能完整工作；
- [x] Content-Length framing 由成熟库处理；
- [x] 工作区和文档 URI 使用 `pathToFileURL()`；
- [x] 文档首次打开为 v1，内容变化后单调递增；
- [x] 每个请求有 timeout 和协议取消；
- [x] LSP 只能提供只读辅助分析；
- [x] 输出标记为不可信；
- [x] 环境变量默认不包含模型 API key；
- [x] 单个服务器失败不会阻止 CLI 启动；
- [x] 失败时明确回退到搜索、读取和测试；
- [x] Runtime dispose 关闭 LSP 子进程。

下一章将不再往核心仓库塞多个界面实现，而是整理稳定的插件、CLI renderer、IDE
transport 和团队策略接口，让当前 Agent runtime 可以被不同宿主复用。
