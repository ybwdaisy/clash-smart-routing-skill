# Computer monitoring and learning

This optional local Node.js process complements maintained classifications. It is not a GFW detector or an AI decision for every connection. No MCP server, paid model call or remote connection upload is needed.

## Enable and inspect

First install and verify the base Clash overlay. Keep the skill directory at a stable path, with its npm dependency installed. On macOS:

```sh
node <skill-dir>/scripts/routing-monitor.cjs install
node <skill-dir>/scripts/routing-monitor.cjs status
```

`install` preserves the subscription, adds one `smart-routing-learned` file provider through the existing backed-up installer, and starts `~/Library/LaunchAgents/io.github.clash-smart-routing.monitor.plist`. The service runs as the current user and restarts at login. The Node executable and script are passed as literal arguments. Reinstall after moving the skill or changing its Node executable. Other operating systems can run `watch --config-dir <path>` through their own service manager; automated installation and live verification currently cover macOS only.

Use `uninstall` to stop the service, clear learned rules and reset learning state. Base domestic/AI routing remains installed. It can then be rolled back separately through `clash-router.cjs rollback`. A foreground `watch` process must be stopped first. `once` runs one cycle when the monitor is installed and no other monitor is running.

## Decisions and limits

- Poll active connections every 60 seconds. Report domestic destinations still on the proxy and the largest active proxy transfers. Rule priority/provider verification runs each cycle. If the managed overlay disappeared or was shadowed, attempt one backed-up reapply per incident; subsequent failures pause correction for review. User changes to the global script cause the installer to refuse overwriting it. User-selected non-rule mode pauses learning instead of forcing it back.
- For learning, consider only TCP/443 connections originally matched by MATCH/FINAL, or active endpoints already learned. Explicit foreign domain/service proxy rules continue to be handled by the subscription. Existing China-domain/IP direct priorities still apply before the subscription.
- Exclude maintained AI, Apple Intelligence, GitHub, APNs names/ranges and static guards before DNS lookup or probing. Unknown or potentially matching original REJECT predicates also prevent learning; the monitor recognizes basic domain/IP/port/network and logical rules conservatively.
- Use a real public destination address when known, otherwise at most six bounded system DNS lookups per cycle. Reject private/reserved/fake-IP/transition addresses. Missing or unresolvable addresses remain unknown. Up to three pinned-address HTTPS HEAD requests per cycle and 200 per UTC day; the budget persists through restarts. The request is to `/`, carries no credentials or original URL/query, follows no redirects, verifies the hostname certificate, accepts only 2xx, limits response headers and times out after four seconds. No file bodies are downloaded. TLS/network overhead is still nonzero.
- Two successes at least 60 seconds apart grant an AND rule matching exactly DOMAIN + /32 or /128 + TCP + port 443. No suffix, shared CDN range, whole application or all-foreign DIRECT rule is learned. The learned provider follows static AI and domestic classification rules and precedes original subscription rules.
- Leases last one hour. Active learned endpoints are rechecked when observed, no more often than every ten minutes. A failed recheck revokes its lease, and new connections revert to the subscription unless another existing direct rule applies. Idle leases expire. Failed probes back off for an hour. State is bounded to 256 recent endpoints.
- File updates are atomic and use only the provider refresh API, not a whole-config reload for each learned endpoint. Failed refreshes restore the previous file and attempt to reload it. Base priority repairs use the existing validated, backed-up config apply workflow. Existing transfers are never disconnected automatically: an old proxy download may require reconnecting to adopt a newly effective route.

**Probe success only establishes reachability of the tested HTTPS root at that time.** It cannot prove account-region suitability, API/login behavior or every resource of a site. Revalidation failure affects future connections, not automatic per-request fallback. This is deliberately more conservative than switching all reachable-looking foreign services to DIRECT.

TUN or non-rule mode pauses learning and clears its rules. A direct Node socket could otherwise be intercepted by TUN and produce a false success. Other VPNs and transparent interception can also change the actual network path; investigate them before trusting learning. Existing base rules remain in place. Shadowrocket does not run this desktop monitor.

## State, failure recovery and verification

All state is under the client config's private `smart-routing-state/` directory:

- `learned.yaml`: exact local endpoint rules; never publish it.
- `monitor-state.json`: bounded endpoint observations and persistent request budget; contains host/IP details.
- `monitor-report.json`: latest redacted summary, timestamps, probe counts and rule count.
- `monitor.log` plus one rotated file: bounded redacted cycle reports.
- `monitor.lock`: PID-based single-process lock, automatically recovered only when the previous PID is gone.

Cached public classifications refresh daily. Classification errors clear learned rules and pause that cycle. Controller outages are reported and cleanup is attempted; if the controller is unreachable or the process is killed, lease expiration cannot be enforced until it returns. Startup clears previous endpoint leases, and graceful shutdown attempts to unload them. Do not claim leases have a kernel-enforced timeout. If the service stops unexpectedly, use `status`, restart it, or run `uninstall`; confirm the live learned provider is empty before relying on rollback. Reports are active-connection evidence, not historical usage or a quota-savings measurement.

After installation, require `status` to have a recent `running` report, the LaunchAgent to be loaded, base verification to pass, and the active learned provider to match its file. Prove learning with two observations and an actual new connection in an isolated kernel fixture; also test protection, expiry, failure rollback and certificate/redirect rejection. On the user's machine, do not manufacture real site overrides merely to show a nonzero learned count. Run the normal bounded route probes and compare the subscription hash.

Protocol references: [Mihomo ordered/logical rules](https://wiki.metacubex.one/en/config/rules/), [file rule providers](https://wiki.metacubex.one/en/config/rule-providers/), [provider refresh and connections API](https://wiki.metacubex.one/en/api/).
