#!/usr/bin/env node
/**
 * SessionStart hook —— v1.2 §3.2 的生产实现
 *
 * 职责：
 *   采集 CC 原生 OTel 不覆盖的 5 个字段（cwd / git_remote / git_user_email /
 *   git_user_name / hostname），通过 OTLP/HTTP 4318 发给 Collector，
 *   与 OTel 主流合流。
 *
 * 关键约束（v1.2 §3.2 / §9）：
 *   - 不读源代码，只读 git 元信息
 *   - 总耗时 < 3s（hooks.json 已设 timeout=3）
 *   - 失败静默，绝不阻塞 CC 启动
 *   - session.id 从 stdin 读（MVP 实证与 OTel session.id 一致）
 */

"use strict";

const { execSync } = require("child_process");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// -------- 环境变量读取 ----------

/**
 * 推导 OTel Collector 的 OTLP/HTTP logs endpoint。
 * 优先级：
 *   1. 显式 OTEL_EXPORTER_OTLP_LOGS_ENDPOINT（用户指定 logs 端点）
 *   2. OTEL_EXPORTER_OTLP_ENDPOINT（通用端点，自动补 /v1/logs，把 4317 换成 4318）
 *   3. fallback http://localhost:4318/v1/logs
 */
function resolveLogsEndpoint() {
  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) return logsEndpoint;

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const url = new URL(base);
  // gRPC 默认 4317 → OTLP/HTTP 默认 4318
  if (url.port === "4317") url.port = "4318";
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
  return url.toString();
}

// -------- 工具函数 ----------

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // 防挂死：2s 读不到 stdin 就放弃
    setTimeout(() => resolve(data), 2000);
  });
}

function safeExec(cmd) {
  try {
    return execSync(cmd, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    })
      .toString()
      .trim();
  } catch (_) {
    return null;
  }
}

// -------- 主流程 ----------

(async () => {
  try {
    const raw = await readStdin();
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch (_) {
      input = {};
    }

    const cwd = input.cwd || process.cwd();
    const sessionId = input.session_id || input.sessionId || ""; // MVP 实证：stdin.session_id = OTel session.id

    const event = {
      "event.name": "hook_session_start",
      "event.timestamp": new Date().toISOString(),
      "session.id": sessionId,
      "cwd": cwd,
      "project.name": path.basename(cwd),
      "git.remote": safeExec(`git -C "${cwd}" config --get remote.origin.url`) || "",
      "git.user.email": safeExec(`git -C "${cwd}" config user.email`) || "",
      "git.user.name": safeExec(`git -C "${cwd}" config user.name`) || "",
      "hostname": os.hostname() || "",
      "data_source": "hook", // Collector 端用 insert 而非 upsert 以保留本标签
    };

    const logsEndpoint = resolveLogsEndpoint();
    const payload = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: `${Date.now()}000000`,
                  body: { stringValue: "hook_session_start" },
                  attributes: Object.entries(event).map(([k, v]) => ({
                    key: k,
                    value: { stringValue: String(v ?? "") },
                  })),
                },
              ],
            },
          ],
        },
      ],
    });

    const url = new URL(logsEndpoint);
    const lib = url.protocol === "https:" ? https : http;

    // 关键：必须等 HTTP request 真的发出并收到响应（或短时间超时）才退出，
    // 不能 req.end() 之后立刻 process.exit(0) —— 那样 TCP handshake 都
    // 还没做完进程就没了，Collector 永远收不到。
    // Hook timeout 是 3s，这里给自己 2.5s 上限。
    const done = (() => {
      let called = false;
      return () => {
        if (called) return;
        called = true;
        process.exit(0);
      };
    })();

    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(process.env.OTEL_EXPORTER_OTLP_HEADERS
            ? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
            : {}),
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on("end", done);
        res.on("error", done);
      }
    );

    req.on("error", done);     // 失败静默退出
    req.on("timeout", () => { req.destroy(); done(); });
    req.write(payload);
    req.end();

    // 兜底：2.5s 强制退出（CC hook timeout 3s 前先自己结束）
    setTimeout(done, 2500).unref();
  } catch (_) {
    // 兜底：任何异常都不阻塞 CC
    process.exit(0);
  }
})();

function parseHeaders(headerStr) {
  // "Authorization=Bearer xxx,X-Trace=yyy" -> { Authorization: "Bearer xxx", "X-Trace": "yyy" }
  const out = {};
  for (const pair of headerStr.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
