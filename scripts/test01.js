#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

const packageJson = JSON.parse(read("package.json"));
assert.strictEqual(packageJson.name, "ai-otel-setup");

const workflow = read(".github/workflows/release.yml");
assert.match(workflow, /name:\s*Raven delivery smoke/);
assert.match(workflow, /name:\s*raven-delivery-manifest/);
assert.match(workflow, /ghcr\.io\/stefanprodan\/podinfo:6\.9\.0/);

const chartJob = read("chart/ai-otel-setup-poc/templates/job.yaml");
assert.match(chartJob, /scripts\/poc-smoke\.js/);

const dockerfile = read("Dockerfile");
assert.match(dockerfile, /COPY scripts\/poc-smoke\.js/);

console.log("test01: Raven delivery smoke assets are wired correctly");
