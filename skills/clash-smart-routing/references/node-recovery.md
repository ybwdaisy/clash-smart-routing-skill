> macOS 一体化安装使用 [proxy](proxy.md)，以下底层脚本/独立服务说明用于诊断；不要与统一管理器同时安装旧服务。

# Codex 连不上网：按需恢复主节点

复现用户的日常操作：保持「节点选择 → 自动选择」，在自动组中测速，排除香港，比较其余地区的可用节点，直接针对候选节点检测 ChatGPT、Google、GitHub，筛选后将响应更稳的节点固定在自动组内并复测。新加坡等其他地区也参与，不再限定日本、台湾、美国。原省流分流和 AI 跟随主选择的关系保留。

## 使用

Clash Verge、已完成[原生适配](flclash.md)的 macOS FlClash，或已配对的[原生 Clash](clash-app.md)保持运行，需 Node.js 18+、curl 和本技能现有的 yaml 依赖。断网时直接在本机终端执行，无需先让 Codex 联网。

```sh
# 不切换：检查当前节点的 ChatGPT / Google / GitHub 公开端点与实际连接链路
node <skill-dir>/scripts/node-recovery.cjs check

# 测速及三站双轮筛选预览，不执行选择操作
node <skill-dir>/scripts/node-recovery.cjs plan

# 测速、选择主节点、核验；失败时回退并停止
node <skill-dir>/scripts/node-recovery.cjs recover

# 查看最近一次结果；恢复上次 recover 前的固定节点或自动模式
node <skill-dir>/scripts/node-recovery.cjs status
node <skill-dir>/scripts/node-recovery.cjs rollback
```

macOS 默认自动跟随唯一运行的客户端，双开或全关时暂停；`proxy config active` 查看识别结果。手动诊断可加 `--config-dir <实际目录>`，其他平台仍支持保存目录；自动选择组不能唯一确定时加 `--latency-group <现有组名>`。不猜客户端、组名或测速地址。

## 执行约定

- 主组必须是原 MATCH 指向的手动选择组，且当前指向现有的 URLTest 自动组。只取自动组里的真实节点，不要求这些节点也出现在主组列表里；香港标记优先排除，其他地区及未标注地区的节点均可参与。过滤基于订阅名称，不能证明节点真实出口位置。主组当前选到其他组或具体节点时暂停，不擅自改变主组选择。
- 沿用自动组现有 `testUrl` 做初筛，不修改其配置。每节点超时 5 秒、最多并发 6 个、候选上限 256；失败和零延迟不参与排名。取有响应的前 12 个候选继续筛选；没有响应候选时保留当前选择。200ms 仅作绿灯参考，不把更高延迟的可用节点排除。
- 对每个入围节点直接调用 `/proxies/<节点>/delay`，分别检查 ChatGPT robots（预期 200）、Google generate_204（预期 204）和 GitHub robots（预期 200），传入 `expected`，并读取节点的 `extra[url]` 新鲜历史，要求 `alive: true` 且末次延迟非零来确认状态匹配。单看 `/delay` 的非零值不足以证明 HTTP 状态正确：Mihomo 即使状态不匹配也可能返回延迟，但会在对应 URL 的历史中记为失败。每个请求超时 7 秒，最多同时检查 2 个节点、每节点 3 个站点，总并发不超过 6。三站均成功后间隔至少 150ms 再做第二轮；任一轮失败淘汰。整个筛选阶段不切换当前组，不下载大文件。
- 对双轮均通过的节点，先比较六次响应中最慢的一次，再比较平均响应及原测速值。这里的“最佳”仅指本轮最多 12 个已筛选候选，不能保证全订阅或后续时刻最快。无三站均可用的候选就保持原节点，不试着切换一串坏节点。
- `recover` 只在筛选完成后对自动组发一次选择请求，更新其 `fixed` 节点。主界面「节点选择」仍然选中「自动选择」，AI 与其他跟随主组的流量共同经过这条链路。自动组定义、节点清单、测速 URL 和间隔均不改。
- 单节点测速使用 `/proxies/<node>/delay`，避免调用会清除 `fixed` 的 `/group/<group>/delay` 整组测速接口。用户在 UI 主动做整组测速后，固定状态仍可能被客户端清除；脚本不拦截该操作。
- 切换后用原测速 URL 复测主选择，并经本机代理再次访问三站，分别要求 HTTP 200 / 204 / 200（有界 Range GET 正确返回 206 也可，HEAD 仍要求精确状态）、TLS 成功，在 `/connections` 里按每次探测源端口核对主组、自动组及目标节点链路。原 URL 的复测值仅用于诊断，不因单次超过 200ms 或该测速地址失败而推翻三站均通过的结果。测速值和 ChatGPT TLS/总耗时分别报告。首页测速 URL 未明确配置时，不声称与首页绿灯完全相同。
- 公开请求不携带账号、Cookie、密钥或付费 API 请求；不验证 Codex 的登录、模型请求或流式响应。公开端点成功后仍需回到 Codex 发一条消息验证实际使用。
- 检查失败只回退这次自动组的固定状态并停止，不尝试其他节点或区域：原来有固定节点就恢复它，原来没有固定节点则用 DELETE 清除这次固定，不把原来的自动模式变成手动固定。用户期间改过主组或固定节点时不覆盖。不会断开已有连接、重启应用、修改系统代理、订阅、DNS、规则或安装定时任务。已有长连接可能需要由应用自行重连。

