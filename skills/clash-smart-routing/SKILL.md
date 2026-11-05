---
name: clash-smart-routing
description: Configure traffic-saving routing for Clash Verge/Rev and macOS FlClash, diagnose proxy waste, recover Codex connectivity inside the existing automatic group on demand or with an explicitly enabled watchdog, or export Shadowrocket configs preserving original rules and push settings. Keep subscription sources intact.
---

# Clash Smart Routing

Configure each device through the same maintained overlay, without exporting subscription secrets or asking the user to edit domain lists.

For **macOS FlClash**, read [native integration and client selection](references/flclash.md) before applying. Its SQLite profile registry, native scripts, preference/controller setup and kernel validation differ from Verge. Do not edit generated runtime YAML as the persistent solution or invoke FlClashCore with Mihomo CLI flags.

For **Shadowrocket**, read [remote configuration, private export and device verification](references/shadowrocket.md). A reviewed public remote `.conf` is automatically rebuilt by GitHub Actions after skill changes. Existing private settings still require the separate merger or a local extension. The Clash install/controller workflow below does not apply; publication is not proof of phone activation or background updates.

When preserving phone settings or notification optimization, merge the actual exported `.conf`, not a generic template. For the requested traffic-saving update, use `--dns saving --remote on`: this explicitly replaces only three DNS/rollback settings, adds validated domain-only remote classifications, and retains static AI/APNs guards. Do not claim the phone configured its background updates automatically. The exporter detects original APNs PROXY intent and protects it before Apple/CN DIRECT; the Shadowrocket reference explains conflicting policies and independently enabled old modules.

## Policy

Apply these priorities through a separate global script; preserve every original subscription rule and its relative order:

1. Foreign AI services (including OpenAI, Claude, Apple Intelligence) and GitHub follow the user’s existing main proxy selector through a single-reference alias. Do not choose a separate AI node. Recovery preserves main selector -> existing automatic group, updating only that group's runtime fixed node. Recovery is on demand unless the user explicitly enables the local watchdog described below.
2. Intranet domain categories and private IPv4/IPv6 destinations go direct. Private-IP rules deliberately resolve domains, including public-looking names mapped to VPN/private IPs.
3. Maintained service categories cover large downloads such as Baidu/iCloud/Apple developer downloads and updates, plus Sukka's China-specific Apple/Microsoft CDN classifications. These are examples, not the complete supported app list.
4. All maintained China domains and China IP destinations go direct BEFORE subscription rules, including a newly seen video CDN hostname resolving to a China IP.
5. If the optional computer monitor is enabled, its temporary exact endpoint rules follow the classification rules. It only learns HTTPS traffic that reached the subscription fallback; explicit foreign subscription routes are excluded.
6. Run the existing subscription rules for remaining traffic.
7. Keep the original subscription fallback. Never replace it with DIRECT.

Preserving the subscription means leaving its file and original relative rule order intact; it does not mean giving its proxy decisions priority over domestic DIRECT. The goal is preventing expensive domestic downloads/video from consuming proxy quota. The local domestic overlay deliberately outranks subscription rules. AI remains ahead of all DIRECT classification. Judge each destination by domain/IP rather than exempting an entire app or routing by file size.

Read [policy and verification notes](references/policy.md) for diagnosis, DNS limitations or rollback after a subscription update.

## Install on this device

Use the skill directory as `<skill-dir>` in these commands. Find Node.js 18+ and npm; use the agent's bundled runtime if needed. If the `yaml` dependency is absent, run `npm --prefix <skill-dir> ci --ignore-scripts --no-audit --no-fund`.

```sh
node <skill-dir>/scripts/clash-router.cjs discover
node <skill-dir>/scripts/clash-router.cjs plan
node <skill-dir>/scripts/clash-router.cjs apply
node <skill-dir>/scripts/clash-router.cjs verify
```

The helper detects common macOS, Windows and Linux Clash Verge directories and macOS FlClash. When there are multiple clients, identify the active client and pass `--config-dir <actual-directory>`; `select --config-dir <actual-directory>` saves the default for all helpers. Stale bindings refuse to guess another client. `--core <mihomo-binary>` resolves an undiscovered Verge kernel. A missing/unsupported client registry or controller is a concrete blocker, not permission to rewrite a guessed YAML file.

