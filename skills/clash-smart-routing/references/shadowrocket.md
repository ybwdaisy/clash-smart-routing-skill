# Shadowrocket export

Use `scripts/shadowrocket.cjs` for Shadowrocket `.conf` inputs. Do not send Clash YAML, JavaScript extensions, MRS providers or Mihomo controller calls to this client.

```sh
node <skill-dir>/scripts/shadowrocket.cjs --input /private/path/original.conf --output /private/path/new-smart-routing.conf --dns saving --remote on
```

The input stays untouched. Export adds a marked priority block immediately after `[Rule]`, followed by a China DIRECT block, both before every original rule. Other lines, sections, policy groups, DNS settings, rewrites, comments and the fallback remain intact. Running on a previously exported file replaces its marked blocks. Ambiguous sections/fallbacks, unknown upstream syntax and reserved PROXY redefinitions stop export. Existing outputs are never overwritten.

## Preserve notification routing

Use the user's actual exported `.conf` whenever existing settings or push optimization must survive. A generic template preserves neither unknown DNS/Host/rewrite settings nor notification policy. Do not edit the device's synced database or activate a new config automatically.

`--apns auto` is the default. When the original file explicitly sends `push.apple.com` or its subdomains to built-in PROXY, the exporter adds a protected copy plus Apple's nine APNs-specific IPv4/IPv6 ranges and two precise push CNAME suffixes after AI rules and before **every** DIRECT rule. This repairs the common `apple.com,DIRECT`-before-`push.apple.com,PROXY` conflict without deleting or reordering original lines. APNs IP rules keep the optimization's `no-resolve`; general private/CN rules still resolve normally.

`--apns proxy` explicitly enables this protection; `--apns off` omits it without deleting original rules. A prior managed explicit protection persists during a normal repeat export. Conflicting push policies or a custom push policy group stop automatic export rather than guessing its behavior. Review the actual group and use an explicit mode when needed.

