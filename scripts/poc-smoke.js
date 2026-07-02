#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const endpoint = process.env.AI_OTEL_POC_ENDPOINT || "http://otel-mock:4318";
const home = process.env.HOME || os.homedir();
const allowNonTempHome = process.env.AI_OTEL_POC_ALLOW_NON_TEMP_HOME === "1";

function fail(message) {
  console.error(`[poc-smoke] ${message}`);
  process.exit(1);
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing expected file: ${filePath}`);
  }
}

console.log(`[poc-smoke] HOME=${home}`);
console.log(`[poc-smoke] endpoint=${endpoint}`);

if (!allowNonTempHome && !path.resolve(home).startsWith("/tmp/")) {
  fail("refusing to write to a non-temporary HOME; run with HOME=/tmp/ai-otel-home or set AI_OTEL_POC_ALLOW_NON_TEMP_HOME=1");
}

fs.mkdirSync(home, { recursive: true });
spawnSync("git", ["config", "--global", "user.email", "delivery-poc@example.invalid"], {
  env: { ...process.env, HOME: home },
  stdio: "ignore",
});
spawnSync("git", ["config", "--global", "user.name", "Delivery POC"], {
  env: { ...process.env, HOME: home },
  stdio: "ignore",
});

const result = spawnSync(process.execPath, [path.join(__dirname, "..", "cli.js"), `url=${endpoint}`, "--http"], {
  cwd: path.join(__dirname, ".."),
  env: {
    ...process.env,
    HOME: home,
  },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  fail(`installer exited with status ${result.status}`);
}

const claudeDir = path.join(home, ".claude");
const settingsPath = path.join(claudeDir, "settings.json");
const installDir = path.join(claudeDir, "cc-otel");

assertFile(settingsPath);
assertFile(path.join(installDir, "launch-hook.js"));
assertFile(path.join(installDir, "on-session-start.js"));
assertFile(path.join(installDir, "endpoint.json"));
assertFile(path.join(installDir, "ai-otel.log"));

let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (error) {
  fail(`settings.json is not valid JSON: ${error.message}`);
}

if (!settings.env || settings.env.CLAUDE_CODE_ENABLE_TELEMETRY !== "1") {
  fail("settings.json does not enable Claude Code telemetry");
}

if (!settings.hooks || !Array.isArray(settings.hooks.SessionStart)) {
  fail("settings.json does not include SessionStart hooks");
}

const hasManagedHook = settings.hooks.SessionStart.some((entry) => entry && entry.id === "team:session-start");
if (!hasManagedHook) {
  fail("settings.json does not include managed team:session-start hook");
}

console.log("[poc-smoke] installer smoke test passed");
