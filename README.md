# Clash / Shadowrocket 省流分流

给 AI 助手使用的代理配置与诊断工具：让国内下载、视频和内网优先直连，ChatGPT、Claude、GitHub 保持代理。使用维护中的域名/IP 分类，无需逐个添加网站。

支持 **Clash Verge / Rev（Mihomo）**、**macOS FlClash**、**原生 macOS Clash（`com.hako.network`，试验适配）**，以及 **Shadowrocket 配置生成**。需自备节点订阅，支持不同厂商；原订阅文件保留，本地分流规则优先执行。

## 交给 AI 助手配置

AI 助手通过 `SKILL.md` 获取操作说明，调用本地脚本完成配置、诊断和验证。支持 Skill 的工具可加载完整的 `skills/clash-smart-routing` 目录，也可以直接从仓库读取并使用。

将下面的话发给你的 AI 助手：

> 请读取 https://github.com/ybwdaisy/clash-smart-routing-skill 的 README，以及 skills/clash-smart-routing/SKILL.md 和相关 references；如无法读取仓库，请先克隆到本机稳定目录。按这套 Skill 配置我正在使用的 Clash Verge / Rev、FlClash、原生 Clash 或 Shadowrocket，先识别客户端和实际端口，保留原订阅、节点选择及已有设置，备份后应用并验证。不要擅自开启 TUN 或全新重建；如我已开启 TUN 且使用公司 VPN，请按本机实际 VPN 服务器 IP 和内网路由配置排除项，不照抄示例地址。不要上传我的订阅、配置或凭据。

AI 助手需要本机文件与终端权限才能执行配置；仅使用网页聊天时，可按它给出的命令在电脑执行。手机配置仍需在 Shadowrocket 中导入启用。

## 手动使用

在电脑上准备 Git、Node.js 18+、npm、curl，将仓库放在不会随意移动或清理的目录，然后运行：

```sh
git clone https://github.com/ybwdaisy/clash-smart-routing-skill.git
cd clash-smart-routing-skill
skill_dir="$PWD/skills/clash-smart-routing"
npm --prefix "$skill_dir" ci --ignore-scripts --no-audit --no-fund
```

### 电脑端：一个 `proxy` 命令（macOS）

在 Clash Verge / Rev 或 FlClash 中导入订阅，只开其中一个 App。接着在上述同一终端运行；`skill_dir` 是完整 Skill 的实际绝对路径，既可指向仓库内目录，也可指向 AI 工具安装的 Skill 目录：

```sh
node "$skill_dir/scripts/proxy-cli.cjs" setup --dry-run
node "$skill_dir/scripts/proxy-cli.cjs" setup
source ~/.config/zsh/proxy.zsh
proxy status
proxy check
proxy check --gui
```

自动配置省流分流、终端环境、系统代理和新 GUI 进程环境，并合并后台检测。以后彻底退出旧客户端、打开另一个即可自动跟随，**端口从当前 App 读取**。新增客户端需先执行一次 `proxy config apply`（FlClash 加 `--activate`）。App 启停/配置变化由事件触发，15 秒兜底检查；网络健康检测每分钟一次。

```sh
proxy                    # 开启当前终端代理
proxy off                # 只关闭当前终端，直到 proxy on
proxy status             # 当前 App、端口、TUN 开关与网卡、终端/GUI/后台状态
proxy recover            # 三站双轮筛选后选择节点，失败回退
proxy auto status        # 自动恢复状态；on/off 控制开关
proxy monitor status     # 省流学习状态；on/off 控制开关
proxy audit              # 查看当前代理大流量
proxy config verify      # 核验分流规则
```

自动恢复每分钟检测 ChatGPT、Google、GitHub；连续传输失败时，先给最多 12 个非香港候选做三站双轮检测，再切换一次到已验证的节点。预筛不改变当前节点；成功后冷却 10 分钟，失败回退并冷却 30 分钟，每小时最多 3 轮。`proxy auto status` 查看状态，`proxy auto off` 暂停。