`smart-routing-state/node-recovery-latest.json` 保存最近一次执行结果，`node-recovery-undo.json` 保存上次变更前自动组的固定状态；文件权限为 600，含真实节点名，仅本机保存，不提交 GitHub。并发锁防止重复执行。进程被强制杀死时可能留下锁；确认锁里 PID 已退出后再移除锁，先检查当前选择，需要时执行 `rollback`。

回滚记录使用 version 2，保存主组/自动组身份及此前的 `fixed` 状态。旧版直接更改主组的 version 1 记录不再执行，避免将主组改离自动组。

## 自动检测与恢复（macOS）

仅在用户明确要求自动检测和恢复时启用：

```sh
proxy auto on
proxy auto status
proxy auto off
```

由统一 `proxy-manager` 管理本地恢复子进程，App 启停事件触发跟随，15 秒兜底；实际联网检查每 60 秒一次。它不调用模型，也不依赖 Codex 先恢复联网。需要保持已安装技能及 Node 路径稳定。旧独立 LaunchAgent 由 `proxy setup` 备份并迁移。

- 每 60 秒检查一次，仅在 Codex／ChatGPT 桌面进程运行、Clash 控制接口可用、处于 Rule 模式且主组指向自动组并能解析到真实节点时探测。应用关闭、Clash 关闭、主组另选节点/其他组、手动 DIRECT、其他模式或手动恢复任务占用时暂停；不自动开关应用或代理。
- 常规检测每分钟分别向 ChatGPT、Google、GitHub 发小型 HTTPS HEAD 请求，不下载正文。连续两次检测出现任一站传输失败，才调用一次升级后的 `recover`。HTTP 401/403/429/5xx 等服务响应本身不会触发换节点；本地 curl／代理端口不可用或链路证据缺失时暂停处理，不把它们当作节点故障。
- 另从 `~/.codex/logs_2.sqlite` 只读查询 `codex_core::responses_retry` 的 WARN/ERROR，识别 TLS 中断、连接重置、请求发送失败等具体传输错误。90 秒内至少两条、时间相隔至少 5 秒且未处理的新错误，可在公开端点仍可达时触发恢复。排除登录、额度、限流和服务端错误。首次运行只记录日志游标，不追溯旧错误；数据库不存在、结构变化或不可读时保留公开探测能力，不声称覆盖全部 Codex 故障。
- 仅保存日志 ID、时间及错误类别，不保存原始日志、会话内容或凭据，不读取 `auth.json`。主节点发生变化时清除上一节点的失败证据，避免立即覆盖手动选择。
- 成功后冷却 10 分钟，失败后冷却 30 分钟，滚动一小时最多 3 次。尝试预算在执行前写入本机文件，重启不清零。每轮先无切换地筛选最多 12 个候选，实际只选择一次。自动恢复本轮排除刚出故障的当前节点，以便处理公开端点仍通但 Codex 持续断流的情况；失败仍回退原节点并停止，不循环切换。
- 正常检查不弹通知；自动切换完成或恢复失败时尝试发送本机通知。通知是否显示取决于 macOS 权限，以状态报告为准。

状态与报告位于 `smart-routing-state/node-watchdog-state.json`、`node-watchdog-report.json`、`node-watchdog-last-recovery.json`，权限均为 600。`status` 显示服务状态和最近检查；需同时确认服务 running、报告时间新鲜以及实际 probe 结果。安装成功不等于经历过真实断网后的自动恢复。

快捷命令为 `proxy`。单次恢复用 `proxy recover`，只检查用 `proxy check`。`proxy auto off` 只停恢复 worker，当前节点、省流规则、终端和 GUI 环境同步继续；`proxy off` 仅关闭当前终端。安装及回退见 [proxy](proxy.md)。

## 完成标准

`status: recovered` 要求三站双轮筛选与切换后三站请求成功、实际链路包含主组→自动组→所选节点、自动组的 `fixed` 和当前节点均为目标节点、主组仍指向自动组、订阅 SHA-256 未变（原生 Clash 仅有运行时观察快照，应报告 observedPolicyUnchanged，不宣称读过原生订阅文件）。`public-endpoint-ok` 仅表示 check 通过。其余状态保留诊断证据，不报“Codex 已恢复”。

实现使用 [Mihomo 官方控制 API](https://wiki.metacubex.one/api/) 的代理查询、单节点延迟测试、现有主组选择与连接查询，不操作 UI 坐标。

HTTP 预期状态核验依据：[Mihomo URLTest 实现](https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/adapter.go)。缺少 URL 独立历史或历史过期时停止资格确认，不把该候选当作合格节点。
