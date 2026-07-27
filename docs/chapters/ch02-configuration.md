# 第 2 章：配置体系

> dugsyn 的配置系统支持 4 层合并、Zod schema 校验、信任检查、环境变量覆盖和深度合并嵌套对象。

---

## 1. 配置加载流程

```mermaid
flowchart TD
    START(["loadConfiguration({ workspaceRoot, environment, paths })"]) --> RESOLVE["resolvePaths()<br/>→ managed / user / project / local 路径"]

    RESOLVE --> CANONICAL["canonicalDirectory(workspaceRoot)<br/>→ 解析所有路径为绝对真实路径"]
    CANONICAL --> LOAD_GLOBAL["load managed + user 文件"]
    LOAD_GLOBAL --> TRUST_ROOTS["canonicalTrustedRoots()"]
    TRUST_ROOTS --> TRUST["WorkspaceTrust.create()"]

    TRUST --> TRUSTED{"workspace 在 trustedRoots 中?"}
    TRUSTED -->|"是"| LOAD_PROJECT["load project + local 文件"]
    TRUSTED -->|"否"| SKIP["跳过 project 配置<br/>记录 skippedFiles"]

    LOAD_PROJECT --> MERGE["mergePreferences()"]
    SKIP --> MERGE
    MERGE --> ENV_OVERRIDE["parseEnvironment() → 覆盖"]
    ENV_OVERRIDE --> RULES["collectPermissionRules()"]
    RULES --> OUT(["LoadedConfiguration"])

    style TRUST fill:#fff3e0,stroke:#e65100
```

---

## 2. 四层配置

```mermaid
graph TB
    subgraph LAYERS["配置层 (后层覆盖前层)"]
        L1["① managed<br/>-- 组织级，唯一可设 teamPolicy<br/>DUGSYN_MANAGED_CONFIG"]
        L2["② user<br/>~/.dugsyn/config.json<br/>DUGSYN_USER_CONFIG"]
        L3["③ project<br/>&lt;workspace&gt;/.dugsyn/config.json<br/>-- 需信任 workspace"]
        L4["④ local<br/>&lt;workspace&gt;/.dugsyn/config.local.json<br/>-- 需信任 workspace"]
        L5["⑤ environment<br/>DUGSYN_PROVIDER / MODEL<br/>-- 最高优先级"]
    end

    L1 -->|"merge"| L2 -->|"merge"| L3 -->|"merge"| L4 -->|"merge"| L5
```

每层的 schema 通过 Zod 校验。不合法的配置直接抛 `ConfigurationError`，不会静默忽略。

---

## 3. 合并策略

```mermaid
flowchart LR
    BASE["base = {}"]
    BASE --> M1["models: { ...base, ...override }"]
    BASE --> M2["context / turn / permissions: 浅合并"]
    BASE --> M3["hooks: 按 event 名拼接命令数组"]
    BASE --> M4["teamPolicy: 深度合并 plugins + hosts"]
    BASE --> M5["trustedWorkspaces: 去重拼接"]
```

关键：**`trustedWorkspaces` 只在 managed 和 user 层设置**，project/local 层不允许声明（避免工作区自授权）。

---

## 4. 信任模型

```mermaid
flowchart TD
    W["workspaceRoot: /home/user/project"] --> C["canonicalDirectory → realpath"]
    T["trustedRoots: ['/home/user/project', '/home/user/work']"] --> C2["逐个 canonicalDirectory"]
    C --> MATCH{"workspaceRoot ∈ trustedRoots?"}
    C2 --> MATCH

    MATCH -->|"是"| ENABLED["trusted = true<br/>projectFeature('config') → enabled"]
    MATCH -->|"否"| DISABLED["trusted = false<br/>projectFeature('config') → disabled"]

    style ENABLED fill:#c8e6c9
    style DISABLED fill:#ffcdd2
```

`WorkspaceTrust` 使用 realpath，所以 symlink 别名无法绕过信任检查。

---

## 5. Schema 结构（关键字段）

```typescript
// configurationSchema (Zod)
{
  provider: z.enum(["openai", "deepseek"]).optional(),
  models: z.object({ openai: z.string().optional(), deepseek: z.string().optional() }).optional(),
  sessionDirectory: z.string().optional(),
  trustedWorkspaces: z.array(z.string()).optional(),
  context: z.object({ maxTokens: z.number().positive().optional() }).optional(),
  instructions: z.object({ userPath: z.string().optional() }).optional(),
  turn: z.object({ maxSteps: ..., maxDurationMs: ..., maxInputTokens: ..., maxOutputTokens: ... }).optional(),
  permissions: z.object({ defaultDecision: ..., rules: z.array(PermissionRule) }).optional(),
  mcpServers: z.record(z.string(), z.object({ command: ..., args: ... })).optional(),
  lspServers: z.record(z.string(), z.object({ command: ... })).optional(),
  hooks: z.record(z.enum(["PreToolUse", "PostToolUse", ...]), z.array(z.string())).optional(),
  skills: z.object({ userDirectory: ... }).optional(),
  teamPolicy: z.object({ plugins: ..., hosts: ..., audit: ... }).optional(),
}
```

---

## 6. 安全检查

| 检查 | 说明 |
|------|------|
| 路径规范 | `resolvePaths` 确保所有路径在 workspace 内 |
| JSON 解析 | `JSON.parse` 失败 → `ConfigurationError` |
| Schema 校验 | Zod `safeParse` 失败 → 详细路径错误 |
| 层限制 | project/local 禁止设 `teamPolicy` / `trustedWorkspaces` |
| Symlink 保护 | `realpath` 解析 + `isWithin` 检查 |

---

## 7. 文件清单

| 文件 | 说明 |
|------|------|
| `dugsyn/src/config/schema.ts` | Zod schema 定义 + 类型导出 |
| `dugsyn/src/config/loader.ts` | 核心加载、合并、校验逻辑 |
| `dugsyn/src/security/trust.ts` | WorkspaceTrust 信任检查 |
| `dugsyn/src/security/team-policy.ts` | 组织策略强制执行 |

---

## 8. 还不做什么

- 不热加载配置文件（运行时修改不生效）
- 不提供 `dugsyn config` 管理命令
- 不存在 encrypted / secrets 配置机制
