# Policy and diagnostics

The rule engine is a deterministic overlay, not a live GFW oracle. It uses daily-updated [MetaCubeX rule data](https://github.com/MetaCubeX/meta-rules-dat/tree/meta/geo); no data files are redistributed in this repository. Explicit AI guards protect core login/content domains before general China/Apple rules. Apple Intelligence precedes iCloud to avoid an AI request being captured by broad iCloud direct rules.

The optional [computer monitor](monitor.md) adds bounded endpoint learning after classification, with temporary exact host/IP rules only for fallback HTTPS connections. It does not replace the static policy or reinterpret explicit foreign subscription routes. Stop it before intentionally rolling back the base overlay.

## What remains with the subscription

The subscription YAML stays byte-for-byte unchanged. Its ordered rules, named proxy groups, providers and fallback are preserved. AI, intranet, maintained download categories, and generic China domain/IP detection all precede the subscription. Domestic DIRECT deliberately overrides subscription proxy decisions, preventing large downloads and domestic video/CDNs from wasting quota. AI rules precede China detection to keep those services on the proxy even if their destinations appear domestic. Remaining traffic still uses the complete original subscription policy and fallback.

A service name is not the general decision criterion: Douyin/Bilibili/WeChat are acceptance examples. Their known domestic hosts match the maintained domain category; new/unlisted CDN hosts resolving to China IPs match the IP category. China IP rules allow DNS resolution, rather than using no-resolve. Country data and available DNS still bound classification accuracy. An entire app is not exempted: its unrelated foreign destinations remain subject to the subscription.

Long-lived connections can retain a route selected before reload. Inspect active connections and, if necessary, reconnect only the affected known domestic transfer; do not terminate AI/VPN or all connections indiscriminately.

Do not route by file size, rewrite MATCH to DIRECT, or decide that a domain ending in `.cn` is always reachable. Domain categories and real destination IPs are signals with different meanings. Apple/Baidu services may use overseas CDNs; those explicit service categories are direct even when their IPs are foreign. A VPN-specific internal DNS server still needs to be available for names only that VPN can resolve; this skill does not replace DNS servers.

## Evidence

`smart-routing-state/verification.json` and backups live in the client configuration directory and may contain private metadata. Keep them out of Git. `verify` checks live rule mode, the managed proxy group and nonempty rule providers. Probe matching is an additional runtime check: inspect `metadata.host`, `destinationIP`, `rule`, `rulePayload` and `chains` from the local controller. Some proxy connections don't expose the destination IP, so mark them unknown instead of claiming complete geolocation coverage.

HTTP authorization errors and Cloudflare challenges can occur even through a proxy. Routing all AI traffic through a proxy does not establish that its egress region is supported or the account is authorized. Preserve the current working selected node as the preferred fallback; do not replace it with the lowest-latency node indiscriminately.

## Updates and recovery

Rule providers refresh every 86400 seconds via the managed proxy group; cached files are retained by Mihomo when updates fail. The original global script is composed before this overlay, so normal subscription refreshes reapply it. If a later subscription-specific script rewrites the entire `rules` array, it can erase global extensions: diagnose that later stage and install an explicitly scoped final subscription extension or adjust the conflicting custom script with authorization, rather than rewriting the subscription source.

The helper immediately applies the overlay to the existing effective runtime, avoiding execution of arbitrary existing JavaScript in Node. Future normal Clash reloads execute the composed script in the client's script engine. Verify both paths when client-specific subscription scripts exist.

Rollback only restores a saved runtime when its subscription hash is still current. Otherwise restore the saved global script through the client and let it regenerate its runtime from today's subscription; don't load a stale backup containing outdated nodes.

Primary references: [Mihomo rule providers](https://wiki.metacubex.one/en/config/rule-providers/), [group empty fallback](https://wiki.metacubex.one/en/config/proxy-groups/#empty-fallback), [routing/no-resolve](https://wiki.metacubex.one/en/config/rules/#no-resolve), [Clash extension order](https://www.clashverge.dev/guide/extend.html).
