# 第 6 章：项目发现、读取、搜索和 Patch 编辑

上一章建立了 Tool Registry，但注册的仍是测试用工具。本章加入第一组真正接触用户项目的能力：`list_files`、`search_text`、`read_file` 和 `apply_patch`。

对应代码快照：`chapter-06`。

## 1. 本章要解决的不是四个 `fs` 调用

模型给出的路径、搜索词和 patch 都是不可信输入。直接执行 `readFile(join(root, input.path))` 至少会留下这些问题：

- `../`、绝对路径或符号链接可以逃出工作区。
- `.git`、依赖缓存和密钥文件会进入模型上下文。
- 二进制文件、超大文件或海量搜索结果会挤满内存和上下文。
- 用户在 Agent 读取后又修改了文件，Agent 的旧编辑会覆盖新内容。
- 直接写目标文件时，进程中断可能只留下半个文件。

因此本章的执行路径是：

```text
Tool Registry 校验 JSON
→ PathGuard 规范化路径并固定 workspace root
→ FilePolicy 判断元数据、依赖和敏感路径
→ realpath 检查已有目标
→ 文本/尺寸检查
→ 执行 list、search、read 或 checked patch
→ 工具主动分页
→ Registry 再做最终输出限制
```

这仍然只是文件工具边界，不是 OS sandbox。第 8 章才会把权限和沙箱接进执行路径。

## 2. 一次创建四个工具

文件工具共享同一个规范化后的工作区根目录和策略：

```ts
const fileTools = await createWorkspaceFileTools({
  workspaceRoot: process.cwd(),
  maxFileBytes: 1_048_576,
  maxSearchFiles: 10_000,
});

const registry = new ToolRegistry(fileTools);
const executor = registry.createExecutor();
```

`workspaceRoot` 在创建阶段经过一次 `realpath`，之后只读。工具参数中的路径一律使用相对于这个根目录的正斜杠路径。绝对路径、反斜杠、NUL 和解析后仍以 `../` 开头的路径都被拒绝。

查看 [`index.ts`](../../agent-code/src/tools/files/index.ts) 和 [`path-guard.ts`](../../agent-code/src/tools/files/path-guard.ts)。

## 3. realpath 与符号链接规则

只做词法检查不够：

```text
workspace/link -> /outside/secret.txt
```

`link` 看起来位于工作区，真正读取的文件却在外部。`resolveExisting()` 因此先做词法边界检查，再对目标调用 `realpath`，并再次确认结果仍在不可变根目录内。

解析后的真实相对路径还会重新经过 FilePolicy。否则下面这种别名可以绕过敏感文件规则：

```text
safe-name.txt -> .env.local
```

本章采用明确且偏保守的符号链接策略：

- 读：允许指向工作区内普通、非敏感目标的 symlink。
- 列表和递归搜索：显示 symlink，但不沿 symlink 递归。
- 写：路径中任意一层是 symlink 都拒绝。
- 指向工作区外的 symlink：拒绝。

写入拒绝 symlink 是为了避免 `rename` 的目标语义含糊，也减少检查后路径被替换的风险。PathGuard 不能消除所有本机并发进程制造的 TOCTOU 竞态；真正面对不可信工作区时仍需要 OS 沙箱或基于目录文件描述符的原语。

## 4. 独立的文件策略

路径在工作区内不代表它适合进入模型上下文。`WorkspaceFilePolicy` 分别处理三类默认保护对象：

| 类型 | 默认行为 | 示例 |
| --- | --- | --- |
| Git 元数据 | 拒绝直接访问，发现时跳过 | `.git/` |
| 依赖/缓存目录 | 拒绝直接访问，发现时跳过 | `node_modules/`、`.venv/`、`.yarn/` |
| 敏感文件 | 拒绝直接访问，发现时跳过 | `.env.local`、`.npmrc`、`*.pem`、`*.key` |

`.env.example`、`.env.sample` 和 `.env.template` 被视为模板，可以读取。依赖目录集合可以通过 `dependencyDirectories` 替换。

二进制与尺寸不是路径策略：它们在真正读取内容时单独检查。文本必须是不含 NUL 的合法 UTF-8，默认单文件上限为 1 MiB。这样“隐藏路径”“依赖噪声”“二进制内容”和“过大文本”不会被混成一个含糊的 ignore 规则。

