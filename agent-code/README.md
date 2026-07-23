# agent-code

`agent-code` 是《从零构建 Coding Agent CLI》实战教程的伴随项目。

当前章节：第 22 章。

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e
node dist/cli/bin.js --help
```

确定性的完整 MVP 验收：

```bash
npm run test:mvp
```

普通测试不访问模型 API，也不需要 API key。

可观测性和工作流 Eval：

```bash
npm run test:eval
```

Runtime 通过 `runtime.trace.snapshot()` 提供 session、turn、Provider request
和 tool call span，只记录耗时、token、错误类别和权限结论，不复制 prompt 或
工具正文。`EvalRunner` 会为每次重复运行创建独立临时 Git 仓库，用真实测试、
diff 和 Git status 评分，并返回正式的 `passed/total`、成功率和方差字段。完整
设计与示例见[第 20 章](../docs/chapters/20-observability-workflow-eval.md)。

Subagent 和 Worktree 隔离：

```bash
npm run test:subagents
```

`SubagentCoordinator` 为每个独立任务创建单独的 Transcript、受父任务约束的
工具白名单和 Git worktree。实际变更会被检查并提交为 artifact；多个 artifact
只会在临时集成 worktree 中解决冲突和运行测试，通过后才 fast-forward 父分支。
父 Agent 只收到结构化摘要、trace 与 commit/diff 引用。完整设计见
[第 21 章](../docs/chapters/21-subagent-worktree-isolation.md)。

可选 LSP 插件：

```bash
npm run test:lsp
```

LSP 只增加只读的 hover、definition、references 和 document symbols 查询；
协议 framing 由 `vscode-jsonrpc` 处理。服务器不可用时不注册对应工具，并继续使用
`search_text`、`read_file` 和 `run_tests`。完整实现与配置见
[第 22 章](../docs/chapters/22-lsp-optional-plugin.md)。

Headless 单次执行：

```bash
OPENAI_API_KEY=... node dist/cli/bin.js \
  --print "检查当前项目" \
  --provider openai \
  --model gpt-5.6-sol
```

从 stdin 读取多个版本化 JSONL 请求，并逐事件输出 JSONL：

```bash
node dist/cli/bin.js \
  --print \
  --input-format jsonl \
  --output-format jsonl \
  --provider openai \
  --model gpt-5.6-sol < requests.jsonl
```

Headless 退出码为：`0` 成功、`1` Provider/内部错误、`2` 输入/配置错误、
`3` 预算耗尽、`4` 权限拒绝、`130` 取消。stdout 只写所选协议，诊断写
stderr；需要交互确认的权限在 Headless 中安全拒绝。完整协议见
[第 18 章](../docs/chapters/18-headless-jsonl-protocol.md)。

交互模式（不会自动读取 `.env.local`）：

```bash
OPENAI_API_KEY=... node dist/cli/bin.js chat --provider openai --model gpt-5.6-sol
# 或
DEEPSEEK_API_KEY=... node dist/cli/bin.js chat --provider deepseek --model deepseek-v4-pro
```

也可以把 Provider 和模型集中写入 `~/.agent-code/config.json`：

```json
{
  "provider": "openai",
  "models": {
    "openai": "gpt-5.6-sol",
    "deepseek": "deepseek-v4-pro"
  },
  "trustedWorkspaces": ["/absolute/path/to/project"]
}
```

配置完成后可直接运行 `node dist/cli/bin.js chat`。

可在 user 配置或已信任项目的 `.agent-code/config.json` 中配置 stdio MCP
server、六类生命周期 Hook 和 Skills。MCP 工具继续经过统一权限检查；外部返回
内容会标记为不可信。Skill 只发布目录，正文通过 `load_skill` 按需读取，兄弟脚本
不会自动执行。完整配置和安全边界见
[第 19 章](../docs/chapters/19-mcp-hooks-skills.md)。

同一配置文件也可以按语言配置可选 LSP server：

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

语言服务器进程默认不会继承 Provider API key；项目配置仍需先通过 workspace trust。

OpenAI 官方当前建议复杂推理和编码任务使用 `gpt-5.6-sol`；`gpt-5.6`
是指向 Sol 的滚动别名。教程使用完整 model ID，便于明确记录 Session
实际选择的模型层级。

DeepSeek 官方将于 2026-07-24 15:59 UTC 停用旧的
`deepseek-chat` / `deepseek-reasoner` 模型名，因此教程当前版本统一使用
`deepseek-v4-pro`。Provider 类名中的 `Chat` 指 Chat Completions API，不是旧模型名。

优先级为 CLI、`AGENT_CODE_*` 环境变量、local、project、user、managed、默认值。project/local 仅在 workspace 已由 managed/user 配置显式信任后读取；项目 allow 不能覆盖 managed deny。完整字段和合并规则见[第 17 章](../docs/chapters/17-configuration-policy-hierarchy.md)。API key 仍只使用 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`，不会写入配置或 Session。

会话会默认保存到 `~/.agent-code/sessions`：

```bash
node dist/cli/bin.js --resume <session-id>
node dist/cli/bin.js --fork-session <session-id>
node dist/cli/bin.js session export <session-id>
```

可使用 `--session-dir <path>` 或 `AGENT_CODE_SESSION_DIR` 覆盖保存位置。Session 只记录 Provider/模型名称，不保存 API key。

上下文会加载 `~/.agent-code/AGENTS.md`、项目根 `AGENTS.md` 和当前活跃路径祖先目录中的嵌套 `AGENTS.md`。交互中使用 `/context` 查看基础提示、指令、工具 schema、摘要和近期对话的估算占用；压缩不会删除 Session 的完整历史。

显式使用 `.env.local` 运行真实 Provider 的完整 smoke test：

```bash
npm run test:mvp:live:local -- openai
npm run test:mvp:live:local -- deepseek
```
