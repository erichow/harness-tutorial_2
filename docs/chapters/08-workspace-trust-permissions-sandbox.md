# 第 8 章：Workspace Trust、权限与沙箱

第 7 章已经能运行任意 shell program，但“工具可以执行”不等于“这次执行被允许”，路径检查也不等于操作系统隔离。本章把四层边界串起来：

```text
Workspace Trust
→ Permission Rules
→ Interactive Decision
→ OS Sandbox Enforcement
```

对应代码快照：`chapter-08`。

## 1. 四层分别解决什么问题

| 层 | 回答的问题 | 不能替代什么 |
| --- | --- | --- |
| Workspace Trust | 是否加载项目自己提供的配置、Hooks、MCP 和权限规则 | 不批准某一次工具调用 |
| Permission Rules | managed、用户和项目策略是否 allow / ask / deny | 不约束已经启动的进程 |
| Interactive Decision | 用户是否允许本次或本会话的精确请求 | 不应覆盖上级 deny |
| OS Sandbox | 进程实际上能访问哪些文件和网络能力 | 不理解用户意图 |

这四层必须同时存在。Prompt injection 可能骗过模型和确认文案；真正启动的恶意程序也不会遵守 TypeScript 路径检查。反过来，只有沙箱而没有权限提示，Agent 仍可能在 workspace 内删除重要源码。

## 2. Trust 绑定 canonical workspace

同一目录可以通过真实路径和 symlink 别名访问。如果只保存用户输入的字符串，攻击者可以用别名制造不同 trust 身份。`WorkspaceTrust.create()` 会对 workspace 和可信根目录都执行 `realpath`，并确认它们是目录：

```ts
const trust = await WorkspaceTrust.create({
  workspaceRoot,
  trustedRoots: userConfiguration.trustedRoots,
});
```

未信任 workspace 时，下面四类项目控制能力都禁用：

```text
config
hooks
mcp
permission_rules
```

这里的含义不是“不读任何项目文件”，而是不能执行项目提供的代码，也不能让项目配置放宽安全边界。CLI 将来的 `/status` 应显示 trust 状态，并让用户通过明确交互更改持久配置；不能因为仓库里存在一个 `trusted: true` 就相信它。

查看 [`trust.ts`](../../agent-code/src/security/trust.ts)。

## 3. PermissionDecision 与执行位置

权限结果使用稳定联合类型：

```ts
type PermissionDecision =
  | { kind: "allow"; scope: "once" | "session" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };
```

Tool Registry 的顺序现在是：

```text
找到工具
→ JSON Schema 校验完整参数
→ PermissionEngine.authorize(tool + full input + side effects)
→ 重复调用保护
→ handler
→ 有界结果信封
```

Schema 校验在权限之前，避免为根本不合法的调用打扰用户；权限必须在 handler 之前，保证被拒绝的调用没有副作用。拒绝以 `permission_denied` 工具错误返回模型，模型可以改用更小权限的方案，但不能继续假设操作已经成功。

```ts
const permissions = new PermissionEngine({
  trust,
  userRules,
  projectRules,
  decide: askUser,
});

const executor = new ToolRegistry(tools, { permissions }).createExecutor();
```

第 9 章会实现真正的终端确认状态机。本章的 `decide` 是可注入异步边界；如果没有交互 handler，`ask` 会安全地变成 deny，而不是自动放行。

## 4. 固定的规则优先级

本章使用下面的全局优先级：

```text
managed deny
→ user deny
→ project deny
→ explicit ask
→ allow
→ default policy
```

一个规则可以匹配 tool、side effect 和规范化 resource：

```ts
const userRules: PermissionRule[] = [
  {
    id: "no-network",
    action: "deny",
    sideEffects: ["network"],
    reason: "This session must remain offline.",
  },
  {
    id: "confirm-edits",
    action: "ask",
    sideEffects: ["write_workspace"],
  },
];
```

项目的 `allow network` 永远不能覆盖用户的 `deny network`。即使 workspace 已信任，project rule 也只在自己的优先级层参与；workspace 未信任时，所有 project rule 直接不参与求值。

内建 managed deny 还保护：

- `.env`、`.env.local`、SSH key、`.aws`、`.gnupg` 等敏感资源。
- 文件工具的 workspace 外部路径。

