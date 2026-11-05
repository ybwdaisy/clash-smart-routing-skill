# Clash / Shadowrocket 省流分流

让国内下载、视频和内网优先直连，ChatGPT、Claude、GitHub 保持代理。使用维护中的域名/IP 分类，无需逐个添加网站。

支持 **Clash Verge / Rev（Mihomo）**、**macOS FlClash**，以及 **Shadowrocket 配置生成**。需自备节点订阅，支持不同厂商；原订阅文件保留，本地分流规则优先执行。

## 用 AI 助手配置

将下面的话发给 Codex / Claude Code：

> 从 https://github.com/ybwdaisy/clash-smart-routing-skill 安装或更新 skills/clash-smart-routing，按我使用的 Clash Verge、FlClash 或 Shadowrocket 配置省流分流，保留原订阅与已有设置，并验证结果。

## 手动使用

在电脑上准备 Node.js 18+、npm、curl，然后运行：

```sh
git clone https://github.com/ybwdaisy/clash-smart-routing-skill.git
cd clash-smart-routing-skill
npm --prefix skills/clash-smart-routing ci --ignore-scripts --no-audit --no-fund
```

### 电脑端：一个 `proxy` 命令（macOS）

把完整 Skill 安装到 `~/.codex/skills/clash-smart-routing` 后，在 Clash Verge / Rev 或 FlClash 中导入订阅，只开其中一个 App，再运行：

```sh
node ~/.codex/skills/clash-smart-routing/scripts/proxy-cli.cjs setup --dry-run
node ~/.codex/skills/clash-smart-routing/scripts/proxy-cli.cjs setup
source ~/.config/zsh/proxy.zsh
proxy status
proxy check
proxy check --gui
```

自动配置省流分流、终端环境、系统代理和新 GUI 进程环境，并合并后台检测。以后彻底退出旧客户端、打开另一个即可自动跟随，**端口从当前 App 读取**。新增客户端需先执行一次 `proxy config apply`（FlClash 加 `--activate`）。App 启停/配置变化由事件触发，15 秒兜底检查；网络健康检测每分钟一次。

```sh
proxy                    # 开启当前终端代理
proxy off                # 只关闭当前终端，直到 proxy on
proxy status             # 当前 App、端口、终端/GUI/后台状态
proxy recover            # 持续断网时，也可手动测速与恢复
proxy auto status        # 自动恢复状态；on/off 控制开关
proxy monitor status     # 省流学习状态；on/off 控制开关
proxy audit              # 查看当前代理大流量
proxy config verify      # 核验分流规则
```

保留「主组 → 自动选择 → 固定节点」习惯，AI 跟随主界面；恢复候选排除香港，失败回退原节点。安装失败由独立保护进程恢复 Clash Verge。两款 App 同时开或都关闭时暂停，不猜测客户端。GUI 使用系统代理；`launchctl` 环境只影响新进程，已运行 App 必要时需重启。默认不开 TUN，无法接管忽略系统代理的 App。

更新 Skill 后重跑 `setup`。`proxy setup --rollback` 回退上次集成，`proxy uninstall` 恢复原终端/后台配置，私有备份保留。旧 `clash-net` 命令和两个旧后台启动项会在备份后迁移。详见 [proxy 使用与边界](skills/clash-smart-routing/references/proxy.md)。

只配置分流、或使用其他平台时，仍可直接运行：

```sh
node skills/clash-smart-routing/scripts/clash-router.cjs plan
node skills/clash-smart-routing/scripts/clash-router.cjs apply
node skills/clash-smart-routing/scripts/clash-router.cjs verify
```

FlClash 原生脚本适配和首次启用说明见 [FlClash 文档](skills/clash-smart-routing/references/flclash.md)。分类数据每天刷新；[分流核验](skills/clash-smart-routing/SKILL.md)与[节点恢复](skills/clash-smart-routing/references/node-recovery.md)说明保留了具体约束。

### Shadowrocket（小火箭）

手机可直接导入[远程省流配置](https://raw.githubusercontent.com/ybwdaisy/clash-smart-routing-skill/main/shadowrocket/smart-routing.conf)：

1. 小火箭「配置 → ＋」，粘贴上面的链接下载，点击「使用配置」。
2. 全局路由选择「配置」，首页继续选择原订阅的节点。
3. 「设置 → 自动更新 → 配置」开启后台更新，间隔 1 天；在 iOS 设置中允许小火箭后台 App 刷新。

此公开配置包含省流 DNS、国内/内网直连、AI 代理和 APNs 推送代理优化，不包含节点账号或订阅。若此前启用了旧的 APNs 模块，停用重复模块再重连。AI 跟随首页选择的节点，不会单独自动选路。

技能更新到 GitHub 后，[Actions](https://github.com/ybwdaisy/clash-smart-routing-skill/actions/workflows/publish-shadowrocket.yml) 自动测试并生成新版配置；失败时保留旧版。手机按设置拉取，**不是即时推送**；立即更新可点远程配置的「更新配置」。仅更新节点订阅不会更新分流配置，iCloud 同步也不等于拉取 GitHub 新版。

远程更新会覆盖该配置内的个人修改。已有额外 Host、重写或自定义规则时，继续用下面的私有合并导出，或先在手机建立扩展配置保存个人设置：

```sh
node skills/clash-smart-routing/scripts/shadowrocket.cjs \
  --input ./original.conf --output ./smart-routing.conf \
  --dns saving --remote on
```

私有导出保留原规则、Host、重写和推送优化，输出不覆盖输入；通过 iCloud / AirDrop 导入启用，不提交到 GitHub。原节点订阅独立保留。回退时启用原配置即可。

## 使用说明

- 国内直连优先于订阅的代理决定；其余流量继续按订阅处理。
- Shadowrocket 省流模式在直连 DNS 均不可用时会访问失败，不会自动转代理消耗流量。
- 私人配置和备份请勿提交。仓库中只有经检查的公开模板、生成配置与来源清单；公开生成数据含 Sukka 的 AGPL-3.0 规则，附来源及许可证。
- 已验证 macOS / Mihomo；手机配置通过生成检查，仍需在实际设备验证路由和推送。

详细操作见 [Skill](skills/clash-smart-routing/SKILL.md) 和 [Shadowrocket 说明](skills/clash-smart-routing/references/shadowrocket.md)。分类来源：[MetaCubeX](https://github.com/MetaCubeX/meta-rules-dat)、[blackmatrix7](https://github.com/blackmatrix7/ios_rule_script)、[ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)、[Sukka](https://github.com/SukkaW/Surge)（下载 CDN 数据，AGPL-3.0）。
