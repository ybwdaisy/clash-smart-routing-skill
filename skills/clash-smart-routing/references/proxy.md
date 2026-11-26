# macOS all-in-one proxy

Use this reference for terminal/GUI proxy integration, automatic App following, or upgrading an old `clash-net` installation. Public command: **proxy**. Skill/repository names stay unchanged. Node.js 18+, zsh, and one configured Clash Verge/Rev or FlClash App are required. The separately paired native Clash App uses the [native VPN adapter](clash-app.md), with explicit VPN permission and no file-based learning. Native events and GUI verification use the system Swift compiler when available; without it the manager reports `timer-fallback` and remains functional.

## Installation and update

Install/update this complete skill in a stable directory with its `yaml` dependency; a repository checkout or the host AI tool’s skill directory both work. Set `skill_dir` to the actual absolute skill path (the directory containing `SKILL.md`); the following example assumes the terminal is at the repository root. Keep exactly one supported App running with its imported subscription. Then:

```sh
skill_dir="$PWD/skills/clash-smart-routing"
npm --prefix "$skill_dir" ci --ignore-scripts --no-audit --no-fund
node "$skill_dir/scripts/proxy-cli.cjs" setup --dry-run
node "$skill_dir/scripts/proxy-cli.cjs" setup
source ~/.config/zsh/proxy.zsh
proxy status
proxy check
proxy check --gui
```

`setup` validates or installs the routing overlay for the current client, enables its native system-proxy switch if necessary, preserves existing no_proxy entries, installs a small zsh loader and one user LaunchAgent, and retires the two old automatic follower services plus the managed `clash-net` executable. It refuses unrelated command/loader/service collisions. For Verge/FlClash it does not enable TUN, change native ports, or create a relay. Native Clash requires its explicitly authorized VPN; configure any user-requested shared port through its native listener override before connecting. Discovery continues to read the actual listener ports. Configure each additional client's overlay once with `proxy config apply` (FlClash: `--activate`); afterward normal App switches need no binding commands. For a new subscription, use `proxy config verify` and apply only if missing/stale.

An independent temporary LaunchAgent protects setup. Its private journal saves affected files, file modes, prior services and launchd variables. Failure/deadline quits FlClash and restores Clash Verge, or the original client if Verge is unavailable. Setup commits only after actual public-route and, when the native helper is available, GUI probes pass. Fallback also verifies controller/public reachability and records the outcome locally. This cannot guarantee recovery from OS shutdown or an unavailable subscription. File restoration uses compare-and-swap: later user edits are reported instead of overwritten. Routing overlay backups/rollback remain client-specific.

Re-run setup after updating skill files. Existing terminals need the source command once for the old function to be replaced. Fresh terminals load it automatically. Backups and generated state remain under `~/.config/proxy` (0700/0600), never in Git.

## 全新重建

旧配置全部弃用时，使用 `proxy setup --fresh`；已有同名旧命令时先用明确的 `node .../proxy-cli.cjs setup --fresh` 入口。支持 macOS Clash Verge/Rev。先读[清理范围、备份与回退](proxy-fresh.md)，预览用 `--fresh --dry-run`，普通升级仍用 setup。

