# 第 15 章：Session 持久化、恢复和分支

第 14 章完成了一次进程内的“测试—诊断—修复”循环，但关闭 CLI 后，内存里的 Transcript 和 RuntimeEvent 会全部消失。更危险的是，进程可能在用户消息已经输入、模型或工具尚未完成时崩溃；如果只在回合结束后保存，用户连自己刚才要求 Agent 做什么都无法恢复。

本章实现 durable Session：元数据使用原子替换的 JSON 文件，Transcript 与 RuntimeEvent 使用版本化、只追加的 JSONL。CLI 支持创建、恢复、分支和人类可读导出，并用单写者锁阻止两个进程无保护地修改同一会话。

对应代码 tag：`chapter-15`。

## 1. 先定义持久化边界

Session 保存的是“继续对话所需的状态”和“审计发生过什么所需的事实”：

- session ID、名称、项目绝对路径、创建和更新时间；
- Provider 与模型名称；
- 完整 Transcript，包括 user、assistant、tool 消息；
- 完整 RuntimeEvent 流，包括 usage、权限决定、工具结果和结束原因；
- 分支来源 `parentSessionId`。

以下状态有意不恢复：

- `PermissionEngine` 的 session 临时授权；
- 仍在运行的子进程和后台 job；
- 上一次进程内的 AbortSignal；
- 未完成回合的 checkpoint 控制对象。

尤其不能把“上次允许一次/本会话允许”的权限决定重新变成新的授权。RuntimeEvent 中保留它们是为了审计，不是为了绕过下一进程的权限检查。

Workspace 文件本身已经在磁盘上，因此不复制进 Session。恢复时重新创建 Workspace Trust、权限引擎、沙箱执行器和工具注册表；只有模型对话从 Transcript 继续。

## 2. 会话目录布局

每个 session 有独立目录：

```text
~/.agent-code/sessions/
└── 7b6f.../
    ├── metadata.json
    ├── transcript.jsonl
    ├── events.jsonl
    └── writer.lock       # 仅会话打开期间存在
```

默认放在用户状态目录，而不是被 Agent 操作的项目目录。这样 Session 日志不会污染 `git status`，文件搜索工具也不会把旧模型输出误当成项目源码。

测试、容器或多配置场景可以覆盖位置：

```bash
agent-code chat \
  --provider openai \
  --model gpt-test \
  --session-dir /tmp/agent-code-sessions
```

也可以设置 `AGENT_CODE_SESSION_DIR`。命令行参数优先；所有测试都使用临时目录，不会读取真实用户会话。

## 3. 元数据为什么单独保存

`metadata.json` 是快速定位和恢复配置所需的小对象：

```json
{
  "schemaVersion": 1,
  "sessionId": "7b6f...",
  "name": "repair parser",
  "projectPath": "/work/project",
  "provider": "openai",
  "model": "gpt-test",
  "createdAt": "2026-07-23T01:00:00.000Z",
  "updatedAt": "2026-07-23T01:04:00.000Z"
}
```

更新元数据时先写同目录临时文件，再 `rename` 覆盖目标。读者不会看到只写了一半的 JSON；创建时间保持不变，Transcript 变化时推进更新时间。

名称用于人类识别，ID 才是稳定主键。Session ID 经过字符白名单验证，不能用 `../` 越过 Session 根目录。

## 4. 为什么 Transcript 使用记录而不是反复保存快照

每条新消息写成一行：

```json
{"schemaVersion":1,"type":"message","sequence":0,"recordedAt":"...","message":{"id":"...","role":"user","content":[...],"createdAt":"..."}}
```

只追加记录有三个优点：

1. 一次追加很小，不需要每轮重写越来越大的完整对话；
2. 崩溃最多损坏最后一条，不会让全部历史一起丢失；
3. `sequence` 可以发现缺行、乱序或错误拼接。

`/clear` 不能直接删旧文件，否则会破坏审计历史。本章追加一条 reset 记录：

```json
{"schemaVersion":1,"type":"reset","sequence":12,"recordedAt":"..."}
```

恢复器重放到 reset 时清空当前消息列表，再处理后续消息。旧记录仍在磁盘上，人类可以知道发生过清空；恢复给模型的 Transcript 只包含 reset 之后的内容。

如果传入的 Transcript 不再以前一次为前缀，例如未来功能替换了对话，存储层同样追加 reset 和新的完整消息序列，不会原地篡改旧行。

## 5. RuntimeEvent 使用独立 JSONL

事件记录与 Transcript 分开：

```json
{"schemaVersion":1,"type":"runtime_event","sequence":0,"recordedAt":"...","event":{"protocolVersion":1,"type":"turn_started",...}}
```

外层 `schemaVersion` 属于 Session 文件格式；内层 `protocolVersion` 属于第 2、9 章建立的 RuntimeEvent 协议。两者不能共用一个版本号：Session 信封可能增加压缩或索引，而 RuntimeEvent 本身不需要改变；反过来也一样。

