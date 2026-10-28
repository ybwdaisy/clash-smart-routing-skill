---
name: clash-smart-routing
description: Configure traffic-saving split routing for Clash Verge/Rev with Mihomo, or export a Shadowrocket .conf preserving its original rules. Prioritize domestic domain/IP DIRECT over subscription proxy rules, keep AI proxied, and prevent domestic downloads/video from wasting quota. Supports migration and rollback; not node purchases or account region restrictions.
---

# Clash Smart Routing

Configure each device through the same maintained overlay, without exporting subscription secrets or asking the user to edit domain lists.

For **Shadowrocket**, read [export and device verification](references/shadowrocket.md). Use its separate `.conf` exporter; the Clash install/controller workflow below does not apply. Shadowrocket support currently means configuration export, not verified device automation or a background extension lifecycle.

When preserving phone settings or notification optimization, merge the actual exported `.conf`, not a generic template. For the requested traffic-saving update, use `--dns saving --remote on`: this explicitly replaces only three DNS/rollback settings, adds validated domain-only remote classifications, and retains static AI/APNs guards. Do not claim the phone configured its background updates automatically. The exporter detects original APNs PROXY intent and protects it before Apple/CN DIRECT; the Shadowrocket reference explains conflicting policies and independently enabled old modules.

## Policy

Apply these priorities through a separate global script; preserve every original subscription rule and its relative order:

1. Foreign AI services (including OpenAI, Claude, Apple Intelligence) and GitHub use a managed proxy-only fallback group.
2. Intranet domain categories and private IPv4/IPv6 destinations go direct. Private-IP rules deliberately resolve domains, including public-looking names mapped to VPN/private IPs.
3. Maintained service categories cover large downloads such as Baidu/iCloud/Apple developer downloads and updates, plus Sukka's China-specific Apple/Microsoft CDN classifications. These are examples, not the complete supported app list.
4. All maintained China domains and China IP destinations go direct BEFORE subscription rules, including a newly seen video CDN hostname resolving to a China IP.
5. Run the existing subscription rules for remaining traffic.
6. Keep the original subscription fallback. Never replace it with DIRECT.

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

The helper detects common macOS, Windows and Linux Clash Verge directories. When there are multiple clients, identify the active client and pass `--config-dir <actual-directory>`; do not choose by file name alone. `--core <mihomo-binary>` resolves an undiscovered kernel. A missing/unsupported client registry or controller is a concrete blocker, not permission to rewrite a guessed YAML file.

`plan` is read-only. `apply` downloads roughly a megabyte of maintained rule data through the existing local proxy, validates with the actual Mihomo kernel, privately backs up the previous script/runtime, composes the existing global script, and reloads via the local controller (Unix socket or loopback HTTP). It does not edit subscriptions, node definitions, existing groups, DNS, TUN, ports or system proxy settings. Mode becomes Rule, as required for split routing. Updates are idempotent; do not concatenate multiple main functions manually.

The managed proxy group uses real subscription nodes/providers, prefers the current selected node when available, excludes DIRECT-like node types, and rejects traffic if empty. It never inherits a subscription group's DIRECT option. Provider-backed airports and renamed nodes are supported without hardcoded group names.

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

## Roll back

```sh
node <skill-dir>/scripts/clash-router.cjs rollback
```

The helper restores the last installed script/runtime and retains private backups. If the subscription or managed script has changed since installation, it refuses a stale overwrite; use the saved original global script and the client's normal reload to regenerate against the current subscription. Stop after a failed apply has rolled back; diagnose the concrete error before retrying.
