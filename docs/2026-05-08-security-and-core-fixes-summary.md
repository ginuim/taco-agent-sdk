# 2026-05-08 修补总结（安全与核心逻辑）

## 1) 安全基线修补

- **文件路径边界**：新增 `src/utils/path.ts`，统一做路径规范化与目录边界校验；`Read`/`Write`/`Edit`/`Glob`/`LSP` 全部接入，阻断 `../` 和绝对路径越界访问。
- **WebFetch SSRF 防护**：`src/tools/web-fetch.ts` 增加 URL 校验，仅允许 `http/https`；默认拒绝本地与私网地址（含云元数据常见地址）；支持 `sandbox.network.allowedDomains` 域名白名单约束；过滤敏感请求头（如 `authorization`/`cookie`）。
- **命令执行安全收敛**：
  - `src/tools/lsp-tool.ts`：将字符串拼接执行改为参数数组调用，避免注入。
  - `src/tools/worktree-tools.ts`：改为参数化执行并增加分支名校验，减少命令注入面。
  - `src/tools/glob.ts`：fallback 执行改为环境变量传参，避免 pattern 注入。
- **子 Agent 权限继承**：`src/tools/agent-tool.ts` 不再默认 `allow`；改为继承父级 `canUseTool`，堵上子 Agent 绕过权限通道。
- **Bash 结果语义修正**：`src/tools/bash.ts` 非零退出码会标记 `is_error: true`，并收敛运行环境变量；Abort 时尝试终止进程组。

## 2) 核心逻辑修补

- **Engine 工具循环 bug**：`src/engine.ts` 修复“工具执行后遇到 `end_turn` 提前退出”的逻辑，确保工具结果能被模型继续消费。
- **流式输出打通（打字机体验）**：
  - `src/providers/types.ts` 新增标准化流事件定义（`text_delta`、`tool_use_start`、`tool_input_delta`、`message`）并扩展 provider 接口；
  - `src/providers/anthropic.ts` 与 `src/providers/openai.ts` 增加 `createMessageStream()`，支持真实增量输出；
  - `src/engine.ts` 在 `includePartialMessages=true` 时优先消费流式事件并产出 `partial_message`。
- **Write 大内容可见性修补**：
  - `src/engine.ts` 新增对工具流参数的增量解析：从 `Write` 的输入 JSON 中提取 `content` 字段增量；
  - 向上游 UI 发出 `partial_message`（`partial.type: 'tool_use'`, `name: 'Write'`, `field: 'content'`），避免“长时间无输出”的假死体验；
  - 历史消息仍保留最终完整 `assistant`/`tool_use` 结构，兼容原有会话与工具执行链路。
- **Agent 并发与关闭行为**：`src/agent.ts`
  - 增加单实例并发保护，阻止同一 `Agent` 上并发 `query()` 互相覆盖状态；
  - `close()` 会主动中止运行中查询，避免关闭连接后请求还在跑；
  - 移除对内部状态的脆弱写法，改为直接注入历史消息。
- **权限模式行为落地**：`src/agent.ts` 中默认 `canUseTool` 不再“所有模式全放行”：
  - `plan` 仅允许只读工具；
  - `acceptEdits` 默认拒绝 `Bash`（要求显式审批）；
  - `default` 若未提供审批回调则拒绝，避免伪权限。

## 3) 健壮性与估算修补

- **重试可中断**：`src/utils/retry.ts` 的退避等待支持 `AbortSignal`，避免 sleep 期间无法取消。
- **Prompt 过长判定收紧**：移除过宽泛 `max_tokens` 触发条件，避免参数错误被误判成需要 compact。
- **Token/费用估算修复**：`src/utils/tokens.ts`
  - 增强 CJK 文本估算，降低中文低估问题；
  - 修复模型定价的 substring 误匹配（如 `gpt-4o-mini` 命中 `gpt-4o`）；
  - 计费纳入 cache token（`cache_creation_input_tokens`/`cache_read_input_tokens`）。

## 4) 测试与文档

- **新增回归测试**：`test/security-regression.test.ts`，覆盖关键问题（路径越界、SSRF、Bash 非零错误、Engine 工具循环、retry abort、tokens 估算与定价匹配）。
- **新增流式行为测试**：`test/streaming.test.ts`，覆盖：
  - 文本 `text_delta` -> `partial_message(type='text')`；
  - `Write.content` 参数增量 -> `partial_message(type='tool_use', field='content')`。
- **测试脚本更新**：`package.json`
  - `test` 改为运行 `test/*.test.ts`；
  - 增加 `test:examples` 保留示例入口；
  - `test:all` 统一走 `pnpm exec tsx`。
- **README 同步**：
  - `README.md` 与 `README.zh-CN.md` 已同步更新安全边界、流式输出能力和 `includePartialMessages` 配置说明（符合仓库 `AGENTS.md` 规则）。

## 5) 本次修改涉及的主要文件

- 核心：`src/agent.ts`、`src/engine.ts`、`src/types.ts`
- Provider：`src/providers/types.ts`、`src/providers/anthropic.ts`、`src/providers/openai.ts`、`src/providers/index.ts`
- 工具：`src/tools/read.ts`、`src/tools/write.ts`、`src/tools/edit.ts`、`src/tools/glob.ts`、`src/tools/lsp-tool.ts`、`src/tools/web-fetch.ts`、`src/tools/bash.ts`、`src/tools/worktree-tools.ts`、`src/tools/agent-tool.ts`
- 工具函数：`src/utils/path.ts`、`src/utils/retry.ts`、`src/utils/tokens.ts`
- 测试与文档：`test/security-regression.test.ts`、`test/streaming.test.ts`、`package.json`、`README.md`、`README.zh-CN.md`
