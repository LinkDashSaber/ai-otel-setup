#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

function safeGit(args) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
  } catch (_) {
    return "";
  }
}

// 解析 OTLP/HTTP logs endpoint。优先级：env 覆盖 → installer 写在 hook 同目录的
// endpoint.json → localhost 兜底。v1.0.4 起 hook 自己读 endpoint.json，避免依赖
// shell 前缀注入 env 那种 POSIX-only 写法（cmd.exe 不认）。
function endpoint() {
  let base = process.env.GEMINI_TELEMETRY_OTLP_ENDPOINT;
  if (!base) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "endpoint.json"), "utf8"));
      if (cfg && cfg.logsEndpoint) return cfg.logsEndpoint;
      if (cfg && cfg.endpoint) base = cfg.endpoint;
    } catch (_) { /* 文件不存在/解析失败：继续走 localhost */ }
  }
  if (!base) base = "http://localhost:4317";
  const url = new URL(base);
  if (url.port === "4317") url.port = "4318";
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
  return url.toString();
}

try {
  const cwd = process.cwd();
  const event = {
    "tool_kind": "gemini",
    "event.name": "hook_session_start",
    "session.id": process.env.GEMINI_SESSION_ID || "",
    "cwd": cwd,
    "project.name": path.basename(cwd),
    "git.remote": safeGit(["-C", cwd, "config", "--get", "remote.origin.url"]),
    "git.user.email": safeGit(["-C", cwd, "config", "user.email"]),
    "git.user.name": safeGit(["-C", cwd, "config", "user.name"]),
    "hostname": os.hostname() || "",
    "data_source": "hook",
  };
  const payload = JSON.stringify({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, body: { stringValue: "hook_session_start" }, attributes: Object.entries(event).map(([key, value]) => ({ key, value: { stringValue: String(value ?? "") } })) }] }] }] });
  const url = new URL(endpoint());
  const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 2000 }, (res) => { res.resume(); res.on("end", () => process.exit(0)); });
  req.on("error", () => process.exit(0));
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.end(payload);
  setTimeout(() => process.exit(0), 2500).unref();
} catch (_) {
  process.exit(0);
}
