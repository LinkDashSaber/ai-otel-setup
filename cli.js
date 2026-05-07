#!/usr/bin/env node
/**
 * ai-otel-installer
 *
 * 一行命令配置 Claude Code OTel 上报：
 *   npx -y ai-otel-installer url=COLLECTOR_HOST
 *
 * 兼容写法：参数也可以全部塞在一个 argv 里，用逗号分隔：
 *   npx -y cc-otel-installer url=COLLECTOR_HOST
 *
 * 该 installer **不走 CC plugin 机制**：直接把 hook 脚本铺到
 * ~/.claude/cc-otel/，并把 12 个 OTel env + SessionStart hook 注入
 * 用户的 ~/.claude/settings.json。安装后 `claude` 立即生效，无需 /plugin install。
 *
 * 关键约束：
 *   - 失败时尽量给出可操作信息，不静默
 *   - settings.json 写之前会备份到 settings.json.bak（每次覆盖，仅保留上一份）
 *   - 多次运行幂等（按 hook id=team:session-start 去重）
 *   - 不依赖任何运行时第三方包，只用 Node 标准库
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REQUIRED_KEYS = ["url"];
const HOOK_ID = "team:session-start";
// UserPromptSubmit 兜底 hook：复用同一脚本，靠 stdin.hook_event_name 分流；
// 单独 id 是为了让 settings.json 的 SessionStart / UserPromptSubmit 数组各自能按 id 去重
const PROMPT_HOOK_ID = "team:user-prompt-submit";
const OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRICS_INCLUDE_VERSION",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES",
];

// ---------- argv 解析 ----------

function parseArgs(argv) {
  const out = {};
  const flat = [];
  for (const a of argv) {
    // 兼容 url=x 单 argv 与 url=x 多 argv（保留逗号分隔，便于未来扩展）
    for (const part of a.split(",")) {
      if (part.trim()) flat.push(part.trim());
    }
  }
  for (const part of flat) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function validateArgs(args) {
  const errs = [];
  for (const k of REQUIRED_KEYS) {
    if (!args[k]) {
      errs.push(`missing required: ${k}`);
      continue;
    }
    if (/\s/.test(args[k])) errs.push(`${k} 不允许包含空格: "${args[k]}"`);
    if (args[k].includes(",")) errs.push(`${k} 不允许包含逗号: "${args[k]}"`);
  }
  return errs;
}

// ---------- url → endpoint ----------

function resolveEndpoint(rawUrl) {
  // 用户传裸 IP 或 host：自动补 http:// 和 :4317（gRPC 默认端口）
  // 用户传完整 URL：直接采用
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  // 如果用户已带端口（如 "1.2.3.4:4317"），保留；否则补默认 4317
  const hasPort = /:\d+$/.test(rawUrl);
  return `http://${rawUrl}${hasPort ? "" : ":4317"}`;
}

function extractHost(endpoint) {
  // 从已 resolve 的 endpoint 取 host（不带端口），用于 NO_PROXY
  try {
    return new URL(endpoint).hostname;
  } catch (_) {
    return endpoint.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  }
}

function mergeNoProxy(existing, host) {
  // 合并保留用户已有 NO_PROXY 值，仅追加 collector host，去重保序
  const list = (existing || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (host && !list.includes(host)) list.push(host);
  return list.join(",");
}

// ---------- 文件操作 ----------

function readJSONSafe(p) {
  try {
    if (!fs.existsSync(p)) return {};
    const txt = fs.readFileSync(p, "utf8");
    if (!txt.trim()) return {};
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`读取 ${p} 失败：${e.message}`);
  }
}

function writeJSONAtomic(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const bak = `${p}.bak`;
  fs.copyFileSync(p, bak);
  return bak;
}

// ---------- 合并逻辑 ----------

function buildEnv(template, args, endpoint) {
  const env = { ...template.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  // OTEL_RESOURCE_ATTRIBUTES 已废弃：bg/dept/team 不再上报
  delete env.OTEL_RESOURCE_ATTRIBUTES;
  return env;
}

function mergeSettings(existing, newEnv, hookEntry, promptHookEntry, collectorHost) {
  const merged = { ...existing };

  // env：plugin 优先（组织规范不允许个人改红线），但保留用户独有的 env
  merged.env = { ...(existing.env || {}) };
  for (const k of OTEL_KEYS) {
    merged.env[k] = newEnv[k];
  }
  // 清理历史遗留：旧版本 installer 写过 OTEL_RESOURCE_ATTRIBUTES，删掉
  delete merged.env.OTEL_RESOURCE_ATTRIBUTES;

  // 兜底用户写坏的 HTTP(S)_PROXY：把 collector host 加进 NO_PROXY，让 OTel gRPC 绕过代理
  // 仅追加，不动用户原有的 NO_PROXY 值，也不动 HTTP_PROXY / HTTPS_PROXY
  if (collectorHost) {
    merged.env.NO_PROXY = mergeNoProxy(merged.env.NO_PROXY, collectorHost);
    merged.env.no_proxy = mergeNoProxy(merged.env.no_proxy, collectorHost);
  }

  merged.hooks = { ...(existing.hooks || {}) };

  // hooks.SessionStart：按 id 去重，存在则覆盖，不存在则追加
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
  if (idx >= 0) sessionStart[idx] = hookEntry;
  else sessionStart.push(hookEntry);
  merged.hooks.SessionStart = sessionStart;

  // hooks.UserPromptSubmit：兜底 hook，按 PROMPT_HOOK_ID 去重，规则同上
  if (promptHookEntry) {
    const userPromptSubmit = Array.isArray(merged.hooks.UserPromptSubmit)
      ? [...merged.hooks.UserPromptSubmit]
      : [];
    const pidx = userPromptSubmit.findIndex((h) => h && h.id === PROMPT_HOOK_ID);
    if (pidx >= 0) userPromptSubmit[pidx] = promptHookEntry;
    else userPromptSubmit.push(promptHookEntry);
    merged.hooks.UserPromptSubmit = userPromptSubmit;
  }

  return merged;
}

function logsEndpointFromGrpc(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.port === "4317") url.port = "4318";
    if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
    return url.toString();
  } catch (_) {
    return "http://localhost:4318/v1/logs";
  }
}

// ---------- Codex config.toml 处理 ----------
//
// 真实 schema（参见 https://developers.openai.com/codex/config-reference 与 /codex/hooks）：
//
//   [features]
//   codex_hooks = true                          ← 没这个 flag，整段 hooks 被忽略
//
//   [otel]
//   exporter = "otlp-grpc"                      ← 用 exporter 选 transport，不是 enabled / protocol
//   metrics_exporter = "otlp-grpc"
//   trace_exporter = "otlp-grpc"
//
//   [otel.exporter.otlp-grpc]                   ← 端点写在嵌套子表里
//   endpoint = "http://host:4317"
//
//   [[hooks.SessionStart]]                      ← codex 真的有 SessionStart
//   matcher = "startup|resume"
//   [[hooks.SessionStart.hooks]]                ← 真正的 command 嵌一层
//   type = "command"
//   command = "..."
//
// 嵌套子表 + 嵌套数组用 hand-rolled 正则维护太脆，改成"managed 块"风格：
// 用 BEGIN/END 标记夹住整段我们写的内容，重跑 installer 时整块剥离再追加。

const CODEX_MANAGED_BEGIN = "# >>> ai-otel-installer managed >>>";
const CODEX_MANAGED_END = "# <<< ai-otel-installer managed <<<";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCodexManagedBlock(text) {
  const re = new RegExp(
    `\\n?${escapeRegex(CODEX_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegex(CODEX_MANAGED_END)}\\n?`,
    "g"
  );
  return text.replace(re, "\n");
}

function stripLegacyCodexOtel(text) {
  // 旧 installer 写的 [otel]（含非法 key enabled = true）整段删除，避免与新 [otel] 冲突
  return text.replace(
    /(?:\n|^)\[otel\][\s\S]*?(?=\n\[|\n\[\[|$)/g,
    (m) => (/enabled\s*=\s*true/.test(m) ? "" : m)
  );
}

function stripLegacyCodexHook(text) {
  // 旧 installer 写的 [[hooks.UserPromptSubmit]] + id = "team:session-start" 整块删除
  return text.replace(
    /(?:\n|^)\[\[hooks\.UserPromptSubmit\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g,
    (m) => (/id\s*=\s*["']team:session-start["']/.test(m) ? "" : m)
  );
}

function buildCodexManagedBlock(endpoint, hookDest, logsEndpoint) {
  // exporter / trace_exporter / metrics_exporter 是 externally-tagged enum：
  //   - 写 scalar `exporter = "otlp-grpc"`：codex 解析为 unit variant，因为
  //     OtlpGrpc 是 struct variant（带 endpoint 等字段），报
  //     "invalid type: unit variant, expected struct variant"。
  //   - 同时写 scalar 和 table：报 "cannot extend value of type string"。
  //   - 只写 table `[otel.exporter."otlp-grpc"]`：✓ codex 把它解析为
  //     OtlpGrpc { endpoint }，tag 来自 key 名。
  // 官方 sample 之所以能 `exporter = "none"`，是因为 None 本身就是 unit variant。
  return [
    CODEX_MANAGED_BEGIN,
    "[features]",
    "codex_hooks = true",
    "",
    "[otel]",
    'environment = "prod"',
    "log_user_prompt = false",
    "",
    '[otel.exporter."otlp-grpc"]',
    `endpoint = ${JSON.stringify(endpoint)}`,
    "",
    '[otel.trace_exporter."otlp-grpc"]',
    `endpoint = ${JSON.stringify(endpoint)}`,
    "",
    '[otel.metrics_exporter."otlp-grpc"]',
    `endpoint = ${JSON.stringify(endpoint)}`,
    "",
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(`AI_OTEL_LOGS_ENDPOINT=${logsEndpoint} node "${hookDest}"`)}`,
    CODEX_MANAGED_END,
  ].join("\n");
}

function installCodex(home, endpoint) {
  const codexDir = path.join(home, ".codex");
  if (!fs.existsSync(codexDir)) {
    return { tool: "codex", status: "skipped", reason: "未检测到 ~/.codex" };
  }
  const installDir = path.join(codexDir, "ai-otel");
  const configPath = path.join(codexDir, "config.toml");
  const hookDest = path.join(installDir, "on-session-start.js");
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "templates", "codex", "on-session-start.js"), hookDest);
  fs.chmodSync(hookDest, 0o755);
  const bak = backup(configPath);
  let existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  // 三步去重：先剥离上一次的 managed 块，再清掉旧 schema 残留
  existing = stripCodexManagedBlock(existing);
  existing = stripLegacyCodexOtel(existing);
  existing = stripLegacyCodexHook(existing);

  const logsEndpoint = logsEndpointFromGrpc(endpoint);
  const managed = buildCodexManagedBlock(endpoint, hookDest, logsEndpoint);
  const merged = (existing.trimEnd() + "\n\n" + managed + "\n").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, merged, "utf8");
  return { tool: "codex", status: "installed", path: configPath, backup: bak };
}

function installGemini(home, endpoint) {
  const geminiDir = path.join(home, ".gemini");
  if (!fs.existsSync(geminiDir)) {
    return { tool: "gemini", status: "skipped", reason: "未检测到 ~/.gemini" };
  }
  const installDir = path.join(geminiDir, "ai-otel");
  const settingsPath = path.join(geminiDir, "settings.json");
  const hookDest = path.join(installDir, "on-session-start.js");
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "templates", "gemini", "on-session-start.js"), hookDest);
  fs.chmodSync(hookDest, 0o755);
  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = { ...existing };
  // ⚠️ Gemini telemetry.target 只支持 "local" 与 "gcp"，没有 "otlp" 枚举值。
  //    指向自建 OTLP 接收端的标准用法是 target=local + otlpEndpoint=<url>。
  //    见调研：docs/superpowers/specs/2026-04-29-multi-cli-otel-research.md §2.2
  merged.telemetry = {
    ...(existing.telemetry || {}),
    enabled: true,
    target: "local",
    otlpEndpoint: endpoint,
    otlpProtocol: "grpc",
    logPrompts: false,
  };
  merged.hooks = { ...(existing.hooks || {}) };
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const hookEntry = {
    id: HOOK_ID,
    command: `node "${hookDest}"`,
  };
  const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
  if (idx >= 0) sessionStart[idx] = hookEntry;
  else sessionStart.push(hookEntry);
  merged.hooks.SessionStart = sessionStart;
  writeJSONAtomic(settingsPath, merged);
  return { tool: "gemini", status: "installed", path: settingsPath, backup: bak };
}

// ---------- 主流程 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const errs = validateArgs(args);
  if (errs.length) {
    console.error("[cc-otel-installer] 参数错误：");
    for (const e of errs) console.error("  - " + e);
    console.error("");
    printUsage();
    process.exit(2);
  }

  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const installDir = path.join(claudeDir, "cc-otel");
  const settingsPath = path.join(claudeDir, "settings.json");
  const hookScriptDest = path.join(installDir, "on-session-start.js");

  const templateDir = path.join(__dirname, "templates");
  const settingsTemplate = readJSONSafe(path.join(templateDir, "settings.template.json"));
  const hookScriptSrc = path.join(templateDir, "on-session-start.js");

  if (!fs.existsSync(hookScriptSrc)) {
    console.error(`[cc-otel-installer] 找不到 hook 模板：${hookScriptSrc}`);
    process.exit(1);
  }

  const endpoint = resolveEndpoint(args.url);
  const newEnv = buildEnv(settingsTemplate, args, endpoint);

  const hookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${hookScriptDest}"`,
        timeout: 3,
      },
    ],
    description:
      "cc-otel-installer 注入：补采项目/git/hostname 维度，POST 到 OTLP/HTTP 4318",
    id: HOOK_ID,
  };

  // UserPromptSubmit 兜底 hook：复用同一脚本，由 stdin.hook_event_name 在脚本内部
  // 分流。客户端做 5 分钟节流，服务端见 entry 已存在则仅补空。用于救 SessionStart
  // 因网络/超时丢失的场景（线上观测约 60% 事件因此空 git/hostname）。
  const promptHookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${hookScriptDest}"`,
        timeout: 3,
      },
    ],
    description:
      "cc-otel-installer 注入：UserPromptSubmit 兜底，救 SessionStart 漏发场景",
    id: PROMPT_HOOK_ID,
  };

  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(hookScriptSrc, hookScriptDest);
  fs.chmodSync(hookScriptDest, 0o755);

  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = mergeSettings(
    existing,
    newEnv,
    hookEntry,
    promptHookEntry,
    extractHost(endpoint)
  );
  writeJSONAtomic(settingsPath, merged);

  const results = [];
  try {
    results.push(installCodex(home, endpoint));
  } catch (e) {
    results.push({ tool: "codex", status: "failed", reason: e.message });
  }
  try {
    results.push(installGemini(home, endpoint));
  } catch (e) {
    results.push({ tool: "gemini", status: "failed", reason: e.message });
  }

  const debug = !!args.debug || process.argv.includes("--debug") || process.argv.includes("-d");
  const allResults = [{ tool: "claude", status: "installed" }, ...results];

  console.log("[ai-otel-installer] 安装完成。");
  console.log("");
  console.log(`  ${"endpoint".padEnd(12)}: ${endpoint}`);
  for (const r of allResults) {
    console.log(`  ${r.tool.padEnd(12)}: ${r.status}${r.reason ? " (" + r.reason + ")" : ""}`);
  }
  if (debug) {
    console.log(`  ${"hook script".padEnd(12)}: ${hookScriptDest}`);
    console.log(`  ${"settings".padEnd(12)}: ${settingsPath}`);
    if (bak) console.log(`  ${"backup".padEnd(12)}: ${bak}`);
  }
  console.log("");
  console.log("接下来：直接运行 `claude` / `codex` / `gemini`，下次会话启动即自动上报。");
  if (debug) {
    console.log(
      "卸载：删除 " +
        installDir +
        " 与 " +
        path.join(claudeDir, "cc-otel-state") +
        "（marker 目录），并从 settings.json 移除 12 个 OTEL_* env、" +
        "SessionStart 中 id=" + HOOK_ID + " 与 UserPromptSubmit 中 id=" + PROMPT_HOOK_ID + " 的条目。"
    );
  }
}

function printUsage() {
  console.log(`Usage:
  npx -y ai-otel-installer url=COLLECTOR_HOST

参数（必填）：
  url    Collector host（裸 IP/域名，自动补 http://...:4317；也可传完整 URL）

可选：
  debug=1 | --debug   显示安装路径、备份路径与卸载提示
`);
}

try {
  main();
} catch (e) {
  console.error("[cc-otel-installer] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
}
