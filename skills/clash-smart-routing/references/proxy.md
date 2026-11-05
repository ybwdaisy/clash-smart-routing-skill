# macOS all-in-one proxy

Use this reference for terminal/GUI proxy integration, automatic App following, or upgrading an old `clash-net` installation. Public command: **proxy**. Skill/repository names stay unchanged. Node.js 18+, zsh, and one configured Clash Verge/Rev or FlClash App are required. Native events and GUI verification use the system Swift compiler when available; without it the manager reports `timer-fallback` and remains functional.

## Installation and update

Install/update this complete skill into `~/.codex/skills/clash-smart-routing` with its `yaml` dependency. Keep exactly one supported App running with its imported subscription. Then:

```sh
node ~/.codex/skills/clash-smart-routing/scripts/proxy-cli.cjs setup --dry-run
node ~/.codex/skills/clash-smart-routing/scripts/proxy-cli.cjs setup
source ~/.config/zsh/proxy.zsh
proxy status
proxy check
proxy check --gui
```

`setup` validates or installs the routing overlay for the current client, enables its native system-proxy switch if necessary, preserves existing no_proxy entries, installs a small zsh loader and one user LaunchAgent, and retires the two old automatic follower services plus the managed `clash-net` executable. It refuses unrelated command/loader/service collisions. It does not enable TUN, change native ports, or create a relay. Configure each additional client's overlay once with `proxy config apply` (FlClash: `--activate`); afterward normal App switches need no binding commands. For a new subscription, use `proxy config verify` and apply only if missing/stale.

An independent temporary LaunchAgent protects setup. Its private journal saves affected files, file modes, prior services and launchd variables. Failure/deadline quits FlClash and restores Clash Verge, or the original client if Verge is unavailable. Setup commits only after actual public-route and, when the native helper is available, GUI probes pass. Fallback also verifies controller/public reachability and records the outcome locally. This cannot guarantee recovery from OS shutdown or an unavailable subscription. File restoration uses compare-and-swap: later user edits are reported instead of overwritten. Routing overlay backups/rollback remain client-specific.

Re-run setup after updating skill files. Existing terminals need the source command once for the old function to be replaced. Fresh terminals load it automatically. Backups and generated state remain under `~/.config/proxy` (0700/0600), never in Git.

## Commands

| Command | Behavior |
|---|---|
| `proxy` / `proxy on` | Enable automatic proxy environment in this terminal using freshly verified ports |
| `proxy off` | Sticky opt-out in this terminal, including child shells, until `proxy on`; GUI and other terminals continue |
| `proxy status` / `proxy doctor --json` | Current App, native ports, shell/system/launchd state, event mode, worker reports |
| `proxy check` | Check current ChatGPT public connectivity and route, no node change |
| `proxy check --gui` | Launch a fresh native URLSession process in GUI launchd domain; verify inherited variables and system-proxy request |
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

One persistent manager owns environment publication and both workers. A native NSWorkspace helper listens for App launch/termination; filesystem events track relevant settings/config changes. Events debounce 250ms. A 15-second fallback catches missed events. During a newly started App's readiness window only, polling accelerates to 250ms for at most 15 seconds. Bundle IDs are cached by Info.plist mtime. Unchanged shell/environment values are not rewritten; launchd ownership is audited once per minute. Health and learning requests remain once per minute with existing cooldowns and budgets, not every discovery tick.

Selection requires exactly one recognized GUI process and matching bundle ID/config directory. Live controller ports must have listeners owned by that App. Both Apps or neither App pauses workers and clears managed environment values; no client is guessed from a shared port or stale core. Native Apps own their system-proxy switch; if closing a client leaves stale OS proxy state, status exposes the mismatch rather than overwriting unrelated network settings. Quit the old App completely before opening the other; the manager does not launch/quit Apps during routine following.

Shell prompt/preexec hooks read the small shared env file without spawning discovery commands. Preexec tests the cached local port; if closed it discovers fresh state before running the command. `proxy on` always discovers fresh state. Manager operations strip inherited proxy variables to avoid stale-proxy loops.

HTTP/HTTPS and SOCKS ports are read separately from the active controller. Both uppercase and lowercase `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy` are synchronized. launchd writes are limited to these eight names and preserve a private baseline; unexpected manual changes cause an ownership conflict instead of overwrite.

## Boundaries and evidence

System proxy covers Apps that honor macOS settings; launchctl environment affects **new processes only**. Existing GUI processes may need a restart and their own settings may override system proxy. Do not claim every App/all traffic is captured without TUN, or that an already running Codex process has inherited new variables. Never restart user Apps just to refresh environment without task authorization.

Preserve main selector → existing automatic group → fixed node. Manual main-selector changes pause recovery; Hong Kong is excluded only from recovery candidates. AI follows the main selector. Keep original subscriptions untouched and do not add an independent AI strategy.

Validate shell on/off, App/port following with distinct native ports, native GUI probe, protected failure fallback, bounded routing probes, original subscription hashes and service reports. Use small public HEAD/robots requests; no paid APIs or large downloads. A successful public endpoint does not prove authenticated Codex operation or measured quota savings.