文件工具自身的 `WorkspacePathGuard` 和 `WorkspaceFilePolicy` 仍保留。这是 defense in depth：权限层给出一致决策和审计，工具边界防止调用者绕过 Registry 后直接误用 handler 所依赖的路径组件。

## 5. 完整参数规范化与会话授权

“本次会话允许”不能用下面这种 key：

```ts
`${toolName}:${JSON.stringify(input).slice(0, 100)}`
```

两条前 100 字符相同、尾部不同的 shell 命令会发生授权碰撞；对象键顺序不同又会制造不必要的新提示。本章先递归排序 JSON object key，再把下面内容整体做 SHA-256：

```text
toolName
full canonical input
sorted side effects
normalized resources
```

所以同一请求即使 object key 顺序不同也能命中 session grant，尾部只差一个字符则必须重新确认。每次授权前仍先检查全部 deny，因此后来出现的 managed/user deny 不会被旧 session grant 绕过。`clearSessionGrants()` 在会话结束或用户执行权限清理命令时删除所有临时授权。

## 6. Resource 是统一审计语言

权限请求会把资源规范化为稳定标签：

```text
effect:read_workspace
effect:write_workspace
effect:execute_process
effect:network
workspace:src/index.ts
external:../private.txt
sensitive:.env.local
network:api.example.com
network:*
```

路径来自结构化 `path` / `cwd` 参数；URL hostname 会从所有字符串参数中提取用于审计。Shell 工具始终声明 `network`，因此无论命令里是否看得到 URL，都包含 `network:*`。

域名提取不是网络沙箱。`python -c` 可以在运行时拼出任意地址，程序也可以直接连接 IP。域名标签只帮助规则、确认文案和审计；强制断网依赖 OS sandbox 的 `network*` 能力。

审计记录保存 timestamp、tool、resource、decision、scope、reason 和完整请求的 fingerprint，不默认重复保存可能含 token 的原始命令。交互 handler 会收到完整结构化请求，以便 CLI 生成准确确认内容。

查看 [`permissions.ts`](../../agent-code/src/security/permissions.ts)。

## 7. 默认策略与读取秘密

“只读”并不等于安全。读取 `.env`、SSH key 或云凭据后，内容会进入模型上下文，之后可能被发送到远端 Provider。因此默认策略是 `ask`，没有交互 handler 时 fail closed。

应用可以显式配置 `defaultDecision`：

```ts
new PermissionEngine({
  trust,
  defaultDecision: "deny",
});
```

教程不会把所有 `read_workspace` 自动放行。实际产品可以加入细化 user allow，例如允许读取 `src/*`，但敏感路径的 managed deny 仍优先。

## 8. 真正的 macOS Seatbelt runner

`MacOsSeatbeltRunner` 不再通过命令前缀猜安全性，而是把整条 shell program 交给 `/usr/bin/sandbox-exec`，使用 Seatbelt profile 限制能力：

- 允许读取 workspace 和运行系统程序所需的系统目录。
- 只允许写 workspace（以及 `/dev/null`）。
- 默认不授予 `network*`。
- 进程仍使用第 7 章的独立进程组、timeout 和清理流程。

创建时应使用平台选择器：

```ts
const runner = createPlatformSandboxRunner({
  workspaceRoot,
  allowNetwork: false,
  fallback: "closed",
});

const shell = await createShellTools({ workspaceRoot, runner });
```

选择器不仅检查文件是否存在，还会运行一个无副作用 probe。某些容器或已有沙箱禁止嵌套 Seatbelt；只看 `/usr/bin/sandbox-exec` 存在会错误报告已经隔离。

当前章节只实现并测试 macOS。Linux 应加入 bubblewrap / Landlock 等独立 runner，Windows 应加入 AppContainer 或受限 token 实现；在这些实现完成前不能把普通 child process 标成 sandboxed。

查看 [`sandbox-runner.ts`](../../agent-code/src/tools/shell/sandbox-runner.ts)。

## 9. fail-closed 与 fail-open 必须明确配置

平台沙箱不可用时有两种策略：

```ts
type SandboxFallback = "closed" | "open";
```

- `closed` 是默认值。`ClosedSandboxRunner` 拒绝 spawn，命令完全不执行。
- `open` 必须显式设置。它返回 `HostSandboxRunner`，状态为 `enforced: false`、`filesystem: "host"`、`network: "unrestricted"`，并输出警告。

