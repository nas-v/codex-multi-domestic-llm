import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const providersDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../config/providers");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => Number.isInteger(value) && value > 0;

function configError(message) {
  throw new Error(`Provider 配置错误: ${message}`);
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) configError(`${field} 必须是非空字符串`);
}

function assertStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    configError(`${field} 必须是${allowEmpty ? "" : "非空"}字符串数组`);
  }
  if (new Set(value).size !== value.length) configError(`${field} 不能包含重复项`);
}

function validateRequestConfig(request, field) {
  if (request === undefined) return;
  if (!isObject(request) || (request.maxOutputTokensField !== undefined && typeof request.maxOutputTokensField !== "string") || (request.extraBody !== undefined && !isObject(request.extraBody))) {
    configError(`${field} 格式无效`);
  }
  if (request.omitParameters !== undefined) assertStringArray(request.omitParameters, `${field}.omitParameters`);
}

function validateLimits(limits, field) {
  if (!isObject(limits)) configError(`${field} 必须是对象`);
  for (const name of ["contextChars", "timeoutMs"]) {
    if (!positiveInteger(limits[name])) configError(`${field}.${name} 必须是正整数`);
  }
  const policy = limits.outputTokens;
  if (!isObject(policy)) configError(`${field}.outputTokens 必须是对象`);
  for (const name of ["compact", "normal", "detailed", "minimum", "maximum"]) {
    if (!positiveInteger(policy[name])) configError(`${field}.outputTokens.${name} 必须是正整数`);
  }
  if (policy.minimum > policy.maximum) configError(`${field}.outputTokens.minimum 不能大于 maximum`);
  for (const mode of ["compact", "normal", "detailed"]) {
    if (policy[mode] < policy.minimum || policy[mode] > policy.maximum) {
      configError(`${field}.outputTokens.${mode} 必须在 minimum 和 maximum 之间`);
    }
  }
}

function mergeLimits(base, override = {}) {
  return {
    ...base,
    ...override,
    outputTokens: { ...base.outputTokens, ...(override.outputTokens || {}) }
  };
}