查看 [`policy.ts`](../../agent-code/src/tools/files/policy.ts) 和 [`text.ts`](../../agent-code/src/tools/files/text.ts)。

## 5. `list_files`：先发现，不读取内容

调用示例：

```json
{
  "path": "src",
  "maxDepth": 4
}
```

结果按每层文件名稳定排序，目录以 `/` 结尾，symlink 标记为 `[symlink]`。它不会读取文件内容，也不会跟随目录 symlink。`maxDepth` 范围是 1–8；一次发现最多保留 20,000 个条目。

当输出超过本回合的 `maxOutputBytes` 时，工具按完整行分页并给出 opaque `nextCursor`。下一次调用必须保持相同的 `path` 和 `maxDepth`：

```json
{
  "path": "src",
  "maxDepth": 4,
  "cursor": "eyJ2ZXJzaW9uIjoxLC4uLn0"
}
```

cursor 是工具内部状态，不应由模型修改或解释。

## 6. `read_file`：viewport、hash 和稳定分页

调用：

```json
{
  "path": "src/main.ts",
  "maxLines": 200
}
```

返回内容把路径、整个文件的 SHA-256 和总行数放在模型可见的 header 中，然后提供带行号的 viewport：

```text
path: src/main.ts
sha256: sha256:7f2d...
lines: 37
     1 import { run } from "./run.js";
     2
     3 await run();
```

hash 必须基于原始字节，而不是规范化后的字符串，因此 UTF-8 BOM、CRLF 与 LF 的区别都能触发冲突。工具同时在本地 `data` 中返回 hash 和 viewport 范围。

`maxLines` 最大 400；普通长行会在 2,000 字符处明确标记裁剪。输出仍过大时使用 cursor 继续读取。cursor 绑定路径、hash 和 `maxLines`，文件发生变化后旧 cursor 会返回 `Invalid or stale cursor`，而不是把两个版本拼成一个 viewport。

空文件合法，返回 `lines: 0`。二进制、非法 UTF-8 和超过限制的文件会被明确拒绝。

## 7. `search_text`：有界的字面量搜索

第一版有意只提供字面量搜索，不在同一个参数里混入正则表达式语法：

```json
{
  "query": "createExecutor(",
  "path": "src",
  "caseSensitive": true
}
```

结果格式为：

```text
src/runtime/agent.ts:42:17: const tools = registry.createExecutor();
```

搜索复用同一目录和敏感文件策略，跳过 symlink、二进制、非法 UTF-8 与超大文件。默认最多选取 10,000 个文件和 20,000 个匹配，命中限制时会明确标记。结果按行分页；cursor 还绑定当前匹配集合的 hash，所以文件变化造成的结果变化会让旧 cursor 失效。

当前实现使用 Node 文件 API，便于完整展示边界语义。生产版本可将扫描器替换为 `rg`，但替换后仍要保留相同的 PathGuard、策略、取消、尺寸和结果信封契约，不能把 shell 转义当成路径安全。

## 8. 为什么没有 `create_file`

一个接受 `path + content` 的覆盖式工具很容易把“新建”悄悄变成“覆盖”。本章把三种写操作都放进 `apply_patch`，并要求每个调用只处理一个文件：

```text
*** Begin Patch
*** Add File: notes.txt
+first line
+second line
*** End Patch
```

新建时 `baseHash` 必须是 `null`，目标已存在则失败：

```json
{
  "baseHash": null,
  "patch": "*** Begin Patch\n*** Add File: notes.txt\n+first line\n*** End Patch"
}
```

每行前面的 `+` 是 patch 标记，不进入文件。非空新文件默认以 LF 结尾；空的 Add File body 创建真正的零字节文件。父目录必须已经存在，工具不会暗中创建目录树。

## 9. 带 base hash 的修改

修改前必须先调用 `read_file`，再把它返回的完整 hash 原样放入 `baseHash`：

```json
{
  "baseHash": "sha256:7f2d...",
  "patch": "*** Begin Patch\n*** Update File: src/main.ts\n@@ -1,3 +1,3 @@\n import { run } from \"./run.js\";\n \n-await run();\n+await run({ verbose: true });\n*** End Patch"
}
```

