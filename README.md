# codex-multi-domestic-llm

一个安全、可扩展的本地 MCP 路由器。Codex 始终使用自身主模型；仅当你显式调用 `@smart_ask` 时，路由器才会请求 `config/providers/*.json` 中配置的外部模型。

## 配置模型

每个 Provider 独立保存在 `config/providers/<id>.json`，并由统一 Registry 自动发现。新增兼容模型只需新增一个配置文件：

```json
{
  "id": "my-model",
  "name": "My Model",
  "enabled": true,
  "endpoint": {
    "protocol": "openai-chat-completions",
    "baseUrl": "https://example.com/v1/chat/completions"
  },
  "model": "model-id",
  "credentials": { "envKeys": ["MY_MODEL_API_KEY"] },
  "capabilities": { "reasoning": false, "code": true, "longContext": true },
  "limits": {
    "contextChars": 24000,
    "timeoutMs": 45000,
    "outputTokens": { "compact": 512, "normal": 1024, "detailed": 2048, "minimum": 256, "maximum": 4096 }
  },
  "routing": { "aliases": ["模型别名"], "keywords": ["代码", "测试"], "priority": 30 }
}
```

在项目 `.env` 中设置 `MY_MODEL_API_KEY=...`（可从自动生成的 `.env.example` 开始）。密钥不会写进 Provider 配置或 Codex 配置，且 `.env` 已被 Git 忽略。`credentials.envKeys` 可以声明多个兼容变量名。`routing.priority` 越小，`provider=auto` 的默认优先级越高；`routing.keywords` 命中时优先选择该模型。

服务启动时会根据 `config/provider.schema.json` 的契约校验 URL、环境变量名、别名冲突、正则、认证头、超时、优先级和输出策略，并构建不可变配置快照。配置错误会直接阻止启动。当前稳定版不热加载配置；修改 Provider 文件或模型/端点环境变量后需要重启服务。

可选的 `auth`、`headers` 和 `request` 字段用于不同厂商的常见差异：认证头名称/前缀、固定请求头、输出 token 字段名、固定请求体和需要省略的参数。例如千帆已作为 `qianfan` 预置；Kimi 已作为 `kimi` 预置，默认使用当前账户可用的 `kimi-k2.6`，通过 `thinking.type=disabled` 避免简单请求消耗推理预算，并省略其固定且不建议显式传入的 `temperature`。对于非 Chat Completions 协议的服务，需要新增一个小适配器，而不是把密钥或厂商逻辑散落到路由器中。

Provider 清单与真实联调状态见 [PROVIDER_CATALOG.md](./PROVIDER_CATALOG.md)。配置维护命令：

```bash
npm run provider:validate
npm run provider:docs
npm run provider:check -- kimi
```

`provider:check` 默认只查询账户可见模型；增加 `--live` 才会产生一次真实模型调用。

同一 Provider 下模型参数不一致时，使用 `modelProfiles` 声明请求差异。运行时可以在 `.env` 中设置 `<PROVIDER>_MODEL` 选择已声明的 Profile，例如：

```dotenv
KIMI_MODEL=kimi-k2.7-code
```

Registry 会自动切换模型对应的请求契约。若模型没有对应 Profile，服务会拒绝启动，避免沿用其他模型的 `thinking`、token 字段或固定参数。

## 部署与使用

```bash
npm run codex:install
npm run health
```

完全重启 Codex 后使用：

```text
@smart_ask 请总结这份文档
@smart_ask 使用 deepseek 优化这段代码
```

`provider=auto` 时，`smart_ask` 会按候选顺序尝试已配置模型，全部失败时返回本地兜底文本。明确指定 provider 时只调用该模型，不会静默回退到其他模型。Codex 主模型不受影响。

本地测试：

```bash
npm test
npm run ask -- --provider my-model "你好"
npm run ask -- --provider zhipu --json "你好"
npm run ask -- --provider kimi --json "只回复：Kimi 连接正常"
npm run api
```

`npm test` 不会调用真实付费 API。多数 HTTP 测试直接调用 handler；Slowloris 防护测试会短暂监听本地回环端口。测试通过依赖注入覆盖 MCP `structuredContent`/`outputSchema`、错误分类、Provider 回退和配置策略。

默认命令只输出模型正文；增加 `--json` 后会同时显示机器可读的调用元数据，包括 `requestId`、实际 provider/model、每次尝试和回退类型。

结构化元数据的 `usage` 会在上游提供统计时返回 `promptTokens`、`cachedPromptTokens`、`completionTokens`、`reasoningTokens`、`totalTokens` 和 `cacheHitRate`。`cacheHitRate` 按缓存输入 token 除以总输入 token 计算；若厂商未提供输入 token 或缓存字段，该值为 `null`，不代表 0% 命中。

`$smart-ask` 遇到长报告时采用“规划、分节、Codex 本地汇总”。各章节复用相同 provider/model 和稳定共享前缀，默认先完成第一节再顺序执行后续章节，以提高厂商前缀缓存命中并避免一次长调用失败导致全文丢失。项目不持久化模型正文，也不进行未经授权的跨任务语义缓存。

长报告的规划和章节可通过工具参数 `reportId`、`sectionId`、`stage` 关联。`stage` 支持 `plan`、`section`、`single`；章节调用必须同时提供 `reportId` 和 `sectionId`。这些字段只进入结构化元数据和日志，不进入上游 prompt，因此不会破坏缓存前缀。

