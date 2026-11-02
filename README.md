# Clash / Shadowrocket 省流分流

让国内下载、视频和内网优先直连，ChatGPT、Claude、GitHub 保持代理。使用维护中的域名/IP 分类，无需逐个添加网站。

支持 **Clash Verge / Rev（Mihomo）**，以及 **Shadowrocket 配置生成**。需自备节点订阅；原订阅文件保留，本地分流规则优先执行。

## 用 AI 助手配置

将下面的话发给 Codex / Claude Code：

> 从 https://github.com/ybwdaisy/clash-smart-routing-skill 安装或更新 skills/clash-smart-routing，按我使用的 Clash Verge 或 Shadowrocket 配置省流分流，保留原订阅与已有设置，并验证结果。

## 手动使用

在电脑上准备 Node.js 18+、npm、curl，然后运行：

```sh
git clone https://github.com/ybwdaisy/clash-smart-routing-skill.git
cd clash-smart-routing-skill
npm --prefix skills/clash-smart-routing ci --ignore-scripts --no-audit --no-fund
```

### Clash Verge / Rev

保持客户端运行，依次预览、应用和核验：

```sh
node skills/clash-smart-routing/scripts/clash-router.cjs plan
node skills/clash-smart-routing/scripts/clash-router.cjs apply
node skills/clash-smart-routing/scripts/clash-router.cjs verify
```

AI 跟随主界面的节点选择，不单独自动选节点。运行 `node skills/clash-smart-routing/scripts/probe.cjs` 可检查 ChatGPT 实际连通性和请求耗时，检测失败不会切换线路。

分类数据每天刷新。更新功能时，在仓库执行 `git pull --ff-only`，重新安装依赖，再执行 `apply` 和 `verify`。

按需检查代理大流量：`node skills/clash-smart-routing/scripts/traffic-audit.cjs`。回滚上次应用：`node skills/clash-smart-routing/scripts/clash-router.cjs rollback`。

macOS 可开启后台检测与谨慎学习，无需 MCP：

```sh
node skills/clash-smart-routing/scripts/routing-monitor.cjs install
node skills/clash-smart-routing/scripts/routing-monitor.cjs status
```

每分钟检查一次；只对订阅兜底的未知 HTTPS 连接做少量直连验证，两次通过后添加限定域名/IP 的临时规则。AI、GitHub、推送和订阅明确指定的境外代理规则排除在学习之外。TUN 开启时暂停学习。停止并清空学习结果用 `routing-monitor.cjs uninstall`；回滚前先停止检测。详见[检测说明](skills/clash-smart-routing/references/monitor.md)。

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
