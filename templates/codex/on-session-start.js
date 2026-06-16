#!/usr/bin/env node
"use strict";

const { execFileSync, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");
let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging is best effort; old installs may not have logging.js yet.
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function safeGit(args) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
  } catch (_) {
    return "";
  }
}

// 解析 OTLP/HTTP logs endpoint。优先级：env 覆盖 → installer 写在 hook 同目录的
// endpoint.json → localhost 兜底。原本走 shell 前缀 `AI_OTEL_LOGS_ENDPOINT=...` 注入
// env，但那是 POSIX 独有语法、cmd.exe 把它当程序名就 G 了，所以 v1.0.4 起命令行
// 不再带前缀，改让脚本自己读 endpoint.json，跨平台统一。env 留作 debug 覆盖口。
function endpoint() {
  if (process.env.AI_OTEL_LOGS_ENDPOINT) return process.env.AI_OTEL_LOGS_ENDPOINT;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "endpoint.json"), "utf8"));
    if (cfg && cfg.logsEndpoint) return cfg.logsEndpoint;
  } catch (_) { /* 文件不存在/解析失败：继续走 localhost */ }
  return "http://localhost:4318/v1/logs";
}

// 每次 codex SessionStart 都 spawn detached 的本地用量扫描器，让 codex 用户（往往不开 Claude Code）
// 不再只有装机那一次上报。读 endpoint.json 的 localUsageUrl 决定是否启用；节流由 scanner 自身 5min 控制。
// 这里用 process.execPath 没问题：hook 已经在 node 里跑，不涉及外层命令的 node 路径解析问题。
function spawnLocalUsageScanner() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "endpoint.json"), "utf8"));
    if (!cfg || !cfg.localUsageUrl) return;
    const scannerPath = path.join(__dirname, "local-usage-scanner.js");
    if (!fs.existsSync(scannerPath)) return;
    const child = spawn(process.execPath, [scannerPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    logEvent("codex_local_usage_spawned", {});
  } catch (e) {
    logEvent("codex_local_usage_spawn_failed", { error: (e && e.message) || "unknown" });
  }
}

(async () => {
  try {
    const raw = await readStdin();
    let input = {};
    try { input = JSON.parse(raw || "{}"); } catch (_) {}
    const conversation = input.conversation || {};
    const sid = conversation.id || input.conversation_id || input.session_id || "";
    logEvent("codex_hook_start", { hasSessionId: !!sid });
    spawnLocalUsageScanner();

    const cwd = input.cwd || process.cwd();
    const event = {
      "tool_kind": "codex",
      "event.name": "hook_session_start",
      "session.id": sid,
      "cwd": cwd,
      "project.name": path.basename(cwd),
      "git.remote": safeGit(["-C", cwd, "config", "--get", "remote.origin.url"]),
      "git.user.email": safeGit(["-C", cwd, "config", "user.email"]),
      "git.user.name": safeGit(["-C", cwd, "config", "user.name"]),
      "hostname": os.hostname() || "",
      "data_source": "hook",
    };
    logEvent("codex_hook_payload", event);
    const payload = JSON.stringify({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, body: { stringValue: "hook_session_start" }, attributes: Object.entries(event).map(([key, value]) => ({ key, value: { stringValue: String(value ?? "") } })) }] }] }] });
    const url = new URL(endpoint());
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => {
        logEvent("codex_hook_post_end", { statusCode: res.statusCode || 0 });
        process.exit(0);
      });
    });
    req.on("error", (e) => {
      logEvent("codex_hook_post_error", { error: e && e.message ? e.message : "request_error" });
      process.exit(0);
    });
    req.on("timeout", () => {
      logEvent("codex_hook_post_timeout");
      req.destroy();
      process.exit(0);
    });
    req.end(payload);
    setTimeout(() => {
      logEvent("codex_hook_timeout_exit");
      process.exit(0);
    }, 2500).unref();
  } catch (_) {
    logEvent("codex_hook_error");
    process.exit(0);
  }
})();