For live tests with multiple desktop proxy clients installed, quit the other client first and confirm its user kernel exited. Test only one client at a time, then verify the system proxy still points to the intended client's active listener; quitting the other client may clear system proxy settings. A saved CLI binding alone does not prevent two apps from changing macOS proxy settings.

When the user requires automatic fallback during a client switch, arm an independent local rollback guard while the original client still works. Save its current node, system proxy, CLI binding and existing service definitions. A script failure or bounded switch timeout must close the target client and restore the original client and those bindings without waiting for a network-dependent chat. Disarm only after actual target routing and public connectivity pass. After a failed attempt, verify restored connectivity before any further trial.

`plan` is read-only. For Verge, `apply` downloads roughly a megabyte of maintained rule data through the existing local proxy, validates with the actual Mihomo kernel, privately backs up the previous script/runtime, composes the existing global script, and reloads via the local controller (Unix socket or loopback HTTP). It does not edit subscriptions, node definitions, existing groups, DNS, TUN, ports or system proxy settings. FlClash instead uses its native script registry, offline database backup, private loopback controller and brief restart, as described in its reference. Mode becomes Rule, as required for split routing. Updates are idempotent; do not concatenate multiple main functions manually.

The managed group is a hidden single-reference alias to the main selector identified by the original MATCH rule. It follows future UI changes immediately; it has no independent node list or automatic fallback. If MATCH does not identify the desired selector, set `upstreamGroup` in a local settings JSON and pass `--settings-file <path>`; do not guess or hardcode device-specific group names. Legacy `preferredNode` is discarded. Verification resolves the live chain and refuses DIRECT/REJECT or cycles, without choosing another node. Selecting DIRECT in the main group also affects AI; do not claim this alias prevents that user choice.

For AI connectivity, use `probe.cjs`: OpenAI’s public `https://chatgpt.com/robots.txt` must return HTTP 200, with TLS and total elapsed time reported separately from routing correctness. The alias uses this same URL for manual health checks, with automatic checks disabled (`interval: 0`). A failed check reports the failure; it never switches nodes. Leave the subscription’s own selector and automatic selection settings unchanged.

Preserve existing authorization. An explicit request to configure this device permits the corresponding local changes; do not require another confirmation solely because this skill was loaded. Exporting this skill does not authorize uploading local profiles, controller secrets, runtime candidates or backups to GitHub.

## Verify the outcome

- Run `node <skill-dir>/scripts/probe.cjs` for eleven bounded routing probes, including generic China classification for Douyin/Bilibili/WeChat and a numeric China-IP target; inspect its `passed` and per-service evidence. It uses small public requests and a temporary loopback server, and does not test account login or transfer large files.
- Require successful kernel validation and `verify`; inspect all rule providers having nonzero rule counts.
- Confirm the subscription file hash and original rule order are unchanged.
- Generate a few small requests through the local proxy: ChatGPT/Claude, Baidu/iCloud or Apple download metadata, and an intranet/private-IP target. Inspect Mihomo `/connections` or `/rules` to prove the matched policy and chain. A 401/403 alone does not prove the route or a working logged-in session. Do not download large test files or call paid AI APIs.
- Run `verify` again after a subscription refresh/restart when feasible, checking persistence of the global extension. Keep node/region availability separate from the routing guarantee.
- If domestic traffic still uses the proxy, inspect its domain/IP, provider membership and actual matching rule. Check whether an older policy placed domestic DIRECT behind the subscription. Fix the overlay or stale data; do not edit the subscription source or add a one-off app exemption. Existing long-lived connections may need to reconnect to pick up the new policy.

Connection inspection may contain private hosts, process names and IPs. Keep evidence local, show only the summary needed, and never commit real configuration fixtures.

## On-demand traffic audit