The APNs ranges are reviewed against [Apple's notification connectivity guidance](https://support.apple.com/en-us/102266). Do not proxy all `17.0.0.0/8`, `akadns.net`, or `apple.com.edgekey.net` to preserve notifications; that would unnecessarily include unrelated Apple/CDN traffic. APNs protection is a deliberate small exception to domestic DIRECT, preserving existing notification intent, not a recommendation that every device needs proxied APNs.

An independently enabled old APNs module may still contain broad CDN proxy rules. The merged config includes the needed push rules, so tell the user to disable that old module **if enabled**, then reconnect Shadowrocket. Merely finding an iCloud module file does not prove the phone enabled it. Do not overwrite the synced module, change tunnel/APNs capture switches, claim the phone received a notification, or terminate all device connections without device evidence/authorization.

## Explicit DNS mode

Default `--dns preserve` leaves the original General settings intact. The user-requested `--dns saving` changes exactly `dns-server` to AliDNS/DNSPod DoH, `fallback-dns-server` to `system`, and `dns-direct-fallback-proxy` to `false`. Other DNS flags, IPv6, bypass settings, per-domain Host/VPN DNS mappings and rewrite settings are untouched. Duplicate keys or ambiguous General sections stop export. The manifest records changes for review; the original source remains the rollback.

This stops a failed direct-domain DNS lookup from silently selecting the proxy. The tradeoff is that a domestic destination can fail if domestic and system DNS are unavailable; diagnose that network/VPN DNS rather than quietly spend proxy quota. PROXY traffic follows Shadowrocket's proxy resolution behavior. Do not apply Mihomo DNS options to Shadowrocket.

## Rule updates

With `--remote on`, seven native RULE-SET references cover OpenAI (ACL4SSR domain-only rules), Claude, GitHub, Baidu, iCloud, AppleDev and AppleFirmware (blackmatrix7). Export preflights every referenced service list and rejects IP/ASN, embedded policy or unsupported syntax, avoiding the overly broad cloud-ASN rule in some OpenAI lists. Remote sources can evolve later; revalidate them on subsequent skill runs. Static current MetaCubeX AI/service classifications and APNs remain as guards/fallbacks. Do not replace those guards with a smaller remote list or claim every AI category is now dynamic.

Ten maintained snapshot categories are downloaded and converted to native domain rules: eight MetaCubeX categories and Sukka's China-specific Apple/Microsoft CDN data. The latter use supported text subsets, not a Surge module; full Sukka/Surge configurations remain unsupported by Shadowrocket. Ruleset data is referenced or privately exported, not bundled in the Git repository; Sukka's data is AGPL-3.0, with source URLs retained in the private manifest.

 They have the same sources and priorities as Clash, including Apple Intelligence before iCloud and private IPs without no-resolve. Core OpenAI/Claude guards are shared with the Clash engine. These static guards/fallback categories are a **snapshot refreshed on export**, not automatically refreshed on the phone. Regenerate and import when updating the skill or investigating new domains. No user-maintained domain list is needed.

China's subscription-overriding DIRECT block references both blackmatrix7 `ChinaMaxNoIP_Domain.list` (DOMAIN-SET) and `ChinaMaxNoIP.list` (RULE-SET), followed by the device's `GEOIP,CN`. The maintainer publishes the remote lists daily; client refresh behavior and its GeoIP database must be checked in the installed Shadowrocket version. Do not claim that exporting a file installed a background update schedule. Do not add update-interval syntax without confirming client support.

Without `--input`, the bundled minimal example is used. This is only for a device with a separate node subscription and no custom routing configuration; it cannot preserve unknown existing rules. A node subscription and a complete routing configuration are different inputs. Never replace someone's complete config with this example and claim preservation.

## Phone automatic updates

After import, select the file and configuration-based routing, retaining the existing subscribed node. In Shadowrocket Settings > Automatic Update > Configuration, enable automatic background updates with a one-day interval, and allow iOS Background App Refresh for Shadowrocket. Enable GeoLite2 database updates when available. The local file has no `update-url`: updates refresh referenced remote resources instead of overwriting local APNs/DNS settings. No subscription URL or GitHub token needs to be entered. This one-time phone UI setup cannot be performed by the exported `.conf`.

The community-maintained [Shadowrocket manual](https://github.com/LOWERTOP/Shadowrocket#自动更新) describes this behavior; labels can vary by installed version. iOS background scheduling is not guaranteed, especially after force-quitting the app. To refresh immediately, use/select the configuration; do not repeatedly import a whole new template. Modules have higher priority than the main file, so disable the old broad APNs module if it was enabled. Domain rules may outrank GeoIP during client compilation; verify actual phone logs for new CDN domains/IPs instead of claiming desktop structural tests proved phone routing.

## Import and device verification

1. Transfer the new file privately through Files/iCloud Drive or AirDrop, then import it into Shadowrocket. The developer's App Store listing confirms rule-file import through URL/iCloud Drive. The private GitHub repository is not an unauthenticated configuration URL; never embed GitHub tokens or subscription URLs in a public link.
2. Activate the imported configuration and configuration-based routing. Select a real, working proxy node. AI routes use built-in `PROXY`; the exporter does not create a selector that could offer DIRECT. Inspect any client setting or selection that could still bypass this policy.
3. Inspect request/connection records for OpenAI/Claude (PROXY), Baidu/iCloud/Apple downloads (DIRECT), a reachable known intranet target (DIRECT), and Douyin/Bilibili/WeChat and a domestic destination IP (China DIRECT before subscription rules). Use small requests only. Match records are required; logged-in service usability is a separate check. When push protection is enabled, also confirm APNs matches PROXY before Apple/CN DIRECT, then verify a real notification on the phone. Generated rule order is not proof of successful push delivery.
4. Confirm the original subscription remains independently installed and its original config file was not overwritten. If that config is regenerated by the subscription, rerun export from the updated source; there is no demonstrated Clash-like JavaScript overlay lifecycle in Shadowrocket.
5. Roll back by selecting the original configuration in Shadowrocket. Do not delete nodes or subscriptions.

Exports and manifests are private local artifacts, excluded from Git. A full `.conf` can contain credentials, internal hosts, scripts or rewrite secrets. The exporter does not execute embedded scripts, enable HTTPS decryption or change certificates. A generated file and passing automated tests do not constitute Shadowrocket kernel or iPhone runtime verification; report that limitation until device evidence exists.

Primary references: [developer App Store listing](https://apps.apple.com/us/app/shadowrocket/id932747118), [MetaCubeX data](https://github.com/MetaCubeX/meta-rules-dat), [Shadowrocket China set usage](https://github.com/blackmatrix7/ios_rule_script/blob/master/rule/Shadowrocket/ChinaMaxNoIP/README.md).
