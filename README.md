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

分类数据每天刷新。更新功能时，在仓库执行 `git pull --ff-only`，重新安装依赖，再执行 `apply` 和 `verify`。

按需检查代理大流量：`node skills/clash-smart-routing/scripts/traffic-audit.cjs`。回滚上次应用：`node skills/clash-smart-routing/scripts/clash-router.cjs rollback`。

### Shadowrocket（小火箭）

先从手机导出当前配置，在电脑上保存为 `original.conf`，再生成合并版：

```sh
node skills/clash-smart-routing/scripts/shadowrocket.cjs \
  --input ./original.conf --output ./smart-routing.conf \
  --dns saving --remote on
```

原文件不覆盖，保留原规则、Host、重写和已有 APNs 推送代理例外。省流模式改用国内加密 DNS、系统 DNS 备用，并关闭直连解析失败后转代理。

手机端只需设置一次：

1. 通过 iCloud / AirDrop 传入 `smart-routing.conf`，导入小火箭并启用。
2. 全局路由选择「配置」，继续使用原订阅节点。
3. 若生成结果中 `apnsProxyProtected` 为 `true`，停用重复的旧 APNs 模块，然后重连。
4. 在「设置 → 自动更新 → 配置」开启后台更新，间隔 1 天，并允许 iOS 后台 App 刷新。

远程分类由小火箭刷新；静态规则随重新生成配置更新。配置可通过 iCloud 同步。需要回退时，启用原配置即可。

## 使用说明

- 国内直连优先于订阅的代理决定；其余流量继续按订阅处理。
- Shadowrocket 省流模式在直连 DNS 均不可用时会访问失败，不会自动转代理消耗流量。
- 原配置可能含节点凭据，生成文件和备份请勿提交到公开仓库。
- 已验证 macOS / Mihomo；手机配置通过生成检查，仍需在实际设备验证路由和推送。

详细操作见 [Skill](skills/clash-smart-routing/SKILL.md) 和 [Shadowrocket 说明](skills/clash-smart-routing/references/shadowrocket.md)。分类来源：[MetaCubeX](https://github.com/MetaCubeX/meta-rules-dat)、[blackmatrix7](https://github.com/blackmatrix7/ios_rule_script)、[ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)、[Sukka](https://github.com/SukkaW/Surge)（下载 CDN 数据，AGPL-3.0）。
