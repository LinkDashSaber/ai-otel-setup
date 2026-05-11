# Codex SessionStart 钩子在 Windows 不触发 · 现场排查清单

适用：用户在 Windows 上跑 `npx -y ai-otel-setup url=...` 装完之后，启动 `codex` 会话，看板里收不到 codex_session 事件（而 cc 正常）。

下面所有命令默认用 **PowerShell 7（推荐）** 或 **PowerShell 5.1**（Win10/11 自带）。`cmd.exe` 也能用，但路径反斜杠转义不一样，遇到差异时优先 PowerShell。

---

## 钩子链路速查

```
用户跑 codex
   ↓
codex 读 %USERPROFILE%\.codex\config.toml
   ↓ 找 [features].hooks = true ?
   ↓ 找 [[hooks.SessionStart]] matcher = "startup|resume" ?
   ↓ 找 [[hooks.SessionStart.hooks]] command = "<node>" "<launcher>" "<hook>"
   ↓
codex 用系统 shell 起 command（Windows 下走 cmd.exe）
   ↓
launch-hook.js  ← 探 PATH 上 node，找不到回退安装时的 execPath
   ↓
on-session-start.js  ← 读 stdin (codex 传 JSON payload) + endpoint.json，发 OTLP gRPC 到 4317
   ↓
后端 cc-view-server 落库 → 看板「cc_session」/「codex_session」事件
```

任何一步断了都会"装了但没数据"。下面 5 个 step 一步步定位。

---

## Step 1：确认安装确实跑成功

```powershell
# 在 Windows PowerShell 里
ls $env:USERPROFILE\.codex\ai-otel\
# 期望看到 3 个文件：
#   on-session-start.js
#   launch-hook.js
#   endpoint.json
```

- ❌ **目录不存在 / 文件缺失** → installer 没跑成功。重跑：
  ```powershell
  npx -y ai-otel-setup url=172.31.250.57
  ```
  跑完输出末尾找 `codex: installed`。如果看到 `skipped` 说明 `~/.codex` 不存在（用户从没启动过 codex）—— 让用户先 `codex` 一次创建目录，再装一次。

- ✅ 三个文件都在 → 进 Step 2。

---

## Step 2：确认 config.toml 写对了

```powershell
type $env:USERPROFILE\.codex\config.toml
```

逐项核对：

### 2.1 `[features].hooks = true`

应该有这一段（顺序无所谓，只要有就行）：

```toml
[features]
hooks = true
```

- ❌ 没有 `[features]` 整个 section → installer 老版本的锅，重跑 installer
- ❌ 有 `[features]` 但没 `hooks = true`，或者写成 `hooks = false` → **codex 整段 hooks 配置会被忽略**。手动加上 `hooks = true`，或重跑 installer（会自动补）
- ⚠️ 如果同时存在旧的 `codex_hooks = true`，那是 codex 老版本的 key，已废弃。**新 installer 会自动删掉**。如果还在，重跑一次 installer

### 2.2 managed 块完整

文件末尾应该有：

```toml
# >>> ai-otel-setup managed >>>
[otel]
environment = "prod"
log_user_prompt = false

[otel.exporter."otlp-grpc"]
endpoint = "http://172.31.250.57:4317"

[otel.trace_exporter."otlp-grpc"]
endpoint = "http://172.31.250.57:4317"

[otel.metrics_exporter."otlp-grpc"]
endpoint = "http://172.31.250.57:4317"

[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\xxx\\.codex\\ai-otel\\launch-hook.js\" \"C:\\Users\\xxx\\.codex\\ai-otel\\on-session-start.js\""
# <<< ai-otel-setup managed <<<
```

- ❌ **没看到 `[[hooks.SessionStart]]` 这段** → installer 没装对，重跑
- ❌ `command` 路径里看到 `/Users/decent/...` 之类 macOS 路径 → 这台机器是从别处拷过来的 toml，不是本机装的。在本机重跑 installer 覆盖
- ❌ `command` 里 node.exe 路径不存在（用 `Test-Path "C:\Program Files\nodejs\node.exe"` 验证）→ 用户卸了 installer 当时那个 node。launcher 会 fallback 探 PATH，但万一 PATH 上也没 node 就彻底死。**重装 Node 或重跑 installer**