状态字段描述的是事实：

```ts
interface SandboxStatus {
  enforced: boolean;
  network: "isolated" | "unrestricted" | "blocked";
  filesystem: "workspace-only" | "host" | "blocked";
  warning?: string;
}
```

fail-closed runner 的命令没有启动，所以文件与网络状态都是 `blocked`，但 `enforced` 仍是 false：这准确表达“没有 OS sandbox 可供运行程序”，而不是把拒绝执行冒充沙箱成功。

## 10. 权限与沙箱如何一起工作

一个 shell 调用的完整路径如下：

```text
模型请求 run_shell
→ Schema 校验 command / cwd / timeoutMs
→ 权限规则看到 execute_process + network + 完整参数
→ 必要时询问用户
→ deny：返回 permission_denied，不启动进程
→ allow：ProcessManager 校验 cwd 和最小环境
→ SandboxRunner 施加 OS 能力边界
→ timeout / cancel / stop 清理进程树
→ 工具结果报告真实 sandbox status
```

权限允许网络但 Seatbelt 禁网时，网络仍不可用；这是更严格边界生效。权限拒绝时则根本不会到达沙箱。产品层可以根据批准的能力选择不同 runner/profile，但不能因为用户点了 allow 就退回无警告的 Host runner。

## 11. 测试策略

[`security-permissions.test.ts`](../../agent-code/tests/unit/security-permissions.test.ts) 覆盖：

- trust 使用 canonical path，未信任 workspace 禁用 Hooks/MCP/project rules。
- `.env`、SSH、AWS 和 key 文件在 prompt 前被拒绝。
- managed/user/project deny 和 ask/allow 优先级。
- 项目 allow 不能覆盖用户 deny。
- 完整规范化 session grant，不发生 100 字符前缀碰撞。
- workspace 外路径与网络域名进入同一资源模型。
- Schema 校验、权限和 handler 的执行顺序。

[`sandbox-runner.test.ts`](../../agent-code/tests/unit/sandbox-runner.test.ts) 覆盖 fail-open、fail-closed，以及在当前进程允许应用 Seatbelt 时的真实 workspace 写入和外部读取拒绝。如果测试进程已经处于不可嵌套的 OS 沙箱，真实 Seatbelt case 会跳过；probe 和 fail-closed 测试仍会确认实现不会谎报隔离状态。

## 12. 从第 7 章迁移

查看完整差异：

```bash
git diff chapter-07..chapter-08
```

新增结构：

```text
src/security/
├── trust.ts             # canonical workspace trust 与项目能力 gate
└── permissions.ts       # 规则、交互、session grant 与审计

tests/unit/
├── security-permissions.test.ts
└── sandbox-runner.test.ts
```

同时扩展：

- `ToolRegistry`：校验后、handler 前调用 PermissionEngine。
- `ToolErrorCode`：加入 `permission_denied`。
- `SandboxRunner`：加入 filesystem 状态、macOS Seatbelt 和明确 fallback。
- Shell 结果：同时报告网络与文件系统隔离状态。

没有新增运行时依赖。

## 13. 完成检查

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

本章测试不访问 GPT 或 DeepSeek API，也不会读取 `.env.local`。

本章 tag：

```bash
git tag -a chapter-08 -m "Chapter 08: add workspace trust permissions and sandbox"
```

## 14. 动手实验

先写一条 user `deny network` 和一条 project `allow network`，分别在 trusted/untrusted workspace 求值，确认两种情况下项目都不能绕过 user deny。

再让确认回调对 `run_shell` 返回 `allow_session`。使用键顺序不同但内容相同的参数重试，然后只修改 200 字符之后的命令尾部，确认前者复用授权、后者重新询问。

最后在允许 Seatbelt 的 macOS 终端运行 shell 测试：写 workspace 文件应成功，读取 workspace 外临时 secret 应失败。再把 fallback 改为 `open` 模拟无沙箱平台，确认结果明确显示 host/unrestricted 警告。

## 15. 下一章留下的问题

权限引擎已经有异步确认边界，但当前 CLI 还没有一个能同时协调模型流、工具状态、权限提示和 Ctrl-C 的输入控制器。下一章会实现单一终端状态机、非 TTY 渲染、斜杠命令和“第一次 Ctrl-C 取消当前 turn，空闲时才退出”的交互语义。
