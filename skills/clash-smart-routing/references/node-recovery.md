# Codex 连不上网：按需恢复主节点

复现用户的日常操作：保持「节点选择 → 自动选择」，在自动组中测速，排除香港，只比较日本、台湾、美国，再将最快节点固定在自动组内并复测。原省流分流和 AI 跟随主选择的关系保留。

## 使用

Clash Verge 保持运行，需 Node.js 18+、curl 和本技能现有的 yaml 依赖。断网时直接在本机终端执行，无需先让 Codex 联网。

```sh
# 不切换：检查当前节点的 ChatGPT 公开端点与实际连接链路
node <skill-dir>/scripts/node-recovery.cjs check

# 测速预览，不执行选择操作
node <skill-dir>/scripts/node-recovery.cjs plan

# 测速、选择主节点、核验；失败时回退并停止
node <skill-dir>/scripts/node-recovery.cjs recover

# 查看最近一次结果；恢复上次 recover 前的固定节点或自动模式
node <skill-dir>/scripts/node-recovery.cjs status
node <skill-dir>/scripts/node-recovery.cjs rollback
```

多客户端时加 `--config-dir <实际目录>`；自动选择组不能唯一确定时加 `--latency-group <现有组名>`。不猜客户端、组名或测速地址。

## 执行约定

- 主组必须是原 MATCH 指向的手动选择组，且当前指向现有的 URLTest 自动组。只取自动组里的真实节点，不要求这些节点也出现在主组列表里；香港标记优先排除，其他国家和无法识别地区的节点跳过。地区基于订阅名称，不能证明节点真实出口位置。主组当前选到其他组或具体节点时暂停，不擅自改变主组选择。
- 沿用自动组现有 `testUrl`，不改成另一个服务。每节点超时 5 秒、最多并发 6 个、候选上限 256；失败和零延迟不参与排名。只测一次，取最快的 **低于 200ms** 候选；全部超时或没有绿色候选时保留当前选择。
- `recover` 只对自动组发一次选择请求，更新其 `fixed` 节点。主界面「节点选择」仍然选中「自动选择」，AI 与其他跟随主组的流量共同经过这条链路。自动组定义、节点清单、测速 URL 和间隔均不改。
- 单节点测速使用 `/proxies/<node>/delay`，避免调用会清除 `fixed` 的 `/group/<group>/delay` 整组测速接口。用户在 UI 主动做整组测速后，固定状态仍可能被客户端清除；脚本不拦截该操作。
- 切换后用相同 URL 复测主选择，同时经本机代理访问 `https://chatgpt.com/robots.txt`，要求 HTTP 200、TLS 成功，并在 `/connections` 里按探测源端口核对主组及节点链路。测速值和 ChatGPT TLS/总耗时分别报告。首页测速 URL 未明确配置时，不声称与首页绿灯完全相同。
- 公开请求不携带账号、Cookie、密钥或付费 API 请求；不验证 Codex 的登录、模型请求或流式响应。公开端点成功后仍需回到 Codex 发一条消息验证实际使用。
- 检查失败只回退这次自动组的固定状态并停止，不尝试其他节点或区域：原来有固定节点就恢复它，原来没有固定节点则用 DELETE 清除这次固定，不把原来的自动模式变成手动固定。用户期间改过主组或固定节点时不覆盖。不会断开已有连接、重启应用、修改系统代理、订阅、DNS、规则或安装定时任务。已有长连接可能需要由应用自行重连。

`smart-routing-state/node-recovery-latest.json` 保存最近一次执行结果，`node-recovery-undo.json` 保存上次变更前自动组的固定状态；文件权限为 600，含真实节点名，仅本机保存，不提交 GitHub。并发锁防止重复执行。进程被强制杀死时可能留下锁；确认锁里 PID 已退出后再移除锁，先检查当前选择，需要时执行 `rollback`。

回滚记录使用 version 2，保存主组/自动组身份及此前的 `fixed` 状态。旧版直接更改主组的 version 1 记录不再执行，避免将主组改离自动组。

