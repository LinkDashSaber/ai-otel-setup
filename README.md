# cc-otel-installer

> iFlyTek BG 一键开通 Claude Code 观测上报：`settings.json` + SessionStart hook + Collector endpoint，**一行命令搞定**。

---

## 一行命令安装

```bash
npx -y github:decent-yu/cc-otel-setup url=COLLECTOR_HOST bg=BG dept=DEPT team=TEAM
```

或参数全塞一个 argv（用逗号分隔）：

```bash
npx -y github:decent-yu/cc-otel-setup url=COLLECTOR_HOST,bg=BG,dept=DEPT,team=TEAM
```

> **占位符替换说明**：上面四个**全大写**单词 `COLLECTOR_HOST` / `BG` / `DEPT` / `TEAM` 都是占位符，复制命令后必须替换为本团队的实际值（例如 `url=10.20.30.40 bg=consumer dept=ai-eng team=copilot`）。具体取值请向团队效能负责人索取，或参考内部 wiki。

执行完成后**直接运行 `claude` 就开始上报**，无需手动 `/plugin install` / 改 settings。

---

## 参数

| key | 必填 | 说明 |
|---|---|---|
| `url` | ✅ | Collector host。裸 IP / 域名（installer 自动补 `http://<url>:4317`）；或完整 URL（如 `https://otel.company.io:4317`） |
| `bg` | ✅ | 业务 BG 名称，写入 `OTEL_RESOURCE_ATTRIBUTES.bg` |
| `dept` | ✅ | 部门，写入 `OTEL_RESOURCE_ATTRIBUTES.dept` |
| `team` | ✅ | 团队，写入 `OTEL_RESOURCE_ATTRIBUTES.team` |

四个值都**不允许包含空格或逗号**（OTel resource attributes 编码限制）。

---

## installer 实际做了什么

| # | 动作 | 路径 |
|---|---|---|
| 1 | 拷贝 hook 脚本 | `~/.claude/cc-otel/on-session-start.js` |
| 2 | 备份原 settings | `~/.claude/settings.json.bak.<timestamp>` |
| 3 | 合并 13 个 OTel env 到 settings | `~/.claude/settings.json` 的 `env` |
| 4 | 注入 SessionStart hook | `~/.claude/settings.json` 的 `hooks.SessionStart`，`id: team:session-start` |

合并规则：

- 用户 `settings.json` 已有的其它 env / hook **完全保留**
- 13 个 `OTEL_*` 与 `CLAUDE_CODE_ENABLE_TELEMETRY` 以 installer 值**优先**（组织规范不允许个人改隐私红线）
- SessionStart hook 按 `id` 去重，重跑 installer 不会产生重复条目（幂等）

---

## 与 CC 原生 plugin 的区别

| 维度 | CC 原生 plugin (`team-skills-plugin/`) | 本 installer |
|---|---|---|
| 安装 | `/plugin marketplace add` + `/plugin install` 两步 | 一行 `npx` |
| 参数注入 | ❌ placeholder 需事后手改 | ✅ url/bg/dept/team 安装时即注入 |
| Auto-update | ✅ 支持 | ❌ 升级需重跑 `npx` |
| 适用场景 | 长期订阅、追新升级 | 一次性接入、快速铺量 |

两条路径并存：本 installer 是「快速接入」主路径，CC 原生 plugin 仍保留作为升级订阅通道。

---

## 卸载

```bash
# 1. 删除 hook 脚本
rm -rf ~/.claude/cc-otel

# 2. 从 settings.json 清掉 OTEL_* env 与 SessionStart 条目
jq 'del(.env.CLAUDE_CODE_ENABLE_TELEMETRY,
        .env.OTEL_METRICS_EXPORTER, .env.OTEL_LOGS_EXPORTER,
        .env.OTEL_EXPORTER_OTLP_PROTOCOL, .env.OTEL_EXPORTER_OTLP_ENDPOINT,
        .env.OTEL_LOGS_EXPORT_INTERVAL, .env.OTEL_METRIC_EXPORT_INTERVAL,
        .env.OTEL_RESOURCE_ATTRIBUTES, .env.OTEL_METRICS_INCLUDE_VERSION,
        .env.OTEL_LOG_USER_PROMPTS, .env.OTEL_LOG_TOOL_DETAILS,
        .env.OTEL_LOG_TOOL_CONTENT, .env.OTEL_LOG_RAW_API_BODIES)
   | .hooks.SessionStart |= map(select(.id != "team:session-start"))' \
   ~/.claude/settings.json > ~/.claude/settings.json.new \
&& mv ~/.claude/settings.json.new ~/.claude/settings.json
```

或直接还原备份：

```bash
ls ~/.claude/settings.json.bak.* | tail -1 | xargs -I{} cp {} ~/.claude/settings.json
```

---

## 隐私采集范围

与 `team-skills-plugin` 一致，详见上一级目录的 `team-skills-plugin/README.md`。核心：

- ✅ 采集：tool 名 / 耗时 / 成功与否、token 成本、cwd / git 元信息、bg/dept/team 维度
- ❌ 不采集：用户 prompt 原文、代码正文、tool 入参 JSON、API 裸 body

---

## 故障排查

| 现象 | 检查 |
|---|---|
| `claude` 启动时 hook 没跑 | `cat ~/.claude/settings.json \| jq '.hooks.SessionStart'` 看是否有 `id: team:session-start` |
| Collector 收不到数据 | `nc -zv <url> 4317` 测端口连通；`grep OTEL ~/.claude/settings.json` 看 endpoint 是否被替换 |
| 重跑 installer 想覆盖参数 | 直接重跑即可，幂等。备份会按时间戳累积 |

反馈：`productivity@iflytek.example`
