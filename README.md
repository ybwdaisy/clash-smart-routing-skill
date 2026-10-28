# Clash 智能省流分流 Skill

给多台设备使用的 Codex / Claude Code Skill。Clash Verge / Rev 支持自动配置与验证；Shadowrocket 支持保留原规则的 `.conf` 导出。设备使用自己的机场订阅，不用复制订阅或手工维护域名清单。

## Shadowrocket（小火箭）

已提供独立的配置导出适配器；不是把 Clash 的 YAML / MRS / JavaScript 直接导入小火箭。

```sh
node skills/clash-smart-routing/scripts/shadowrocket.cjs \
  --input /private/path/original.conf \
  --output /private/path/new-smart-routing.conf
```

原文件不变；新配置保留原有规则顺序、其他配置段及 FINAL 兜底，加入 AI 代理、内网/百度/iCloud/Apple 下载直连，并在原 FINAL 前加入国内兜底。没有完整配置、只有节点订阅时，可以省略 `--input` 生成最小示例；这不能代替迁移你已有的完整规则。

通过文件/iCloud Drive 私下导入 Shadowrocket，启用新配置和配置分流，选择真实代理节点，再查看连接记录验证。完整 `.conf` 可能包含密码，只保存在本地，不上传仓库；私有 GitHub 地址不能直接当作匿名配置订阅链接。

**更新区别：**国内分类引用维护者的远程列表，由客户端刷新；其余分类从与 Clash 相同的 MetaCubeX 来源在每次导出时刷新，是配置快照，手机不会自动刷新这部分。原订阅完整配置若更新，需以更新后的源文件重新导出。回滚时选择原配置即可。

目前已通过导出、格式转换、重复导出、规则保留和防覆盖测试，尚未进行 Shadowrocket 内核/iPhone 实机验收。详细步骤见 [Shadowrocket 适配说明](skills/clash-smart-routing/references/shadowrocket.md)。

## 在另一台设备使用

对 Codex 说：

> 从 GitHub 仓库 ybwdaisy/clash-smart-routing-skill 安装 skills/clash-smart-routing，然后用它配置并验证本机 Clash 的省流分流。

仓库若为私有，设备上的 GitHub 连接需要能够访问它。也可以克隆后把 `skills/clash-smart-routing` 放入 `~/.codex/skills/`，Claude Code 使用 `~/.claude/skills/`。启用新安装的 Skill 后，调用 `$clash-smart-routing`（Claude Code 可按其 Skill 调用方式执行）。

## 策略

| 优先级 | 流量 | 处理 |
|---|---|---|
| 1 | ChatGPT / Claude / 其他境外 AI、Apple Intelligence、GitHub | 独立代理组，禁止 DIRECT 兜底 |
| 2 | 内网域名、实际解析到私有 IPv4 / IPv6 的域名 | 直连 |
| 3 | 百度网盘、iCloud、Apple 开发下载与系统更新 | 维护中的服务分类直连 |
| 4 | 订阅原有规则 | 完整保留，顺序不变 |
| 5 | 前面未匹配的国内域名与国内 IP | 自动直连 |
| 6 | 其余流量 | 原订阅 MATCH 兜底 |

“保留订阅”指不修改订阅文件、删除或重排规则。你指定的 AI / 内网 / 大文件服务有独立高优先级覆盖层；其他订阅显式代理/拒绝规则仍优先于国内兜底。规则集每天更新，代理节点和配置目录按设备识别。

这是分类与路由策略，不会探测所有网站是否被 GFW 拦截；也不会通过 DIRECT 静默绕过 AI 代理故障。节点地区和账号权限仍会影响 AI 服务是否可用。

## 手动运行

需要 Node.js 18+、npm、curl、Clash Verge / Rev（Mihomo），以及可访问的本机控制接口（Unix socket 或 HTTP）。macOS、Windows、Linux 有常见配置目录探测；本机安装和内核验证见测试记录，其他平台需要在真实设备验收。

```sh
npm --prefix skills/clash-smart-routing ci --ignore-scripts --no-audit --no-fund
node skills/clash-smart-routing/scripts/clash-router.cjs discover
node skills/clash-smart-routing/scripts/clash-router.cjs plan
node skills/clash-smart-routing/scripts/clash-router.cjs apply
node skills/clash-smart-routing/scripts/clash-router.cjs verify
node skills/clash-smart-routing/scripts/probe.cjs
# 恢复上一次安装前状态
node skills/clash-smart-routing/scripts/clash-router.cjs rollback
```

多个客户端时加 `--config-dir "实际配置目录"`，找不到内核时加 `--core "mihomo路径"`。设备专属内网域名可通过本机 JSON 文件 `--settings-file` 的 `intranetDomains` 数组补充；正常解析到私有 IP 的域名无需逐个添加。

备份、候选配置和本机设置仅写入客户端配置目录的 `smart-routing-state`，不会上传 GitHub。现有全局脚本会先执行，再叠加新策略。验证失败恢复原配置；订阅后来更新过则不恢复过时节点，按 Skill 的恢复说明处理。

## 开发验证

```sh
node --test tests/*.test.cjs
```

测试覆盖规则完整保留、AI 无直连兜底、Apple AI 与 iCloud 优先级、节点切换、重复安装、现有脚本组合和无 MATCH 场景。本机 macOS / Mihomo v1.19.33 已完成内核校验和 7 类真实连接验证：OpenAI、Claude、GitHub 代理；百度网盘、iCloud、Apple 开发下载、私有 IP 直连。只发小请求，未实际下载多 GB 文件；Apple 测试地址返回 403，但连接链确认直连。其他设备安装后用 `probe.cjs` 验收，订阅更新后的客户端持久化仍需实机复查。

使用上游维护的 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) 分类，通过 URL 引用，不打包规则数据。路由语义以 [Mihomo 文档](https://wiki.metacubex.one/en/config/rules/) 和 [Clash Verge 扩展执行顺序](https://www.clashverge.dev/guide/extend.html) 为准。