---

## Step 3：手动跑钩子，看到底有没有挂

把 stdin 模拟 codex 给的 SessionStart payload 喂给 hook，看错误：

```powershell
# 准备一段假 payload（模拟 codex 启动 hook 时塞进 stdin 的内容）
$payload = '{"hook_event_name":"SessionStart","matcher":"startup","cwd":"' + ($PWD.Path -replace '\\','\\\\') + '"}'

# 直接拿 launcher 跑（按 config.toml 里 command 字段的样子）
echo $payload | node "$env:USERPROFILE\.codex\ai-otel\launch-hook.js" "$env:USERPROFILE\.codex\ai-otel\on-session-start.js"
echo "--- exit code: $LASTEXITCODE ---"
```

预期：**没输出 + exit 0**，表示 hook 成功执行（OTLP 发完即结束）。

常见报错与处理：

| 报错 | 含义 | 修法 |
|---|---|---|
| `node : 无法将"node"项识别为 cmdlet...` | PATH 上没 node | 装 Node.js LTS，或重跑 installer 让 launcher fallback 到 baked execPath |
| `Cannot find module '...'` | hook 文件路径不对 | 用 `Test-Path` 检查 ai-otel 目录三个文件 |
| `connect ETIMEDOUT 172.31.250.57:4317` | 出站到 OTLP 4317 被防火墙挡 | 见 Step 4 |
| `endpoint.json` 不存在 / 解析失败 | 重跑 installer |
| 卡死无返回 | 网络半通；用 Ctrl+C，看 Step 4 |

如果手动这一步**输出 OK 但 exit 非 0**，看 stderr 上有什么 → 通常是网络层。

---

## Step 4：网络可达性

OTLP gRPC 端口 4317：

```powershell
Test-NetConnection -ComputerName 172.31.250.57 -Port 4317
```

期望 `TcpTestSucceeded : True`。

- ❌ False → 走代理 / 公司防火墙挡 4317。让网管开通 / 让用户切到能直连的网。
- ⚠️ 注意：cc 的 `claude_code` 走 OTLP 也是 4317，**cc 能上报但 codex 不能** 这种情形几乎不可能是网络问题，大概率还是 hook 没触发（Step 1/2 没过）。

---

## Step 5：codex 真的触发 hook 了吗？

最权威的证据是 codex 自己的日志。Codex Rust binary 默认日志在：

```powershell
type $env:USERPROFILE\.codex\log\codex-tui.log
# 或者
ls $env:USERPROFILE\.codex\log\
```

启动 `codex` 一次，立刻 `tail` 这个日志（PowerShell 等价 `Get-Content -Wait`）：

```powershell
Get-Content -Path $env:USERPROFILE\.codex\log\codex-tui.log -Wait -Tail 50
```

观察启动那一瞬间是否出现：
- `SessionStart` 字样
- `running hook` / `executing command` 字样

- ❌ **完全没看到 hook 相关日志** → codex 没识别到 hook 配置。可能性：
  - codex 版本太老（`codex --version` 看一下，2025 年下半年加的 SessionStart）
  - `[features].hooks = true` 缺失（回 Step 2.1）
  - config.toml 语法错误，codex 解析失败默默忽略（看 codex 启动时是否有 toml 报错）

- ✅ **看到 hook 触发但执行失败** → 把那段错误粘出来，对照 Step 3 那张表

---

## Step 6（可选）：直接看 codex 解析后的 config

```powershell
codex --print-config
# 或
codex config show
```

具体子命令视 codex 版本而定。能看到 codex 实际生效的 hooks 配置 —— 如果这里都没有 SessionStart，那肯定是 toml 没解析进来（多半是 `[features].hooks` 缺失或语法错）。

