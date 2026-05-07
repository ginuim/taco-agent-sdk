# taco-agent-sdk（TypeScript）中文说明

`taco-agent-sdk` 是从 `@codeany/open-agent-sdk` fork 并持续维护的版本。  
上游 `@codeany/open-agent-sdk` 目前已停止活跃维护。  
`taco-agent-sdk` 可嵌入应用进程内运行，不依赖 CLI 子进程。  
支持 Anthropic Messages API 和 OpenAI-compatible API。

## 安装

```bash
pnpm install taco-agent-sdk
```

设置 API Key：

```bash
export CODEANY_API_KEY=your-api-key
```

OpenAI 兼容模型可配置：

```bash
export CODEANY_API_TYPE=openai-completions
export CODEANY_API_KEY=sk-...
export CODEANY_BASE_URL=https://api.openai.com/v1
export CODEANY_MODEL=gpt-4o
```

## 快速开始

```typescript
import { query } from "taco-agent-sdk";

for await (const msg of query({
  prompt: "读取 package.json 并告诉我项目名",
  options: { allowedTools: ["Read", "Glob"] },
})) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if ("text" in block) console.log(block.text);
    }
  }
}
```

## 打字机流式输出（重点）

开启 `includePartialMessages: true` 后，你会收到 `partial_message` 增量事件，适合直接驱动前端“打字机”效果：

- 普通回答文本：`partial.type === "text"`，字段在 `partial.text`
- 工具写入内容增量（如 `Write`）：`partial.type === "tool_use"`，可通过 `partial.name === "Write"` 和 `partial.field === "content"` 判断，内容在 `partial.input`

```typescript
import { query } from "taco-agent-sdk";

for await (const msg of query({
  prompt: "把一篇很长的文档写到 ./report.md，并同步解释内容",
  options: {
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
  },
})) {
  if (msg.type === "partial_message") {
    if (msg.partial.type === "text") {
      // assistant 文本增量
      process.stdout.write(msg.partial.text || "");
    } else if (
      msg.partial.type === "tool_use" &&
      msg.partial.name === "Write" &&
      msg.partial.field === "content"
    ) {
      // Write.content 增量
      process.stdout.write(msg.partial.input || "");
    }
  }
}
```

## 常用 API

- `query({ prompt, options })`：一次性流式查询，返回 `AsyncGenerator<SDKMessage>`
- `createAgent(options)`：创建可复用 Agent，支持多轮对话和会话持久化
- `agent.prompt(text)`：阻塞式调用，返回汇总结果
- `agent.query(prompt)`：流式调用，返回事件流

## 常用配置项

- `apiType`：`anthropic-messages` / `openai-completions`
- `model`：模型名
- `apiKey` / `baseURL`：模型服务配置
- `allowedTools` / `disallowedTools`：工具白名单/黑名单
- `permissionMode`：权限模式；`plan` 只允许只读工具，`acceptEdits` 默认拒绝 `Bash`，`default` 需要显式 `canUseTool` 审批
- `canUseTool`：自定义工具审批回调，子 Agent 会继承父级审批逻辑
- `additionalDirectories`：除 `cwd` 外，允许文件工具访问的额外目录（支持绝对路径和 `~`，如 `~/.agents`）
- `sandbox.network.allowedDomains`：限制 `WebFetch` 可访问域名
- `sandbox.network.allowLocalBinding`：是否允许 `WebFetch` 访问本地/私网地址（默认 `false`）
- `maxTurns`：最大 agent 回合数
- `maxBudgetUsd`：预算上限
- `includePartialMessages`：是否输出 token 级增量事件（默认 `false`）

## 安全边界

内置文件工具会把路径规范化后限制在 `cwd` 和 `additionalDirectories` 内，防止 `../` 或绝对路径越界；`additionalDirectories` 支持绝对路径和 `~` 家目录写法。`WebFetch` 只允许 `http`/`https`，默认拒绝本地、私网和云元数据地址，并过滤敏感请求头；若本地调试需要，可显式设置 `sandbox.network.allowLocalBinding = true`。`Bash` 使用最小环境变量，非零退出码会作为工具错误返回。

## 说明

完整英文文档见 `README.md`，包含所有工具、skills、hooks、MCP 集成与示例。