Run `node <skill-dir>/scripts/traffic-audit.cjs` for current connections: proxied domestic candidates, largest active proxy downloads and unknown destination IPs. It downloads/caches public domain/CIDR data, redacts node names and detailed host labels, and never closes connections or schedules background work. Missing destination IPs are unknown, not verified foreign. AI/GitHub/APNs proxy exceptions are not mistakes. Active-connection bytes are not the airport bill. Existing REJECT rules after the overlay are counted for overlap review; do not reorder complex original rules automatically.

## On-demand Codex connection recovery

The user command is **`clash-net`**. Install the executable `scripts/clash-net` into `~/.local/bin/clash-net` when setting up the CLI; preserve existing PATH settings if that directory is already present. The launcher supports `check`, `plan`, `recover`, `status`, `rollback`, `auto on|off|status`, and `config discover|select|plan|apply|verify|rollback`, and locates this installed skill without needing the original checkout. `plan` alone measures nodes; `config plan` previews routing configuration.

When the user asks to repeat latency testing and choose a fast non-Hong-Kong node, read [node recovery](references/node-recovery.md). `node <skill-dir>/scripts/node-recovery.cjs check` checks the current route without selecting a node. Explicit `recover` measures non-Hong-Kong leaf nodes from the existing automatic group using its own test URL, then pins the fastest sub-200ms candidate INSIDE that automatic group. Other regions, including Singapore, are eligible; do not impose a Japan/Taiwan/US whitelist. Keep the main selector pointing to the automatic group; if the user selected elsewhere, pause instead of changing the main selector. Verify latency and a source-port-correlated ChatGPT request including both groups and the selected node. Never create a separate AI group or edit subscription rules, group definitions, test URLs or intervals during recovery. Failed verification restores the previous fixed node, or clears the fixed override if the group was previously automatic, then stops. A public probe is not proof of an authenticated Codex session. Do not install background recovery from an on-demand request alone.

Hong Kong filtering applies only to clash-net recovery candidates. Preserve the native client's group memberships, node definitions and subscription source. Match Hong Kong labels before ranking; labels do not verify geographic egress. Updating this candidate filter does not authorize measuring or switching the current node.

For an explicit request to detect outages and recover without manual commands, the same [reference](references/node-recovery.md#自动检测与恢复macos) describes `node-watchdog.cjs install|status|uninstall`. This is an offline-capable local LaunchAgent, separate from AI-scheduled jobs and the domestic endpoint-learning monitor. While the desktop app is open, it checks a small unauthenticated HEAD request every 60 seconds and reads only classified recent operational Codex transport errors. Two consecutive transport failures or sustained new Codex network errors permit one call to the existing recovery flow; auth/quota/server responses alone do not. Persist a 10-minute success/30-minute failure cooldown and three attempts/hour. Verify both the loaded service and a recent live report; test fault-trigger behavior in isolated fixtures without taking down the user's working connection.

## Computer monitoring and bounded learning

For requests to add continuous detection/correction, read [monitor operation and limits](references/monitor.md). On macOS, `node <skill-dir>/scripts/routing-monitor.cjs install` adds a per-user LaunchAgent and the separate file provider; `status` reads its report and `uninstall` stops it and removes learned rules while retaining base routing. Installation is appropriate when the user requests the continuous capability; a read-only diagnosis alone does not authorize scheduling it.

The monitor checks once per minute, validates two separated unauthenticated HTTPS HEAD requests before granting an exact host + single IP + TCP/443 lease, and protects AI/GitHub/APNs. Only original fallback connections qualify; explicit subscription proxy decisions and potentially matching REJECT predicates are excluded. TUN mode suspends learning and clears leases because probe bypass is unverified. Never describe HEAD success as full application or login verification, or a running process as proof that real traffic was saved. Verify the service report, provider state, subscription hash and bounded routing probes after installation. Phone configuration export does not install a monitor.

## Roll back

```sh
node <skill-dir>/scripts/clash-router.cjs rollback
```

Uninstall the monitor before rolling back the base overlay so it does not repair a deliberately removed extension. The helper restores the last installed script/runtime and retains private backups. If the subscription or managed script has changed since installation, it refuses a stale overwrite; use the saved original global script and the client's normal reload to regenerate against the current subscription. Stop after a failed apply has rolled back; diagnose the concrete error before retrying.