---

## 把这些信息发给我（如果还没解决）

```powershell
# 一次性收集，发给后端排查
Write-Host "=== node ==="
node -v
Get-Command node | Select-Object -ExpandProperty Source

Write-Host "`n=== codex ==="
codex --version

Write-Host "`n=== config.toml ==="
type $env:USERPROFILE\.codex\config.toml

Write-Host "`n=== ai-otel dir ==="
ls $env:USERPROFILE\.codex\ai-otel\

Write-Host "`n=== endpoint.json ==="
type $env:USERPROFILE\.codex\ai-otel\endpoint.json

Write-Host "`n=== 手跑 hook ==="
$payload = '{"hook_event_name":"SessionStart","matcher":"startup","cwd":"."}'
echo $payload | node "$env:USERPROFILE\.codex\ai-otel\launch-hook.js" "$env:USERPROFILE\.codex\ai-otel\on-session-start.js" 2>&1
echo "exit: $LASTEXITCODE"

Write-Host "`n=== 网络 ==="
Test-NetConnection -ComputerName 172.31.250.57 -Port 4317 | Select-Object -Property TcpTestSucceeded, RemoteAddress

Write-Host "`n=== codex log 最近 50 行 ==="
$log = "$env:USERPROFILE\.codex\log\codex-tui.log"
if (Test-Path $log) { Get-Content $log -Tail 50 } else { Write-Host "(no log file at $log)" }
```

把整段输出贴回来，能 90% 钉死问题。

---

## 最常见的 3 个根因（按概率排序）

1. **`[features].hooks = true` 没写入 / 写成了别的值**
   现象：config.toml 末尾的 managed 块齐全，但 codex 启动时不触发任何 hook。
   修：在 `[features]` 段下确认有 `hooks = true`。重跑 installer 也会修。

2. **codex CLI 版本老**
   现象：`codex --version` 是几个月前的版本，根本没 SessionStart hook 实现。
   修：升级 codex（`npm i -g @openai/codex` 或对应渠道）。

3. **PATH 上没 node**
   现象：手动跑 Step 3 那条 `node ... launch-hook.js` 直接报 `node 不是内部命令`。
   v1.0.9 起 hook command 改用裸 `node` 走 PATH lookup，不再写绝对路径，
   PATH 上必须有 node 才能起来。
   修：装 Node.js LTS 加 PATH。

---

## 用户名含空格（极少数场景）

如果 Windows 用户名是 `John Smith` 这种带空格的形式，`~/.codex` 路径会变成
`C:\Users\John Smith\.codex\...`。当前 installer 写出来的 hook command 是

```
node C:\Users\John Smith\.codex\ai-otel\launch-hook.js C:\Users\John Smith\.codex\ai-otel\on-session-start.js
```

cmd / PowerShell 都会按空白把它切成 5+ 个 token，hook 起不来。

**应对（任选其一）**：

A. 改 Windows 用户名（不推荐，影响面大）

B. 手动改 `config.toml` 的 command，用 8.3 短路径强制无空格：
```powershell
# 拿 8.3 短路径
cmd /c "for %A in (\"C:\Users\John Smith\") do @echo %~sA"
# 输出例如 C:\Users\JOHNSM~1
```
把 command 改成：
```toml
command = "node C:\\Users\\JOHNSM~1\\.codex\\ai-otel\\launch-hook.js C:\\Users\\JOHNSM~1\\.codex\\ai-otel\\on-session-start.js"
```
注意 NTFS 卷必须没禁用 8dot3name，`fsutil 8dot3name query` 验证。

C. 让 installer 装到 `C:\ProgramData\ai-otel\<username-hash>` 这种无空格路径
（功能未实现，需求确认后再排）。

---

> 排查完了如果还是没数据，把 Step "把这些信息发给我" 的整段输出贴回开发，附上"什么时候启动了 codex" 的时间戳（精确到分钟），我可以从后端 events 表反查那一刻有没有事件落到 idata。
