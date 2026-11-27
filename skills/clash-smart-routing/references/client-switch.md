# 受保护的客户端测试（macOS）

用于用户明确要求试切 FlClash／原生 Clash，并要求失败时恢复 Clash Verge 的场景。日常 `proxy` 自动跟随不启动、不关闭客户端；更新技能也不会安装或启用这个临时守护。

如果本次任务要求“当前客户端保持不动”，只修改代码并使用隔离测试，不运行下方 capture／arm／start，不重启客户端、管理器或 VPN。

## 准备阶段保持联网

1. 保留已验证可用的 Verge。目标客户端的订阅、脚本、原生 VPN 权限、端口和内网排除项提前配置、检查。原生 Clash 必须通过自己的启动流程编译配置，不能用 `scutil --nc start` 代替。若用户要求所有 GUI 互斥，而准备目标设置需要同时打开第二个 GUI，先取得“仅打开设置、不连接 VPN”的明确例外；否则不试切。
2. 用 `proxy auto status`、`proxy monitor status` 记录本工具两个 worker 原先的开关，仅在真实切换准备阶段临时暂停它们并等现有 worker 退出。保存原值，守护退役后恢复；不停止 Codex 或其他 agent，也不安装另一套后台监控。
3. 核对用户指定的主端口与实际运行端口一致。Verge 因端口占用临时避让到另一个端口时，先查明剩余内核，不能让其他工具跟着改端口。原来继承了旧端口的进程不会随 `launchctl setenv` 更新；其临时 mixed 兼容监听必须由目标和回退内核共同保留，直到这些进程结束。快照只存本机私有目录，不能进 Git。
4. 目标设置检查完成后先关闭其 GUI／VPN，只留下可用 Verge，再 capture。原生 Clash 准备好但未连接时 `/configs` 中的端口可能为 0；应从它的设置页确认持久端口，连接后再核对运行端口。

内部脚本只供 AI 执行已授权的客户端测试，公共入口仍为 `proxy`：

```sh
node <skill-dir>/scripts/proxy-switch-guard.cjs capture clash-app --prepared
# FlClash 使用 capture flclash --prepared
# 保存输出的 directory；准备记录里不能包含未校验的 UI 或兼容监听。
node <skill-dir>/scripts/proxy-switch-guard.cjs arm <private-dir>
```

`arm` 会重新核对原 Verge 的 PID、启动时间和端口。返回 `armed`、guard PID、token 后，才可准备最后一组 UI 动作。原生 Clash 的未连接 GUI 如需打开，仍受前述显式例外约束。

**在线时定位好所有 UI 控件**：原生 Clash 的“启动”和原客户端的“退出”。开始后用同一段确定的本地操作退出旧客户端、触发目标启动，不能在旧客户端退出之后再等待一次 UI 树、截图或聊天回复。不要再次 `getApp` 或读取已经退出 App 的句柄，它可能重新启动 App。不能完成这种准备就取消，不能让现网承担调试定位。

```sh
node <skill-dir>/scripts/proxy-switch-guard.cjs start <private-dir> <token>
# start 确认 checking-target 后，立即执行已定位的 UI 动作。
# 此后先读取守护结果，不从已退出 App 的句柄判断状态。
node <skill-dir>/scripts/proxy-switch-guard.cjs status <private-dir>
```

## 单次 30 秒预算

- `start` 写入跨进程单调时钟；目标检查最多占前 10 秒，后 20 秒留给回退。重试或守护进程重启继续使用原截止时间。
- 原生 Clash 先结束本轮记录的 GUI，取消它的待启动任务，再请求停止 bundle 匹配的 VPN，并结束记录的 provider；不先等 VPN 停止再处理 GUI。停止请求超时仍继续处理已确认的 provider。只处理 PID、启动时间、可执行文件、真实／有效 UID 仍匹配的进程；拒绝接管重新出现的 GUI 或误杀复用 PID。系统小组件不算代理客户端，OpenVPN 不受影响。
- 每个命令、控制器请求和公开检查都限时，超时取消自己的 helper。失效操作的许可被撤销，不能在回退后继续写配置。确认旧 GUI／内核、原生 VPN 和共享端口退出后才打开 Verge；已有合法回退实例则复用，不重复启动或接纳新端口。
- 恢复私有快照里的实际端口、原节点组选择、临时兼容监听和原先拥有的系统代理槽位。以真实 ChatGPT／Google／GitHub 请求和兼容端口 HTTP／SOCKS 成功判定恢复；App 打开或控制器响应不代表网络恢复。
- 文件／服务集成事务先恢复网络，再做管理器、环境等清理；未验证网络则记录 `recovery-failed`，不报告“已回退”。普通 `setup` 的下载、文件事务超时与这里的客户端测试窗口不同，不把整个全新重建当作 30 秒切换测试。

订阅本身不可用、未知进程占住端口或 macOS 拒绝停止 VPN 时，预算到期明确报告失败，不假称“保证 30 秒成功”。独立守护可以脱离聊天联网运行，但不能保证外部服务和操作系统始终可用。

成功后再做 `proxy status`、`proxy check`、`proxy check --gui`、`proxy config verify` 和实际内网浏览器验证；公开检查不证明账号登录。先确认当前连接可用，再恢复原 worker 设置并退役守护：

```sh
node <skill-dir>/scripts/proxy-switch-guard.cjs retire <private-dir>
```

失败后先读私有报告、核实当前连接；不重复试切，不重新读取退出 App 的句柄。终止状态和过期 token 不能重新执行旧事务。需要再次测试时，重新核验和 capture。

## 隔离验收

`tests/proxy-cutover*.test.cjs` 覆盖固定截止时间、停止请求卡住、忽略 SIGTERM、PID 复用、未知新实例、端口冲突、延迟操作、worker 重启与网络先于清理。真实进程测试使用随机临时端口和模拟 GUI／VPN，包含协调进程退出、守护重启、10 秒冷启动及无关模拟 agent 的长连接；不会使用本机 7897／7900／9090 或真实代理客户端。