`stage=section` 时，路由器使用 `reportId + sectionId + provider + model` 生成稳定的 `idempotencyKey`。同一进程内，相同章节的并发请求会合并为一次上游调用，成功结果会在最多 128 个条目、30 分钟 TTL 的内存仓库中短期复用；正文不会写入磁盘。结构化元数据中的 `idempotencyStatus` 分别为 `executed`、`joined` 或 `reused`。`joined`/`reused` 的本次增量 usage 为 0，实际 token 只归入执行上游调用的一次记录。

相同幂等键若使用了不同 prompt、mode、temperature 或输出预算，会返回 `IDEMPOTENCY_CONFLICT/409`，避免误用旧章节；修改章节内容时应更换 `sectionId`。失败和无人等待的中断调用不会缓存，使用相同参数重新提交即可恢复。Provider 内部只重试 `TIMEOUT`、`NETWORK_ERROR`、`RATE_LIMIT` 和可重试的 5xx 错误，最多调用 3 次，前两次失败后分别退避 1 秒和 2 秒；鉴权、额度、模型、输入及幂等冲突不会重试。`provider=auto` 的跨 Provider failover 仍与单 Provider 重试分开处理。

进程重启后可用 `npm run report:usage -- <reportId>` 查看成功、失败和未完成章节；恢复时保留当前任务中已经取得的成功正文，只重新提交失败或未完成章节。由于项目不持久化模型正文，如果成功正文也已丢失，只能重新调用该章节，不能从日志还原答案。

完成或中断一份长报告后，可从当前日志及最多 5 份轮转日志聚合章节状态和 token 成本：

```bash
npm run report:usage -- <reportId>
```

输出包含 `success`、`partial_success`、`failed` 或 `not_found` 状态，各章节错误码以及汇总 usage。只有明确返回缓存统计的调用参与缓存命中率分母；不可观测调用仍计入总 prompt token，但不会把命中率错误稀释为 0%。

HTTP 服务启动后可用以下命令验证智谱，并在返回 JSON 中确认实际 provider：

HTTP POST 接口只接受 `application/json`，请求体默认上限 1MB、读取超时 10 秒；上游响应默认上限 4MB。单次路由总 deadline 为 55 秒，并会把 HTTP/MCP 客户端取消信号传递给上游请求和重试等待。

```bash
curl -s http://127.0.0.1:8000/ask \
  -H 'Content-Type: application/json' \
  -d '{"provider":"zhipu","prompt":"只回复：智谱连接正常","maxOutputTokens":768}'
```

实时查看调用日志：

```bash
tail -f ~/.codex/llm-mcp.log
```

日志默认在 10MB 时轮转，保留 5 份备份，并递归脱敏鉴权头、API Key、token、cookie、secret 和 password。可通过环境变量调整：

```dotenv
LLM_MCP_LOG_MAX_BYTES=10485760
LLM_MCP_LOG_BACKUPS=5
```

日志目录或文件不可写时，服务会降级到 stderr，并且只输出一次降级警告，不中断模型调用。

MCP 的 `smart_ask` 保持 `content` 为纯文本，并通过 `structuredContent` 返回调用元数据。`fallbackType` 有三种值：`none`、`provider_failover`、`local_fallback`。HTTP 接口返回相同的 `requestId`、`attempts` 和回退语义，同时暂时保留旧版 `fallback` 与 `output_tokens` 字段。

### HTTP 兼容字段废弃计划

- `fallback` 已由 `fallbackType` 取代；`output_tokens` 已由 `outputTokens` 取代。
- 1.x：继续返回旧字段，文档与新代码只使用新字段。
- 发布 2.0 前：在变更日志中再次提示，并提供至少一个小版本的迁移窗口。
- 2.0：移除 `fallback` 与 `output_tokens`。MCP `structuredContent` 不受影响。

HTTP 启动时会捕获 `EADDRINUSE`、`EACCES` 和 `EPERM`，输出 `PORT_IN_USE` 或 `PORT_PERMISSION_DENIED` 并使用退出码 1 结束，不再抛出未处理异常堆栈。

失败尝试会在 `attempts` 中包含稳定的 `errorCode`、HTTP 风格的 `statusCode` 和 `retryable`。输入或 provider 无效时，MCP 返回 `isError: true` 和结构化错误；HTTP 返回对应状态码与相同错误载荷。当前错误码包括：

| 错误码 | 含义 |
| --- | --- |
| `INVALID_INPUT` / `INVALID_PROVIDER` | 输入或 provider 无效 |
| `IDEMPOTENCY_CONFLICT` | 相同报告章节使用了不同的请求内容 |
| `INVALID_JSON` / `INVALID_PARAMETER` | JSON 或参数格式无效 |
| `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | HTTP 请求体过大或 Content-Type 不支持 |
| `CONFIG_ERROR` | 本地 provider 配置或密钥缺失 |
| `AUTH_FAILED` | 上游鉴权失败 |
| `QUOTA_EXCEEDED` | 余额或配额不足 |
| `RATE_LIMIT` | 上游限流 |
| `MODEL_NOT_FOUND` | 上游模型不存在 |
| `EMPTY_RESPONSE` | 上游未返回可读取文本 |
| `TIMEOUT` / `NETWORK_ERROR` | 超时或网络错误 |
| `UPSTREAM_ERROR` | 其他上游错误 |
| `UPSTREAM_RESPONSE_TOO_LARGE` | 上游响应超过安全大小限制 |

移除 MCP 注册：`npm run codex:remove`。
