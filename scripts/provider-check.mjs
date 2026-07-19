import "dotenv/config";
import fetch from "node-fetch";
import { getProviderConfig, listProviders } from "../src/config.js";
import { routeModel } from "../src/router.js";

const args = process.argv.slice(2);
const provider = args.find((value) => !value.startsWith("--"));
const live = args.includes("--live");
if (!provider || !getProviderConfig(provider)) {
  console.error(`用法: npm run provider:check -- <provider> [--live]\n可用 Provider: ${listProviders().join(", ")}`);
  process.exitCode = 1;
} else {
  const config = getProviderConfig(provider);
  const apiKey = config.keyEnv.map((name) => process.env[name]).find(Boolean);
  if (!apiKey) {
    console.error(`缺少环境变量: ${config.keyEnv.join(" / ")}`);
    process.exitCode = 1;
  } else {
    const modelsUrl = new URL(config.baseUrl);
    modelsUrl.pathname = modelsUrl.pathname.replace(/\/chat\/completions\/?$/, "/models");
    const response = await fetch(modelsUrl, {
      headers: { ...config.headers, [config.auth.header]: `${config.auth.prefix}${apiKey}` }
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    const models = Array.isArray(data?.data) ? data.data.map(({ id }) => id).filter(Boolean) : [];
    const output = {
      ok: response.ok,
      provider,
      configuredModel: config.model,
      modelAvailable: models.length ? models.includes(config.model) : null,
      models,
      status: response.status,
      error: response.ok ? null : data?.error?.message || data?.message || `HTTP ${response.status}`
    };
    if (live && response.ok) {
      const result = await routeModel({
        provider,
        prompt: "只回复：Provider 连接正常",
        mode: "compact",
        maxOutputTokens: config.outputPolicy.minimum
      });
      output.live = {
        selectedProvider: result.selectedProvider,
        model: result.model,
        fallbackType: result.fallbackType,
        usage: result.usage,
        result: result.result
      };
    }
    console.log(JSON.stringify(output, null, 2));
    if (!response.ok || output.modelAvailable === false || output.live?.fallbackType === "local_fallback") process.exitCode = 1;
  }
}
