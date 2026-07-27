# 第 11 章：扩展系统

> dugsyn 的扩展层提供 5 种可插拔能力：Hooks（生命周期钩子）、MCP（Model Context Protocol）、LSP（Language Server Protocol）、Skills（技能目录）和 Plugin（插件管理）。

---

## 1. 扩展体系

```mermaid
flowchart TB
    subgraph "Agent 运行时"
        AGENT["CodingAgentRuntime.runTurn()"]
    end

    subgraph "扩展钩子点"
        HOOK["Hooks<br/>PreToolUse / PostToolUse<br/>PostToolUseFailure<br/>PermissionRequest"]
        MCP["MCP<br/>外部工具服务器<br/>JSON-RPC 协议"]
        LSP["LSP<br/>诊断 / 补全 / 跳转<br/>语言服务器集成"]
        SKILLS["Skills<br/>指令 + 资源注入<br/>context 增强"]
        PLUGIN["Plugin<br/>打包的扩展单元<br/>含 manifest.json"]
    end

    AGENT -->|"工具调用前/后"| HOOK
    AGENT -->|"额外工具"| MCP
    AGENT -->|"编辑器能力"| LSP
    AGENT -->|"上下文预加载"| SKILLS
    PLUGIN --> HOOK
    PLUGIN --> MCP
    PLUGIN --> LSP
    PLUGIN --> SKILLS
```

---

## 2. Hooks — 生命周期钩子

```mermaid
flowchart LR
    subgraph "工具执行流程"
        PRE["① PreToolUse"] --> EXEC["② handler()"]
        EXEC -->|"成功"| POST["③ PostToolUse"]
        EXEC -->|"失败"| FAIL["④ PostToolUseFailure"]
    end

    subgraph "权限流程"
        PERM_REQ["PermissionRequest"] --> GATE["Hook 可拦截"]
    end
```

| Hook 事件 | 时机 | 可拦截? |
|-----------|------|---------|
| `PreToolUse` | 工具 handler 执行前 | 是（抛 HookBlockedError → permission_denied） |
| `PostToolUse` | 工具成功返回后 | 否（仅通知） |
| `PostToolUseFailure` | 工具失败后 | 否（仅通知） |
| `PermissionRequest` | 权限决策前 | 是（可追加 deny reason） |

配置方式：
```json
{
  "hooks": {
    "PreToolUse": ["node scripts/pre-tool-check.js"],
    "PostToolUse": ["python3 notify.py"]
  }
}
```

---

## 3. MCP — Model Context Protocol

```mermaid
flowchart TD
    MCP_CONFIG["配置: mcpServers<br/>{ name: { command, args, env? } }"] --> LAUNCH["启动 MCP 服务器进程<br/>JSON-RPC over stdio"]
    LAUNCH --> HANDSHAKE["initialize → capabilities 协商"]
    HANDSHAKE --> TOOLS["tools/list → 发现工具"]
    TOOLS --> REGISTER["注册为 dugsyn tool"]
    REGISTER --> CALL["tools/call → 远程调用"]
    CALL --> AGENT["回到 Agent loop"]
```

每个 MCP 服务器一个独立子进程，通过 JSON-RPC over stdio 通信。发现的工具自动注册到 ToolRegistry。

---

## 4. LSP — Language Server Protocol

```mermaid
flowchart TD
    LSP_CONFIG["配置: lspServers<br/>{ typescript: { command, args } }"] --> LAUNCH["启动 LSP 服务器进程"]
    LAUNCH --> INIT["initialize → textDocument/didOpen"]
    INIT --> DIAG["textDocument/diagnostic<br/>→ 诊断信息"]
    INIT --> COMPLETE["textDocument/completion<br/>→ 代码补全"]
    INIT --> DEFINITION["textDocument/definition<br/>→ 跳转定义"]
```

LSP 功能通过工具暴露给 Agent：`lsp_diagnostics`, `lsp_completion`, `lsp_definition`。

---

## 5. Skills — 技能目录

```mermaid
flowchart LR
    DIR["~/.dugsyn/skills/ 或<br/>配置的 userDirectory"] --> SCAN["扫描 SKILL.md 文件"]
    SCAN --> PARSE["解析 YAML frontmatter<br/>+ Markdown 内容"]
    PARSE --> CATALOG["SkillCatalog<br/>{ name, description, content }"]
    CATALOG --> RENDER["renderCatalog() → system message"]
    RENDER --> CTX["注入 context"]
```

Skills 是纯文本指令文件，在 context 准备阶段加载并注入 system prompt。不涉及代码执行。

---

## 6. Plugin — 打包扩展

```mermaid
flowchart TD
    PLUGIN_DIR[".codex-plugin/<name>/"] --> MANIFEST["plugin.json<br/>{ name, version, skills[], mcpServers[], hooks }"]
    MANIFEST --> VALIDATE["校验 + 注册"]
    VALIDATE --> LOAD["加载 skills / hooks / MCP servers"]
    LOAD --> POLICY["teamPolicy.plugins 过滤<br/>allowedIds / deniedCapabilities"]
```

Plugin 是打包了 skills + hooks + MCP servers 的扩展单元，受 teamPolicy 控制。组织策略可以限制哪些插件可用、哪些能力被禁用。

---

## 7. 扩展生命周期

```mermaid
stateDiagram-v2
    [*] --> Configured: 配置文件声明
    Configured --> Loaded: 启动时加载
    Loaded --> Active: 正常运行
    Active --> Failed: 错误/崩溃
    Failed --> Active: 自动重连 (MCP/LSP)
    Active --> Disabled: 策略禁用
    Disabled --> [*]
    Failed --> [*]
```

MCP 和 LSP 服务器在崩溃后自动尝试重连。Hook 脚本失败不影响工具执行（通知型 hook 静默忽略错误）。

---

## 8. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/extensions/hooks.ts` | Hook 系统 — gate / notify 模式 |
| `dugsyn/src/extensions/mcp.ts` | MCP 客户端 — 进程启动 + JSON-RPC |
| `dugsyn/src/extensions/lsp.ts` | LSP 客户端 — 诊断/补全/定义 |
| `dugsyn/src/extensions/skills.ts` | Skill 目录扫描 + 渲染 |
| `dugsyn/src/extensions/plugin.ts` | Plugin 管理 — 加载/校验/策略控制 |