当前后台恢复以 Codex／ChatGPT 桌面进程为运行条件，并支持 Codex 传输错误日志触发；详细条件见[自动恢复说明](skills/clash-smart-routing/references/node-recovery.md#自动检测与恢复macos)。`proxy check` / `proxy recover` 可随时手动执行。公开端点探测通过后，仍需在实际使用的 AI 服务中验证登录和请求。

保留「主组 → 自动选择 → 固定节点」习惯，AI 跟随主界面；恢复候选排除香港，失败回退原节点。安装失败由独立保护进程恢复 Clash Verge。两款 App 同时开或都关闭时暂停，不猜测客户端。GUI 使用系统代理；`launchctl` 环境只影响新进程，已运行 App 必要时需重启。Verge/FlClash 默认不开 TUN，无法接管忽略系统代理的 App；原生 Clash 是需单独授权的 VPN 模式。

安装后保持完整 Skill 和 Node.js 路径稳定；移动目录后，从新位置重跑 `setup`。更新 Skill 后也重跑 `setup`。`proxy setup --rollback` 回退上次集成，`proxy uninstall` 恢复原终端/后台配置，私有备份保留。旧 `clash-net` 命令和两个旧后台启动项会在备份后迁移。详见 [proxy 使用与边界](skills/clash-smart-routing/references/proxy.md)。

**旧配置全部弃用、用新版重建（macOS Clash Verge/Rev）：** 仅在你明确要清理旧配置时执行；以下继续使用前面定义的 `skill_dir`，新终端需先设置为实际 Skill 路径。

```sh
node "$skill_dir/scripts/proxy-cli.cjs" setup --fresh --dry-run
node "$skill_dir/scripts/proxy-cli.cjs" setup --fresh
source ~/.config/zsh/proxy.zsh
proxy on
```

先私有备份，再清理旧代理命令、环境变量、专用启动项及自定义分流/DNS 覆写，保留客户端、订阅和无关设置。完成实际网络验收才提交配置，失败自动回退。普通升级继续用 `setup`，FlClash 目前也用普通 setup。详见[全新重建](skills/clash-smart-routing/references/proxy-fresh.md)。

只配置分流、或使用其他平台时，仍可直接运行：

```sh
node "$skill_dir/scripts/clash-router.cjs" plan
node "$skill_dir/scripts/clash-router.cjs" apply
node "$skill_dir/scripts/clash-router.cjs" verify
```

原生 Clash 需首次授权 VPN、配对本机控制接口，并通过 App 导入覆写脚本，详见 [Clash 原生适配](skills/clash-smart-routing/references/clash-app.md)。它使用原生 VPN，暂不支持自动学习和 `--fresh`。首次需核验实际 ChatGPT 连通性，测速低延迟不代表 AI 可用；失败保持使用 Verge。已有配置依赖同一端口时，先在 App 中统一端口，再由 `proxy` 读取实际值。

FlClash 原生脚本适配和首次启用说明见 [FlClash 文档](skills/clash-smart-routing/references/flclash.md)。分类数据每天刷新；[分流核验](skills/clash-smart-routing/SKILL.md)与[节点恢复](skills/clash-smart-routing/references/node-recovery.md)说明保留了具体约束。

### TUN 模式：与 OpenVPN / 公司内网共存

Verge/FlClash 的安装流程默认不开 TUN。需要接管不遵循系统代理的程序时，可在客户端自行开启；`proxy status` 会从运行中的内核读取状态，例如：

```text
当前客户端：Clash Verge（自动跟随）
代理端口：HTTP 7897 / SOCKS 7897
TUN 虚拟网卡：已开启（utun10）
```

Verge/Rev 开启 TUN 后可能把内核切到系统服务模式，`proxy` 支持识别对应内核和当前用户的控制接口。显示“已开启”仅代表内核配置，不代表公司 VPN 已验证可用；取不到状态会显示“未知”。

**同时使用 OpenVPN 时，需要让 VPN 服务器和公司内网绕过 Clash TUN。** `DIRECT` 是 Clash 接到连接后的分流策略，不能替代 TUN 路由排除。请把排除项合并进客户端持久化的本地覆写，保留已有 `tun` 设置和排除项，不修改订阅原文件或临时生成的运行配置。[Mihomo 配置说明](https://wiki.metacubex.one/config/inbound/tun/#route-exclude-address)

下面全部是示例地址，**不能直接照抄为自己的配置**：

```yaml
tun:
  route-exclude-address:
    - 198.51.100.42/32  # 示例：OpenVPN 公网服务器 IPv4
    - 10.20.0.0/16     # 示例：通过 VPN 访问的公司内网
    - 10.250.0.0/24    # 示例：OpenVPN 分配的隧道网段
```

| 要填写什么 | 从哪里确认 | 怎么填 |
| --- | --- | --- |
| VPN 公网服务器 IP | OpenVPN 配置中的 `remote`，以及连接日志中的实际服务器地址 | 单个 IPv4 写 `/32`；若 `remote` 是域名，核对当前解析及实际连接 IP |
| 公司内网网段 | OpenVPN 连接后推送的路由、公司的网络说明 | 填实际网段和前缀，例如 `10.20.0.0/16`；有多个就分别添加，不要根据一个服务 IP 猜整个网段 |
| VPN 隧道网段 | OpenVPN 连接日志、推送路由 | 仅在实际配置存在该网段时添加；不要照抄别人的 `10.8.0.0/24` |

如果只知道某个内网服务的 IP，可以先对该服务添加 `/32` 排除，再核对完整内网网段。IPv6 使用实际前缀，单个地址为 `/128`。`198.51.100.42` 是文档示例，不是本项目提供的 VPN；`utun10` 也是示例，网卡编号会变化，不要固定照抄。

配置后核验：

1. 保留 OpenVPN 的内网分流配置，确认它连接成功。
2. 开启 Clash TUN，运行 `proxy status` 确认当前客户端、端口及 TUN 状态。
3. 分别运行 `route -n get <VPN服务器实际IP>` 和 `route -n get <内网服务实际IP>`（替换整个尖括号占位符）。VPN 服务器应走物理出口，内网服务应走 OpenVPN 隧道，不能被 Clash TUN 接管。
4. 实际访问一个内网服务，再检查 ChatGPT / GitHub 等代理连接；HTTP 有响应只能证明网络可达，不等于业务登录成功。

IP 已通但内部域名不通时，继续检查公司 DNS、Clash DNS 和 hosts 映射，不要一律换成公共 DNS。仅凭两个接口都叫 `utun` 不能判断冲突。

不想手动找地址，可以把这段话交给 AI 助手：

> 按 clash-smart-routing 检查这台电脑的 Clash TUN 与 OpenVPN 共存配置。从我的 OpenVPN 配置和实际连接路由中确认 VPN 服务器 IP、内网及隧道网段；备份后合并本地 TUN 排除项，保留原订阅、节点选择和其他排除项。验证 VPN 服务器走物理出口、内网走 OpenVPN、代理服务可用。不要上传配置、证书或凭据。

**目前不会自动发现或持续更新这些 VPN 排除项。** VPN 服务器 IP、公司网段变化后需要重新核对；域名对应多个服务器 IP 时也要覆盖实际使用的地址。本节针对 Verge/Rev、FlClash 的 Mihomo TUN，不直接适用于 Shadowrocket 或原生 macOS Clash 的 NetworkExtension 配置。

### Shadowrocket（小火箭）

手机可直接导入[远程省流配置](https://raw.githubusercontent.com/ybwdaisy/clash-smart-routing-skill/main/shadowrocket/smart-routing.conf)：

1. 小火箭「配置 → ＋」，粘贴上面的链接下载，点击「使用配置」。
2. 全局路由选择「配置」，首页继续选择原订阅的节点。
3. 「设置 → 自动更新 → 配置」开启后台更新，间隔 1 天；在 iOS 设置中允许小火箭后台 App 刷新。

此公开配置包含省流 DNS、国内/内网直连、AI 代理和 APNs 推送代理优化，不包含节点账号或订阅。若此前启用了旧的 APNs 模块，停用重复模块再重连。AI 跟随首页选择的节点，不会单独自动选路。

技能更新到 GitHub 后，[Actions](https://github.com/ybwdaisy/clash-smart-routing-skill/actions/workflows/publish-shadowrocket.yml) 自动测试并生成新版配置；失败时保留旧版。手机按设置拉取，**不是即时推送**；立即更新可点远程配置的「更新配置」。仅更新节点订阅不会更新分流配置，iCloud 同步也不等于拉取 GitHub 新版。

远程更新会覆盖该配置内的个人修改。已有额外 Host、重写或自定义规则时，继续用下面的私有合并导出，或先在手机建立扩展配置保存个人设置：

```sh
node "$skill_dir/scripts/shadowrocket.cjs" \
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