export function validateProviderDefinition(item) {
  if (!isObject(item)) configError("provider 必须是对象");
  if (!/^[a-z0-9_-]+$/i.test(item.id || "")) configError(`无效的 provider id: ${item.id}`);
  assertString(item.name, `${item.id}.name`);
  assertString(item.model, `${item.id}.model`);
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") configError(`${item.id}.enabled 必须是布尔值`);

  if (!isObject(item.endpoint) || item.endpoint.protocol !== "openai-chat-completions") {
    configError(`${item.id}.endpoint.protocol 当前只支持 openai-chat-completions`);
  }
  assertString(item.endpoint.baseUrl, `${item.id}.endpoint.baseUrl`);
  let url;
  try { url = new URL(item.endpoint.baseUrl); } catch { configError(`${item.id}.endpoint.baseUrl 不是合法 URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) configError(`${item.id}.endpoint.baseUrl 只允许 http/https`);

  if (!isObject(item.credentials)) configError(`${item.id}.credentials 必须是对象`);
  assertStringArray(item.credentials.envKeys, `${item.id}.credentials.envKeys`, { allowEmpty: false });
  if (item.credentials.envKeys.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    configError(`${item.id}.credentials.envKeys 必须是大写环境变量名`);
  }

  if (!isObject(item.capabilities) || Object.values(item.capabilities).some((value) => typeof value !== "boolean")) {
    configError(`${item.id}.capabilities 必须是布尔键值对象`);
  }
  validateLimits(item.limits, `${item.id}.limits`);

  if (!isObject(item.routing) || !positiveInteger(item.routing.priority)) configError(`${item.id}.routing 格式无效`);
  assertStringArray(item.routing.aliases, `${item.id}.routing.aliases`);
  assertStringArray(item.routing.keywords, `${item.id}.routing.keywords`);
  for (const pattern of item.routing.keywords) {
    try { new RegExp(pattern, "i"); } catch { configError(`${item.id}.routing.keywords 包含无效正则: ${pattern}`); }
  }

  if (item.headers !== undefined && (!isObject(item.headers) || Object.values(item.headers).some((value) => typeof value !== "string"))) {
    configError(`${item.id}.headers 必须是字符串键值对象`);
  }
  if (item.auth !== undefined && (!isObject(item.auth) || (item.auth.header !== undefined && typeof item.auth.header !== "string") || (item.auth.prefix !== undefined && typeof item.auth.prefix !== "string"))) {
    configError(`${item.id}.auth 格式无效`);
  }
  validateRequestConfig(item.request, `${item.id}.request`);
  if (item.modelProfiles !== undefined) {
    if (!isObject(item.modelProfiles) || Object.keys(item.modelProfiles).length === 0) configError(`${item.id}.modelProfiles 必须是非空对象`);
    if (!Object.hasOwn(item.modelProfiles, item.model)) configError(`${item.id}.modelProfiles 必须包含默认模型 ${item.model}`);
    for (const [model, profile] of Object.entries(item.modelProfiles)) {
      assertString(model, `${item.id}.modelProfiles 模型 ID`);
      if (!isObject(profile)) configError(`${item.id}.modelProfiles.${model} 必须是对象`);
      const unknownFields = Object.keys(profile).filter((field) => !["request", "capabilities", "limits"].includes(field));
      if (unknownFields.length) configError(`${item.id}.modelProfiles.${model} 包含未知字段: ${unknownFields.join(", ")}`);
      validateRequestConfig(profile.request, `${item.id}.modelProfiles.${model}.request`);
      if (profile.capabilities !== undefined && (!isObject(profile.capabilities) || Object.values(profile.capabilities).some((value) => typeof value !== "boolean"))) {
        configError(`${item.id}.modelProfiles.${model}.capabilities 必须是布尔键值对象`);
      }
      validateLimits(mergeLimits(item.limits, profile.limits), `${item.id}.modelProfiles.${model}.limits`);
    }
  }
  return item;
}

export function validateProvidersDocument(document) {
  if (!isObject(document) || !Array.isArray(document.providers) || document.providers.length === 0) {
    configError("providers 必须是非空数组");
  }
  const seenIds = new Set();
  const seenAliases = new Map();
  for (const item of document.providers) {
    validateProviderDefinition(item);
    if (seenIds.has(item.id)) configError(`重复的 provider id: ${item.id}`);
    seenIds.add(item.id);
    for (const alias of [item.id, item.name, ...item.routing.aliases]) {
      const normalized = alias.toLocaleLowerCase();
      const owner = seenAliases.get(normalized);
      if (owner && owner !== item.id) configError(`provider 别名冲突: ${alias} (${owner} / ${item.id})`);
      seenAliases.set(normalized, item.id);
    }
  }
  return document;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function loadDefinitions() {
  const files = readdirSync(providersDirectory).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) configError("config/providers 中没有 Provider 配置");
  const providers = files.map((name) => {
    try {
      return JSON.parse(readFileSync(resolve(providersDirectory, name), "utf8"));
    } catch (error) {
      configError(`${name} 无法解析: ${error.message}`);
    }
  });
  validateProvidersDocument({ providers });
  return providers;
}

export function buildProviderRuntimeConfig(item, environment = process.env) {
    const envPrefix = item.id.toUpperCase().replaceAll("-", "_");
    const model = environment[`${envPrefix}_MODEL`] || item.model;
    const profile = item.modelProfiles?.[model];
    if (item.modelProfiles && !profile) {
      configError(`${item.id} 模型 ${model} 没有声明 modelProfiles，拒绝沿用其他模型的请求参数`);
    }
    const limits = mergeLimits(item.limits, profile?.limits);
    const policy = limits.outputTokens;
    const baseRequest = item.request || {};
    const profileRequest = profile?.request || {};
    const request = {
      maxOutputTokensField: profileRequest.maxOutputTokensField || baseRequest.maxOutputTokensField || "max_tokens",
      extraBody: { ...(baseRequest.extraBody || {}), ...(profileRequest.extraBody || {}) },
      omitParameters: [...(profileRequest.omitParameters ?? baseRequest.omitParameters ?? [])]
    };
    return {
      id: item.id,
      label: item.name,
      protocol: item.endpoint.protocol,
      baseUrl: environment[`${envPrefix}_BASE_URL`] || item.endpoint.baseUrl,
      model,
      keyEnv: [...item.credentials.envKeys],
      aliases: [...new Set([item.id, item.name, ...item.routing.aliases])],
      capabilities: { reasoning: false, code: false, longContext: false, ...item.capabilities, ...(profile?.capabilities || {}) },
      outputPolicy: { ...policy },
      contextChars: limits.contextChars,
      defaultMaxOutputTokens: policy.compact,
      timeout: limits.timeoutMs,
      keywords: item.routing.keywords.map((word) => new RegExp(word, "i")),
      priority: item.routing.priority,
      auth: { header: item.auth?.header || "Authorization", prefix: item.auth?.prefix ?? "Bearer " },
      headers: { ...(item.headers || {}) },
      request
    };
}

function createSnapshot(definitions) {
  return definitions.filter((item) => item.enabled !== false).map((item) => {
    return buildProviderRuntimeConfig(item);
  }).sort((a, b) => a.priority - b.priority);
}

const definitions = deepFreeze(loadDefinitions());
const snapshot = deepFreeze(createSnapshot(definitions));
if (snapshot.length === 0) configError("至少需要一个启用的 provider");

export function listProviderDefinitions() { return definitions; }
export function listProviders() { return snapshot.map((config) => config.id); }
export function getProviderConfig(name) { return snapshot.find((config) => config.id === name) || null; }

export function resolveProviderAlias(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().toLocaleLowerCase();
  const matches = snapshot.filter((config) => config.aliases.some((alias) => alias.toLocaleLowerCase() === normalized));
  return matches.length === 1 ? matches[0].id : null;
}

export function resolveProviderOutputTokens(name, mode = "compact", requested) {
  const config = getProviderConfig(name);
  if (!config) return null;
  const policy = config.outputPolicy;
  if (Number.isFinite(requested) && requested > 0) return Math.min(Math.max(requested, policy.minimum), policy.maximum);
  return Math.min(Math.max(policy[mode] ?? policy.compact, policy.minimum), policy.maximum);
}

export function resolveProvider(provider, prompt = "") {
  if (provider && provider !== "auto") return provider;
  for (const config of snapshot) if (config.keywords.some((pattern) => pattern.test(prompt))) return config.id;
  return snapshot[0].id;
}

export function getProviderCandidates(provider, prompt = "") {
  const selected = resolveProvider(provider, prompt);
  if (provider && provider !== "auto") return [selected];
  return [selected, ...listProviders().filter((name) => name !== selected)];
}