## 自动检测与恢复（macOS）

仅在用户明确要求自动检测和恢复时启用：

```sh
node <skill-dir>/scripts/node-watchdog.cjs install
node <skill-dir>/scripts/node-watchdog.cjs status
node <skill-dir>/scripts/node-watchdog.cjs uninstall
```

安装 `~/Library/LaunchAgents/io.github.clash-smart-routing.node-watchdog.plist`，登录后自动运行。它独立于 Codex 的联网推理和定时任务，不调用模型，也不依赖 Codex 先恢复联网；与国内直连学习服务分别管理。需保持本技能及 Node 路径稳定，安装时记录绝对路径。

- 每 60 秒检查一次，仅在 Codex／ChatGPT 桌面进程运行、Clash 控制接口可用、处于 Rule 模式且主组指向自动组并能解析到真实节点时探测。应用关闭、Clash 关闭、主组另选节点/其他组、手动 DIRECT、其他模式或手动恢复任务占用时暂停；不自动开关应用或代理。
- 常规检测只发小型 HTTPS HEAD 请求，不下载正文。连续两次传输失败才调用一次原 `recover`。HTTP 401/403/429/5xx 等服务响应本身不会触发换节点；本地 curl／代理端口不可用或链路证据缺失时暂停处理，不把它们当作节点故障。
- 另从 `~/.codex/logs_2.sqlite` 只读查询 `codex_core::responses_retry` 的 WARN/ERROR，识别 TLS 中断、连接重置、请求发送失败等具体传输错误。90 秒内至少两条、时间相隔至少 5 秒且未处理的新错误，可在公开端点仍可达时触发恢复。排除登录、额度、限流和服务端错误。首次运行只记录日志游标，不追溯旧错误；数据库不存在、结构变化或不可读时保留公开探测能力，不声称覆盖全部 Codex 故障。
- 仅保存日志 ID、时间及错误类别，不保存原始日志、会话内容或凭据，不读取 `auth.json`。主节点发生变化时清除上一节点的失败证据，避免立即覆盖手动选择。
- 成功后冷却 10 分钟，失败后冷却 30 分钟，滚动一小时最多 3 次。尝试预算在执行前写入本机文件，重启不清零。每轮仍然只选一个候选，失败回退后停止，不循环试遍节点。
- 正常检查不弹通知；自动切换完成或恢复失败时尝试发送本机通知。通知是否显示取决于 macOS 权限，以状态报告为准。

状态与报告位于 `smart-routing-state/node-watchdog-state.json`、`node-watchdog-report.json`、`node-watchdog-last-recovery.json`，权限均为 600。`status` 显示服务状态和最近检查；需同时确认服务 running、报告时间新鲜以及实际 probe 结果。安装成功不等于经历过真实断网后的自动恢复。

快捷命令统一叫 `clash-net`。将技能中的 `scripts/clash-net` 以可执行文件安装至 `~/.local/bin/clash-net`，并确保该目录已在 PATH 中；它读取已安装的 `$CODEX_HOME/skills/clash-smart-routing`（默认 `~/.codex/skills/clash-smart-routing`）。直接在仓库执行该入口时，使用它所在的技能目录。

可用 `clash-net auto status` 查看、`clash-net auto off` 停止、`clash-net auto on` 启用。停用只停止自动检测，保留当前节点、省流规则和手动命令。单次恢复用 `clash-net`，只检查用 `clash-net check`。

## 完成标准

`status: recovered` 要求候选与复测均低于 200ms、公开请求成功、实际链路包含主组→自动组→所选节点、自动组的 `fixed` 和当前节点均为目标节点、主组仍指向自动组、订阅 SHA-256 未变。`public-endpoint-ok` 仅表示 check 通过。其余状态保留诊断证据，不报“Codex 已恢复”。

实现使用 [Mihomo 官方控制 API](https://wiki.metacubex.one/api/) 的代理查询、单节点延迟测试、现有主组选择与连接查询，不操作 UI 坐标。