写入前仍用现有 Zod schema 验证事件。每行通过一个文件句柄写入后调用 `sync`，再关闭句柄。单写者锁保证同一文件没有两个进程交错追加。

## 6. 落盘顺序决定崩溃后能恢复什么

用户输入的顺序是：

```text
构造 user message
      ↓
fsync transcript.jsonl
      ↓
调用 Provider
      ↓
逐条 fsync RuntimeEvent
      ↓
回合完成后追加 assistant/tool messages
```

最重要的是第二步发生在 Provider 和工具副作用之前。若进程随后异常退出，恢复后的 Transcript 至少包含用户的原始要求；下次运行可以重新处理它。若先调用模型、只在最后保存，崩溃时既可能已经改过文件，又没有 durable intent，用户很难判断发生了什么。

RuntimeEvent 在运行时发出时立即追加，因而异常退出前已经完成的工具结果仍可审计。不过当前 Runtime 只在一个 Provider step 完成后返回 assistant/tool Transcript 消息，所以崩溃时可能出现：

- Transcript 最后是 user message；
- events.jsonl 已包含部分 `turn_started`、工具或错误事件；
- 没有 `turn_finished`。

恢复器不会伪造 `turn_finished`，也不会把事件反向拼成模型消息。它从最后一个 durable Transcript 状态继续，这是比猜测半个 Provider 响应更安全的边界。

## 7. 处理最后半条 JSONL

进程可能正好死在写入一行中间。读取器遵守两条规则：

- 中间任何坏行都视为会话损坏并拒绝恢复；
- 只有“文件末尾、没有换行、无法解码”的半行可以忽略。

只忽略还不够：若下次直接 append，新 JSON 会粘在半行后面，形成永久坏行。因此 `open()` 在取得写锁后会把文件截断到最后一个完整换行；如果最后一条 JSON 完整但缺少换行，则补上换行。只读的 export 不修文件，避免无锁写入。

这让异常退出恢复成为真正可继续写的恢复，而不只是“一次勉强能读”。

## 8. 单写者锁

打开会话时用 `open(..., "wx")` 独占创建 `writer.lock`。锁内容包括：

```json
{
  "schemaVersion": 1,
  "token": "random-owner-token",
  "pid": 12345,
  "hostname": "build-machine",
  "acquiredAt": "2026-07-23T01:00:00.000Z"
}
```

第二个进程看到同机仍存活的 PID 时抛出 `SessionLockedError`，而不是继续写。正常关闭只在 token 仍属于自己时删除锁，不能误删后来者的锁。

异常退出会留下陈旧锁。若锁来自同一主机，并且操作系统能确定该 PID 已不存在，下一次 `open()` 删除陈旧锁并重试一次。其他主机或无法验证的锁不会自动抢占，因为共享目录里的网络分区不能靠本机 PID 判断。

这是一个不增加原生依赖的教程实现。PID 极端复用和网络文件系统锁语义仍是已知边界；生产版可换成 OS advisory lock 或带租约/心跳的协调服务，而 SessionStore 的上层接口无需改变。

## 9. `--resume` 的语义是恢复，不是静默改配置

恢复命令可以省略 Provider、模型和 workspace：

```bash
agent-code --resume 7b6f... \
  --session-dir /tmp/agent-code-sessions
```

CLI 从 metadata 恢复这些值，再根据 Provider 要求对应 API key。若显式参数与 metadata 不同，命令拒绝执行并提示使用 fork。例如旧会话属于 `/work/a`，不能用 `--resume` 悄悄改成 `/work/b`。

恢复会重新执行：

- Workspace Trust 检查；
- 新的 PermissionEngine；
- 新的沙箱和 ProcessManager；
- 新的 CodingAgentRuntime。

它不会恢复旧进程的 session 权限、后台命令或内存 checkpoint。项目磁盘可能在两次运行之间被用户修改；现有 patch 哈希、checkpoint 冲突和 Git 所有权规则仍负责保护这些新状态。

## 10. `--fork-session` 创建真正独立的分支

分支复制源会话当前重放得到的 Transcript，但创建新的：

- session ID 和目录；
- 创建/更新时间；
- 事件日志；
- 写锁；
- 运行时与临时权限状态。

新 metadata 记录 `parentSessionId`。源 RuntimeEvent 不复制到分支，因为那些事件发生在父会话中；父 ID 已提供审计链接。

```bash
agent-code --fork-session 7b6f... \
  --provider deepseek \
  --model deepseek-v4-pro \
  --session-name "try deepseek"
```

与 resume 不同，fork 可以换 Provider、模型或 workspace。之后两边追加各自 JSONL，互不影响。

## 11. 人类可读导出

JSONL 适合可靠写入和机器重放，不适合直接阅读。导出命令只读 Session，生成 Markdown 到 stdout：

```bash
agent-code session export 7b6f... > session.md
```

输出包含 metadata、按角色排列的对话、工具调用/结果和 RuntimeEvent 时间线。源文件不被改写，Markdown 也不是恢复输入；唯一权威状态仍是经过 schema 验证的 metadata 和 JSONL。

