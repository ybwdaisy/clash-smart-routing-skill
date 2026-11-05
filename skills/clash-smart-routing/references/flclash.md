# FlClash 原生适配（macOS）

适配并实机验证的版本：FlClash 0.9.2，应用位于 `/Applications/FlClash.app`，数据目录为 `~/Library/Application Support/com.follow.clash`。目前不承诺 Windows、Linux 或其他版本数据库兼容。

## 应用与切换客户端

```sh
clash-net config discover
clash-net config plan --config-dir "$HOME/Library/Application Support/com.follow.clash"
clash-net config apply --config-dir "$HOME/Library/Application Support/com.follow.clash" --activate
clash-net config verify
clash-net check
```

首次在 FlClash 界面完成订阅导入与已有条款确认。`plan` 只读；`apply` 会正常退出客户端、备份 SQLite 数据库及原生偏好、注册该订阅的脚本覆写、重启并验证。保留原订阅 URL、源文件及全部原规则的相对顺序；已有原生脚本先执行，省流规则随后合并。订阅更新时由客户端再次运行覆写，不依赖修改临时 `config.yaml`。

FlClash 0.9.2 的控制接口使用原生支持的 `127.0.0.1:9090`，保留已有密钥或生成随机密钥；端口被其他服务占用则停止。`--activate` 明确开启系统代理与客户端自动运行内核，默认不改这两个开关。不会替用户接受新的条款，不修改 DNS、TUN 或订阅节点定义。若原生「标准覆写」已有额外规则或 MATCH 替换，则要求先明确迁移，避免切到脚本模式后静默失效。

控制接口就绪早于 macOS 系统代理设置完成，不能在 API 首次响应时立刻判定接管失败。显式激活后按实际 `mixed-port` 限时等待 HTTP、HTTPS、SOCKS 三项均指向本地端口且监听可连接，再验证公开请求；默认等待上限 15 秒，失败触发回退。原生 `patchClashConfig` 的 `mixed-port` 是持久端口设置，不能把生成的 YAML 当作持久修改入口，也不要假定混合端口总是 7890。若要兼容既有终端 `proxy` 命令，先读取它的真实端口并核对，不猜测 7897/7987；两个客户端统一端口时必须保持互斥运行。

macOS 多客户端共存时默认自动识别当前唯一运行的 App，通过进程路径和 bundle ID 确定配置目录。`clash-net config active` 可查看；两个都开或都关时暂停，不按端口猜测。旧 `select` 记录不会覆盖自动识别。明确传入 `--config-dir` 时才固定目标。

用户要求从 Verge 试切 FlClash 时，先保存仍可用的 Verge 节点、系统代理和后台绑定，并启动独立于聊天联网的本地回退守护。脚本失败或切换超时就退出 FlClash、恢复 Verge；目标实际连通且绑定核验通过才撤销守护。回退后确认只运行 Verge，公开请求和系统代理均恢复，再考虑后续试验。

## 保留自动组使用习惯

在界面保持「主选择组 → 原有自动选择组」。恢复流程只固定自动组内节点；用户手动切走主组时暂停。不同订阅厂商的组名通过原 MATCH 规则和运行时组结构识别，不写死名称。

若用户明确要求建立该层级，可在 `apply` 加 `--adopt-hierarchy`。只在主组包含唯一 URLTest 子组、当前节点属于该组时迁移，先固定同一个出口；无法确定则拒绝猜测。没有此参数时保留原选择。恢复后的固定节点属于内核运行时设置，重启后的选择由客户端自身持久化机制决定；后台检测会重新核对层级。

```sh
clash-net auto off
# 若原先启用省流学习，先用旧目录运行 routing-monitor.cjs uninstall。
node <skill-dir>/scripts/routing-monitor.cjs install
clash-net auto on
clash-net auto status
```

学习监控与自动恢复只在用户已授权对应后台能力时迁移，不因安装客户端自动新增任务。FlClash 的学习文件使用客户端实际生成的受限缓存路径，不写 Verge 的路径。实机测试前正常退出另一个代理客户端，并确认其用户内核退出；随后检查系统代理仍指向测试客户端的实际端口。仅指定 `--config-dir` 无法防止另一个 App 改写系统代理。

上述默认安装会把旧的固定 LaunchAgent 更新为自动跟随。父进程约每 2 秒识别一次；切换时先停止旧子进程并清理其临时学习文件，再运行新子进程。故障冷却、预算和报告仍分别保存在各客户端目录中。不会因为检测到新客户端而自动安装缺失规则或启动它；控制接口、覆写尚未就绪时暂停，配置完成后自行恢复。日志与跟随状态在 `~/.config/clash-net/follow-*.json`，尊重 `XDG_CONFIG_HOME`。

## 校验与回退

先用独立 FlClashCore 子进程的原生 IPC `validateConfig` 校验，再用真实客户端加载后核对规则、分类数量及单引用代理链。公开连通性检查与路由命中分别报告；HTTP 错误不代表路由错误，公开端点成功不代表 Codex 登录请求正常。

备份位于数据目录的 `smart-routing-state/flclash-backup-*`，权限仅当前用户可读，包含私密信息，禁止提交。配置/校验失败会回退本次数据库、偏好和脚本修改。回退基础规则前先停止自动恢复与学习服务：

```sh
clash-net auto off
node <skill-dir>/scripts/routing-monitor.cjs uninstall --config-dir "$HOME/Library/Application Support/com.follow.clash"
clash-net config rollback --config-dir "$HOME/Library/Application Support/com.follow.clash"
```

显式回退只撤销本工具仍拥有的脚本绑定和偏好，保留后来人工改动；检测到脚本被改或绑定变化就停止，不覆盖用户设置。数据库恢复只能在客户端退出后执行，保留备份以供排障。回退 FlClash 后，若需继续使用 Verge，应明确切换系统代理并重新 `select` 旧目录。
