# 全新重建代理配置（macOS Clash Verge / Rev）

用于用户明确要求“不沿用旧配置，备份后全部用新版重建”。普通更新继续用 `setup`；不要因旧文件冲突而擅自改用全新重建。FlClash 目前使用普通 setup，`--fresh` 会在修改前明确拒绝；不要对其 SQLite 或偏好套用 Verge 文件流程。

在目标电脑打开一个已导入订阅的 Clash Verge/Rev，并保持另一个代理客户端退出。用明确的 Node 入口避开旧 `proxy` 函数/别名：

```sh
node ~/.codex/skills/clash-smart-routing/scripts/proxy-cli.cjs setup --fresh --dry-run
node ~/.codex/skills/clash-smart-routing/scripts/proxy-cli.cjs setup --fresh
source ~/.config/zsh/proxy.zsh
proxy on
proxy status
```

预览不写文件、不停止服务、不清理配置。`ready: true` 表示清理范围可确定，不代表已经重建。实际执行会先启动独立回退守护并备份，再停止相关后台和客户端，完成清理、重启和新版安装。原始订阅、节点及订阅规则不编辑，端口和控制接口身份保留，其他 UI 设置和无关 shell 配置保留。

## 清理范围

- 当前用户的 `.zshrc/.zprofile/.zshenv/.zlogin`（含当前 `ZDOTDIR`）、其中可静态解析的本地 source 文件、旧 `proxy.zsh`：移除代理函数、别名、固定环境变量、旧加载和 hook。组合 export 只删除代理变量，其他变量保留。旧 loader 中无关内容继续保留。
- 用户 PATH 常见目录内的 `proxy/clash-net` 可执行文件，不要求它们已有本 skill 标记。先备份，再由新入口替代。
- 旧 skill 启动项、专用 proxy 脚本启动项及只设置代理环境的用户 LaunchAgent。客户端自身启动项、其他服务保留；混合用途任务不能整份删除。
- 当前 Verge 数据目录内所有已登记的自定义 script/merge/rules/proxies/groups 覆写：重置为中性内容，保留客户端需要的登记关系及每份订阅。
- 旧自定义 DNS/hosts、PAC 开关、代理绕过设置、启动脚本与 TUN 设置：撤销自定义值，以新系统代理模式运行，不开 TUN。原订阅自带的 DNS/hosts 仍属于订阅内容。
- 旧路由策略/归属元数据、旧 no_proxy 列表和用户 launchd 的八个大小写代理变量：按新默认配置重建。历史备份、请求预算和故障冷却记录保留，避免重建清零后绕过限额。

本流程重建代理相关设置，不卸载 App，不删除客户端数据目录，不修改其他用户、系统级 `/etc` 或 LaunchDaemon。只处理当前运行的 Verge；其他客户端不在本次清理范围。

## 备份与失败回退

所有修改/删除都纳入 `~/.config/proxy/backups/<事务>/journal.json`，原文件字节和权限私有保存。订阅只记录本机校验哈希。新路由安装的动态写入也逐次记入事务，不能靠“成功后再补备份”。临时内核缓存和历史备份不作为旧活动配置重新加载。

失败或五分钟超时会停止本次工作、退出当前 Verge、恢复文件和原环境、重新打开 Clash Verge并恢复之前加载的相关启动项。自动生成的 runtime 在客户端退出后恢复；用户后来修改的持久文件有冲突时保留并在事务报告列出。控制接口和公开连通性分别核验，故障订阅/系统关闭仍可能使回退无法联网，以报告为准。

成功后，`proxy setup --rollback` 撤销最近一次事务；私有旧文件不会自动重新加载。现有终端需 source 新 loader 并 `proxy on`，或重新打开；旧 GUI 进程的环境变量仍需通过重启该 App 更新。

## 无法自动判断的旧配置

多用途函数、混合服务、动态 source、符号链接、超出边界的路径和不支持的注册表结构会在预览中报告，尚未执行清理。不要为了让预览通过而关闭检查或整份删除 shell/服务文件。用户的全新重建请求已经授权代理相关迁移；助手应检查具体命令语义，补充可验证的定向处理及回归测试，再继续，不必重复索要“允许迁移旧 proxy”的确认。无关业务逻辑的保留边界仍然适用。

## 验证

安装提交前要求：新 manager 的 PID/状态匹配、当前监听及系统代理就绪、实际 ChatGPT 公开链路检查通过；原生辅助程序可用时，新 GUI 域 URLSession 探测也须通过；所有原始订阅文件哈希保持一致。原生客户端重新生成的原始规则必须先与原订阅一致，才能安装新 overlay。

实现测试覆盖隔离用户目录的完整编排、真实 Mihomo 加载、后期写入失败和逐文件恢复。隔离编排中的 App/GUI 适配器是模拟的，不能声称它证明了目标电脑 App 重启或真实账户网络。目标机执行后的事务验收才是该机器的证据。外部公开探测不证明 Codex 登录或流式会话成功。
