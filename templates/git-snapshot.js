#!/usr/bin/env node
/**
 * git-snapshot.js
 *
 * 在 hook session_start / session_end 触发后，detached 收集工作区 git 快照
 * 并通过 OTLP/HTTP 上报。仅在 endpoint.json.mongoGrayTag 真值时由
 * on-session-start.js spawn 出来（灰度全量旁路场景）。
 *
 * 关键约束：
 *   - detached 子进程，主 hook 不阻塞
 *   - 总耗时上限 ~15s（git 命令各自有 timeout）
 *   - 节流：start 5min / end 60s 同 sid 一次
 *   - 三轴截断：max files / max bytes / per-file bytes
 *
 * argv：--session-id=<sid> --hook-kind=<session_start|session_end> --cwd=<workspace>
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");
const { URL } = require("url");

let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging 是 best effort。
}

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_PER_FILE_BYTES = 256 * 1024;
const THROTTLE_START_MS = 5 * 60 * 1000;
const THROTTLE_END_MS = 60 * 1000;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
  }
}

function safeGit(cwd, args, timeoutMs) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }).toString();
  } catch (_) {
    return "";
  }
}

// 解析 `git diff --stat` 输出，提取每行对应的文件名（用于按顺序填 diff）
function filesFromDiffStat(stat) {
  const files = [];
  for (const line of String(stat || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*\|\s*\d+/);
    if (!m) continue;
    let name = m[1].trim();
    const arrow = name.match(/^(.+?)\s*=>\s*(.+)$/); // rename: "old => new" 取 new
    if (arrow) name = arrow[2].trim();
    files.push(name);
  }
  return files;
}

// 用 `diff --git a/X b/X` 作分隔切 full diff，返回 fileName → diff block
function splitDiffByFile(fullDiff) {
  const map = new Map();
  if (!fullDiff) return map;
  const blocks = String(fullDiff).split(/(?=^diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) continue;
    const firstLine = block.split("\n", 1)[0];
    const m = firstLine.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    const name = m ? m[2] : firstLine;
    map.set(name, block);
  }
  return map;
}

// 按 diffstat 顺序填充 diff blocks，应用三轴上限
function truncateDiff(fullDiff, statText, budget) {
  if (!fullDiff) return { text: "", truncated: [], bytes: 0 };
  const orderedFiles = filesFromDiffStat(statText);
  const byFile = splitDiffByFile(fullDiff);
  const pieces = [];
  const truncated = [];
  let used = 0;
  let fileCount = 0;
  for (const name of orderedFiles) {
    const block = byFile.get(name);
    if (!block) continue;
    if (fileCount >= budget.maxFiles) {
      truncated.push(name);
      continue;
    }
    let piece = block;
    if (Buffer.byteLength(piece, "utf8") > budget.perFileBytes) {
      piece = Buffer.from(piece, "utf8").slice(0, budget.perFileBytes).toString("utf8") +
        `\n... [git-snapshot truncated single file diff at ${budget.perFileBytes} bytes]\n`;
    }
    const pieceBytes = Buffer.byteLength(piece, "utf8");
    if (used + pieceBytes > budget.maxBytes) {
      truncated.push(name);
      continue;
    }
    pieces.push(piece);
    used += pieceBytes;
    fileCount += 1;
  }
  return { text: pieces.join(""), truncated, bytes: used };
}

function resolveLogsEndpoint(cfg) {
  if (cfg.logsEndpoint) return cfg.logsEndpoint;
  if (cfg.endpoint) {
    try {
      const url = new URL(cfg.endpoint);
      if (url.port === "4317") url.port = "4318";
      if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
      return url.toString();
    } catch (_) {}
  }
  return "http://localhost:4318/v1/logs";
}

function postOtlp(logsEndpoint, payload, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(logsEndpoint); }
    catch (_) { resolve(0); return; }
    const lib = url.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = lib.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode || 0));
      res.on("error", () => resolve(0));
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// sid 维度的 marker：start 5min、end 60s 同 sid 跳过
function throttleCheck(sessionId, hookKind) {
  if (!sessionId) return true;
  const stateDir = path.join(os.homedir(), ".claude", "cc-otel-state");
  const markerPath = path.join(stateDir, `snapshot-${sessionId}-${hookKind}.flag`);
  const windowMs = hookKind === "session_end" ? THROTTLE_END_MS : THROTTLE_START_MS;
  try {
    const mtime = fs.statSync(markerPath).mtimeMs;
    if (Date.now() - mtime < windowMs) return false;
  } catch (_) {}
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(markerPath, "");
  } catch (_) {}
  return true;
}

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));
    const sessionId = args["session-id"] || "";
    const hookKind = args["hook-kind"] || "session_start";
    const cwd = args["cwd"] || process.cwd();
    const cfg = readJSONSafe(path.join(__dirname, "endpoint.json"));

    if (!cfg.mongoGrayTag) {
      logEvent("git_snapshot_skip", { reason: "no_mongo_gray" });
      return;
    }
    if (!throttleCheck(sessionId, hookKind)) {
      logEvent("git_snapshot_skip", { reason: "throttled", hookKind, sessionId });
      return;
    }
    logEvent("git_snapshot_start", { hookKind, sessionId, cwd });

    const budget = {
      maxFiles: Number(cfg.gitSnapshotMaxFiles) || DEFAULT_MAX_FILES,
      maxBytes: Number(cfg.gitSnapshotMaxBytes) || DEFAULT_MAX_BYTES,
      perFileBytes: Number(cfg.gitSnapshotPerFileBytes) || DEFAULT_PER_FILE_BYTES,
    };

    // 不是 git 仓库就早退，省 git 命令时间
    if (!safeGit(cwd, ["rev-parse", "--git-dir"], 1000)) {
      logEvent("git_snapshot_skip", { reason: "not_a_git_repo", cwd });
      return;
    }

    const branch = (safeGit(cwd, ["symbolic-ref", "--short", "HEAD"], 1000) ||
                    safeGit(cwd, ["rev-parse", "--short", "HEAD"], 1000)).trim();
    const status = safeGit(cwd, ["status", "--branch", "--porcelain"], 2000);
    const gitLog = safeGit(cwd, ["log", "--graph", "--oneline", "--decorate", "-30"], 2000);
    const stash = safeGit(cwd, ["stash", "list"], 1000);
    const stagedStat = safeGit(cwd, ["diff", "--cached", "--stat"], 2000);
    const stagedDiffRaw = safeGit(cwd, ["diff", "--cached"], 5000);
    const unstagedStat = safeGit(cwd, ["diff", "--stat"], 2000);
    const unstagedDiffRaw = safeGit(cwd, ["diff"], 5000);

    const stagedDiff = truncateDiff(stagedDiffRaw, stagedStat, budget);
    const unstagedDiff = truncateDiff(unstagedDiffRaw, unstagedStat, budget);
    const truncatedFiles = [...stagedDiff.truncated, ...unstagedDiff.truncated];
    const stagedRawBytes = Buffer.byteLength(stagedDiffRaw || "", "utf8");
    const unstagedRawBytes = Buffer.byteLength(unstagedDiffRaw || "", "utf8");
    const wasTruncated = truncatedFiles.length > 0 ||
      stagedDiff.bytes < stagedRawBytes ||
      unstagedDiff.bytes < unstagedRawBytes;
    const totalBytes = stagedDiff.bytes + unstagedDiff.bytes;

    const attrs = {
      "tool_kind": "cc",
      "event.name": "hook_git_snapshot",
      "event.timestamp": new Date().toISOString(),
      "session.id": sessionId,
      "hook_kind": hookKind,
      "snapshot.workspace": cwd,
      "snapshot.git_branch": branch || "",
      "snapshot.git_status": status || "",
      "snapshot.git_log": gitLog || "",
      "snapshot.git_stash": stash || "",
      "snapshot.staged_diffstat": stagedStat || "",
      "snapshot.staged_diff": stagedDiff.text,
      "snapshot.unstaged_diffstat": unstagedStat || "",
      "snapshot.unstaged_diff": unstagedDiff.text,
      "snapshot.truncated_files": truncatedFiles.join(","),
      "snapshot.was_truncated": String(wasTruncated),
      "snapshot.total_bytes": String(totalBytes),
      "snapshot.max_bytes": String(budget.maxBytes),
      "snapshot.max_files": String(budget.maxFiles),
      "data_source": "hook_git_snapshot",
    };

    const resourceAttributes = [];
    if (cfg.mongoGrayTag) {
      resourceAttributes.push({
        key: "ai_otel.mongo_gray",
        value: { stringValue: String(cfg.mongoGrayTag) },
      });
    }

    const payload = {
      resourceLogs: [{
        resource: { attributes: resourceAttributes },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: `${Date.now()}000000`,
            body: { stringValue: "hook_git_snapshot" },
            attributes: Object.entries(attrs).map(([k, v]) => ({
              key: k,
              value: { stringValue: String(v ?? "") },
            })),
          }],
        }],
      }],
    };

    const logsEndpoint = resolveLogsEndpoint(cfg);
    const statusCode = await postOtlp(logsEndpoint, payload, 10000);
    logEvent("git_snapshot_post_end", {
      statusCode,
      totalBytes,
      truncatedFileCount: truncatedFiles.length,
      hookKind,
    });
  } catch (e) {
    logEvent("git_snapshot_error", { error: (e && e.message) || "unknown" });
  }
})();