See [automatic recovery](node-recovery.md#自动检测与恢复macos) for the worker's process/log conditions. `proxy check` and `proxy recover` can be run on demand. Verify login/API/streaming behavior in the user's actual AI service.

## Commands

| Command | Behavior |
|---|---|
| `proxy` / `proxy on` | Enable automatic proxy environment in this terminal using freshly verified ports |
| `proxy off` | Sticky opt-out in this terminal, including child shells, until `proxy on`; GUI and other terminals continue |
| `proxy status` / `proxy doctor --json` | Current App, native ports, live TUN enabled/disabled/unknown and device, shell/system/launchd state, event mode, worker reports |
| `proxy check` | Check current ChatGPT public connectivity and route, no node change |
| `proxy check --gui` | Launch a fresh native URLSession process in GUI launchd domain; verify inherited variables and system-proxy/native-VPN request |
| `proxy recover` / `proxy plan` / `proxy rollback` | Existing automatic-group recovery, measurement preview, node rollback |
| `proxy auto on\|off\|status` | Toggle/report recovery worker without stopping environment integration |
| `proxy monitor on\|off\|status` | Toggle/report bounded routing-learning worker |
| `proxy config discover\|active\|plan\|apply\|verify\|rollback` | Existing routing overlay operations |
| `proxy audit` | Read-only current-traffic diagnosis |
| `proxy env --json` | Fresh verified proxy variables for another tool |
| `proxy exec -- command args...` | Run one child with fresh variables, no parent-shell change |
| `proxy export shadowrocket ...` | Existing private phone-config export |
| `proxy setup --rollback` | Restore last integration transaction and recover Clash Verge |
| `proxy uninstall` | Stop integration and restore original shell/services/environment where still owned |

Bare `proxy` enables the terminal; recovery is explicitly `proxy recover`.

## Low consumption and following

Clash Verge/Rev can move its kernel into the privileged system service when TUN is enabled. Discovery verifies the registered root helper, its root-owned kernel child, and the current UID's explicit control socket before preferring it over a stale user-mode socket. Listener ownership uses OS PID evidence; when macOS hides root sockets, a bounded loopback HEAD request must appear with the same source/destination ports in the authenticated core's connection table. This check creates no Internet traffic. Never accept an arbitrary process merely named `verge-mihomo` or a listening port alone. Test this path with `node --test scripts/test-proxy-service.cjs`.

TUN state comes from the live controller `/configs`, not a saved YAML or the existence of an `utun` interface (which could belong to OpenVPN). An unavailable value is unknown, not disabled. The status display does not enable TUN, alter VPN routes, or prove VPN coexistence; those require separate authorization and route/DNS verification. A starting client retains its identified App name and reports the concrete readiness error.


One persistent manager owns environment publication and both workers. A native NSWorkspace helper listens for App launch/termination; filesystem events track relevant settings/config changes. Events debounce 250ms. A 15-second fallback catches missed events. During a newly started App's readiness window only, polling accelerates to 250ms for at most 15 seconds. Bundle IDs are cached by Info.plist mtime. Unchanged shell/environment values are not rewritten; launchd ownership is audited once per minute. Health and learning requests remain once per minute with existing cooldowns and budgets, not every discovery tick.

Selection requires exactly one recognized App and matching bundle ID/config directory. Native Clash also counts its packet-tunnel extension after GUI exit; disconnect that VPN before switching clients. Live controller ports must have listeners owned by that App. Both Apps or neither App pauses workers and clears managed environment values; no client is guessed from a shared port or stale core. Native Apps own their system-proxy switch; if closing a client leaves stale OS proxy state, status exposes the mismatch rather than overwriting unrelated network settings. Quit the old App completely before opening the other; the manager does not launch/quit Apps during routine following.

Shell prompt/preexec hooks read the small shared env file without spawning discovery commands. Preexec tests the cached local port; if closed it discovers fresh state before running the command. `proxy on` always discovers fresh state. Manager operations strip inherited proxy variables to avoid stale-proxy loops.

HTTP/HTTPS and SOCKS ports are read separately from the active controller. Both uppercase and lowercase `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy` are synchronized. launchd writes are limited to these eight names and preserve a private baseline; unexpected manual changes cause an ownership conflict instead of overwrite.

## Dynamic hosts bypass

When the user requests direct access to local hosts mappings, merge `"noProxyHostsFile": "/etc/hosts"` into `~/.config/proxy/settings.json`, preserving its other settings and manual `noProxy` entries. The option is disabled when absent or empty. The source file is read only; no Gas Mask profile or system hosts file is edited. Use the active `/etc/hosts` rather than a saved Gas Mask profile so profile switches follow the system's current mappings.

Each refresh reads valid IPv4/IPv6 records and their aliases, ignores comments and invalid records, normalizes names to lowercase, removes trailing dots, and deduplicates them with the manual list. All active mappings qualify, including public IP mappings. Derived names are not saved into `noProxy`: removing or commenting out a record removes its bypass unless it is also manually configured. A missing source file contributes no derived entries.

The existing manager watches the source's parent directory so atomic replacements, direct edits, deletion and recreation trigger a refresh. Events use the existing 250ms debounce and 15-second fallback check. No new daemon or per-command file scan is added. The manager republishes both `no_proxy` and `NO_PROXY` to the shared shell environment and owned launchd environment. Existing terminal hooks load the update before subsequent commands; `proxy on` forces a fresh read. Existing GUI processes retain their inherited environment, and macOS system-proxy exclusions are unchanged.

After installing changed manager code, restart the existing manager through its normal update flow once. Later hosts edits require no restart or manually maintained hostname list. Verify ordinary curl without `--noproxy` reaches a hosts-mapped destination directly, and an unrelated public destination still uses the proxy. Test edits and atomic replacement using temporary hosts fixtures; do not change real hosts just to exercise the watcher or commit private mappings.

## Boundaries and evidence

System proxy covers Apps that honor macOS settings; launchctl environment affects **new processes only**. Existing GUI processes may need a restart and their own settings may override system proxy. Do not claim every App/all traffic is captured without TUN, or that an already running AI client process has inherited new variables. Never restart user Apps just to refresh environment without task authorization.

Preserve main selector → existing automatic group → fixed node. Manual main-selector changes pause recovery; Hong Kong is excluded only from recovery candidates. AI follows the main selector. Keep original subscriptions untouched and do not add an independent AI strategy.

Validate shell on/off, App/port following with distinct native ports, native GUI probe, protected failure fallback, bounded routing probes, original subscription hashes and service reports. Use small public HEAD/robots requests; no paid APIs or large downloads. A successful public endpoint does not prove authenticated operation in the user’s AI tool or measured quota savings.

## TUN and company VPN coexistence

See the repository [TUN/OpenVPN guide](https://github.com/ybwdaisy/clash-smart-routing-skill#tun-模式与-openvpn--公司内网共存) for example exclusions and address selection. These values are device-specific: inspect the actual VPN endpoint and pushed routes; never copy another user's gateway or internal subnets. `proxy status` reports live TUN state but does not automatically create or maintain VPN route exclusions. Preserve the subscription and existing exclusions; configure persistent client overrides, then verify both physical gateway and VPN routes.
