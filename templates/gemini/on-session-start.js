#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
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

function endpoint() {
  const base = process.env.GEMINI_TELEMETRY_OTLP_ENDPOINT || "http://localhost:4317";
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