导出可能包含源码片段、命令输出和模型回复，应像处理终端日志一样保护，不能默认公开上传。

## 12. Schema 迁移

`SessionStore` 读取每个对象前先检查 `schemaVersion`。本章当前写入 version 1，同时提供 version 0 到 version 1 的显式迁移器：

- metadata 的 `id/title/cwd/parentId` 映射为当前字段；
- 旧 Transcript message 信封补上 type、sequence 和 recordedAt；
- 旧 RuntimeEvent 信封补上 type、sequence 和 recordedAt。

迁移先发生在内存中，原始旧日志不会在无锁 `read()` 时被悄悄覆盖。打开后新增记录使用当前版本；无法识别的新版本会明确失败，不会用宽松解析丢字段。

生产系统通常还会提供单独的离线 migration 命令，在备份、校验后整体升级文件。本章先建立兼容读取和版本路由，避免把未来迁移写成散落的 `if (field)`。

## 13. CLI 使用

创建命名会话：

```bash
OPENAI_API_KEY=... agent-code chat \
  --provider openai \
  --model gpt-test \
  --workspace . \
  --session-name "fix parser"
```

恢复：

```bash
OPENAI_API_KEY=... agent-code --resume <session-id>
```

从旧对话分支并换模型：

```bash
DEEPSEEK_API_KEY=... agent-code --fork-session <session-id> \
  --provider deepseek \
  --model deepseek-v4-pro
```

导出不调用 Provider，也不需要 API key：

```bash
agent-code session export <session-id>
```

CLI 仍不会自动读取 `.env.local`。Session metadata 只保存 Provider 名称和模型名称，绝不保存 API key。

## 14. 测试覆盖

新增离线测试覆盖：

- metadata、Transcript 与 RuntimeEvent 往返保存；
- user message 在 turn runner 启动前 durable 写入；
- 事件发出时立即持久化；
- 同一 session 的第二个活跃 writer 被拒绝；
- 同机死 PID 的陈旧锁可回收；
- 最后半条 JSONL 被修复后仍可继续追加；
- version 0 metadata、Transcript 和 event 迁移；
- fork 复制 Transcript、记录 parent、但不复制 events；
- Markdown 导出；
- 构建后的 CLI 完成 create、resume、fork、export，全程不访问 Provider。

运行本章验收：

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

普通测试使用 Mock、临时目录和 slash command，不需要 OpenAI 或 DeepSeek API key。

## 15. 已知边界

当前 Session 没有搜索索引或列表命令，恢复需要已知 ID。JSONL 会随长期会话持续增长，第 16 章的上下文压缩只减少送给模型的内容，不会自动删除审计历史；后续可增加归档与索引。

RuntimeEvent 能保留崩溃前已经 fsync 的事实，但本章不自动重放未完成工具。盲目重放写文件、Shell 或网络调用可能重复副作用，因此恢复的是 durable conversation，不是“从任意指令地址继续执行”。

锁设计面向单机本地 CLI。共享 NFS、多主机并发和 PID 极端复用需要更强协调机制。无法验证的锁必须由用户检查，而不是按时间自动删除。

metadata 的原子 rename 避免半文件，但本章没有对每次 rename 后的父目录做平台专属 fsync；对需要断电级持久性的数据库式产品，应使用经过验证的存储引擎。

## 16. 本章验收清单

- [x] Session metadata 包含 ID、名称、项目路径、Provider、模型和时间。
- [x] Transcript 和 RuntimeEvent 使用独立、版本化 JSONL。
- [x] user message 在 Provider/工具副作用前落盘。
- [x] 异常退出留下的尾部半行可以恢复并继续追加。
- [x] `/clear` 使用 append-only reset，不删除审计历史。
- [x] `--resume` 恢复对话和运行配置。
- [x] `--fork-session` 创建带 parent 的独立分支。
- [x] 临时权限、进程和 AbortSignal 不跨进程恢复。
- [x] 同一 session 只有一个活跃 writer。
- [x] 同机死进程留下的陈旧锁可回收。
- [x] 旧 schema 有显式迁移路径，未知版本明确失败。
- [x] 支持只读 Markdown 导出。
- [x] 所有验收测试离线运行。

## 17. 与原教程的关系

本章对应原教程 ch9 的外部状态与 ch21 的 checkpoint/resume 思想。实战实现把“持久化”放在现有 Transcript、RuntimeEvent、CLI Session 和权限边界之间，没有引入第二套 Agent 状态机，也没有把审计事件误当成可直接重放的命令。

## 18. 下一章留下的问题

Session 能恢复完整历史，但对话越来越长时，直接把全部 Transcript 发送给模型会变慢、变贵并最终超过上下文窗口；项目还缺少用户级、仓库级和目录级指令加载。

第 16 章会实现上下文预算、压缩和项目指令：显示各部分占用，在压缩摘要中保留任务目标、未完成步骤、关键工具结果，并按目录范围加载嵌套规则。