Update hunk 使用标准的行范围 header：

```text
@@ -oldStart,oldCount +newStart,newCount @@
 context
-removed
+added
```

解析器验证 hunk 的旧/新行数、顺序和原文件上下文。应用前验证一次 hash，临时文件写完并 `fsync` 后再验证一次，最后在同一目录中 `rename` 到目标。失败时清理临时文件。原文件的 UTF-8 BOM、LF/CRLF 风格、末尾换行状态和 Unix mode 会被保留。

hash 防止的是正常协作冲突：如果用户、编辑器或另一个 Agent 在读取后修改了文件，本次写入失败并要求重新读取。它不是恶意本机进程下的锁，也不是跨多个文件的事务。

## 10. 删除仍然是 checked patch

删除也必须携带当前 hash：

```json
{
  "baseHash": "sha256:7f2d...",
  "patch": "*** Begin Patch\n*** Delete File: notes.txt\n*** End Patch"
}
```

Delete body 不能包含 hunk。工具再次确认目标是工作区内、非 symlink、非敏感、未变化的 UTF-8 普通文件后才调用原子 `unlink`。第 9 章会在写入前增加 checkpoint，从而提供按回合恢复；本章本身不承诺撤销已成功的删除。

查看 [`patch.ts`](../../agent-code/src/tools/files/patch.ts)。

## 11. 测试策略

[`file-tools.test.ts`](../../agent-code/tests/unit/file-tools.test.ts) 使用真实临时目录覆盖：

- 稳定排序以及 `.git`、依赖目录、敏感文件排除。
- `../`、POSIX/Windows 绝对路径和工作区外 symlink。
- 指向敏感文件的内部 symlink 别名。
- 内部 symlink 可读但不可写。
- UTF-8、Unicode、空文件、二进制和超大文件。
- 字面量搜索、大小写规则和跳过计数。
- Add、Update、Delete 三种 patch。
- 读取后修改导致的 hash 冲突。
- hunk 上下文不匹配时保持原文件不变。
- 有界分页以及文件变化后的 cursor 失效。

这些测试通过正式 Tool Registry 执行，因此同时覆盖 schema、结果信封和 handler 失败不会击穿 Agent Loop 的行为。

## 12. 从第 5 章迁移

查看完整差异：

```bash
git diff chapter-05..chapter-06
```

新增结构：

```text
src/tools/files/
├── cursor.ts       # opaque cursor 与按 UTF-8 字节分页
├── index.ts        # 四个 Tool 定义及目录扫描
├── patch.ts        # checked patch、冲突检测和原子替换
├── path-guard.ts   # 不可变 root、realpath 和 symlink 规则
├── policy.ts       # Git、依赖和敏感文件策略
└── text.ts         # UTF-8、行结构和 SHA-256

tests/unit/
└── file-tools.test.ts
```

没有新增运行时依赖。

## 13. 完成检查

```bash
cd agent-code
npm run typecheck
npm test
npm run build
npm run test:e2e
```

本章只增加本地文件工具，不需要消耗 GPT 或 DeepSeek API，也不读取 `.env.local`。

本章 tag：

```bash
git tag -a chapter-06 -m "Chapter 06: add guarded workspace file tools"
```

## 14. 动手实验

先读取一个文件并保存 hash，然后在编辑器里修改它，再尝试使用旧 hash 应用 patch。确认工具拒绝覆盖，并且编辑器中的版本保持不变。

再创建一个指向工作区外文件的 symlink，分别用 `list_files` 和 `read_file` 观察：列表只标记链接，不读取目标；直接读取会在 `realpath` 边界处失败。

最后把 Registry 的 `maxOutputBytes` 临时调小，搜索一个常见词并沿 `nextCursor` 翻页。修改一个命中文件后重用旧 cursor，确认它因结果集合变化而失效。

## 15. 下一章留下的问题

Agent 现在可以检查并修改项目，但还不能运行构建或测试。下一章会实现一个可取消的 Shell 执行器，统一处理前台命令、后台 job、timeout、输出分页和进程树清理。
