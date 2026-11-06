# Native macOS Clash App

Applies only to ProjectClash's `/Applications/Clash.app`, bundle ID `com.hako.network`, with its bundled `Contents/Helpers/clash-cli`. A similarly named App or port 7890 is not sufficient. Implementation reference: [official client source](https://github.com/ProjectClash/Clash-Client).

This adapter is experimental. Local validation on 1.0.15 (117) confirmed VPN startup, controller identity, owned HTTP/SOCKS listeners, 12 nonempty classification providers, rule priority and fallback to Verge. A Singapore node passed source-port-correlated ChatGPT HTTP 200 and a clean-environment native URLSession HTTP 200, including after restart. This verifies public endpoint and native networking, not an authenticated Codex account or new background installation.

## First setup

1. Verify the bundle ID and imported profile. Back up the prior script selection/body and changed listener/controller settings privately. Native storage is TCC protected: use its UI and documented controller, never alternate-path access or direct defaults/App Group mutation.
2. Native Clash requires its NetworkExtension VPN even for localhost listeners. Obtain explicit user authorization for this exception before connecting. Verge/FlClash keep their existing non-TUN behavior. Preserve unrelated VPNs, including intranet OpenVPN.
3. In **More → Client Settings → External Controller**, choose **This Device**, not LAN. Use the App's copy-address and copy-secret buttons to obtain the loopback address and secret privately. When automating, restore the previous clipboard. Never put the secret in command arguments, logs, chat or Git.
4. Pair with the private secret file:

   ```sh
   node <skill-dir>/scripts/proxy-cli.cjs config pair-clash-app \
     --controller http://127.0.0.1:9090 \
     --secret-file /private/path/controller-secret --allow-native-vpn
   ```

   Use the actual address shown by this App, not a guessed port. Registration is stored under `~/.config/proxy/clients/com.hako.network/` with private permissions. The registration directory is not the native subscription store.
5. Generate the script using the printed registration directory:

   ```sh
   node <skill-dir>/scripts/clash-router.cjs apply --config-dir <registration-dir>
   ```

   This **exports** `smart-routing.js`; it does not activate/reload native configuration. If a user script is already selected, export its original body privately and add `--previous-script /private/path/original.js`. Retain that original for later updates; do not wrap a previously generated Smart Routing export. `plan` only previews the file path.
6. In **Configuration Library → current profile → Overrides and Scripts**, create/import the generated script and select it. Existing subscription rules are passed through in order; no subscription file is rewritten. The App owns script validation, recompilation and provider fetching. Run its native configuration check.
7. If the user needs a shared port, set it through **current profile → Inbound → LAN Proxy Sharing → Mixed Proxy Port**, keeping LAN sharing off. Commit the input and reopen the page to verify persistence. On this user's machine all three clients are deliberately set to **7897**; generic installations keep their chosen ports. Do not change the controller port to match the proxy port.
8. Arm the independent rollback guard while Verge works. Quit Verge and confirm its core exited before starting native Clash's VPN. Allow bounded first-load time for provider data; require every provider count to be nonzero. On failure, disconnect only the `scutil --nc list` service matching **`(com.hako.network)` and its UUID**, quit Clash, reopen Verge and verify actual ChatGPT HTTP 200 before another trial. Never stop OpenVPN by name. A configured Verge fallback is required for protected native setup.
9. With one client active, verify `proxy config verify`, `proxy check`, `proxy check --gui`, then run ordinary `setup`. Keep the guard armed until public-route and GUI checks pass. Setup refuses a missing native overlay rather than attempting an unsupported hot reload.

For UI automation use native AXUIElement references and stable accessibility IDs. JXA `entireContents()` may alias sibling controls; do not trust its radio-button ordering. Relevant IDs: `configuration-center.configuration.scripts`, `configuration-center.scripts.selected`, `configuration-center.script-add.name/body/add`, and `proxyShare.core.port`. Port inputs commit when editing ends; setting AXValue alone is insufficient. Avoid coordinate clicks against an occluded window.

## Following, limits and rollback

- The manager recognizes GUI and packet-tunnel executables together as one App. A surviving native VPN plus another client is ambiguous and pauses following. Quit **and disconnect** the previous client before switching.
- Read actual HTTP/mixed/SOCKS ports from `/configs` and validate listener ownership. GUI readiness uses the connected, bundle-matched VPN, not the macOS HTTP proxy checkbox. `launchctl`/shell environment still follows actual ports for explicit-proxy tools; existing GUI processes may need restart.
- Authenticate and identify `/clash/v1/capabilities` (`api: 1`, `platform: macos`) before API use. Node recovery can pin/unpin the existing automatic group; it never changes the main group or AI exit independently. Every automatic operation rechecks active ownership.
- Runtime reload/check and file/provider mutation are not exposed by this adapter. Native App recompilation is authoritative. Bounded learning is disabled while using this App; `proxy monitor status` shows effective disabled state and preserves the user's setting for other clients. Maintained base routing remains active.
- `observed.json` stores canonical runtime rule/group observations, excluding changing node selections, for recovery consistency. `observedPolicyUnchanged` does **not** mean the protected native subscription file was read or hashed. Audit cannot establish original-source REJECT overlap from this observation alone.
- Updating the Skill does not update an already imported native script: export it again, replace the selected Smart Routing script through the App, reconnect and verify. New profiles need their own script selection.
- Native routing rollback means restoring the previous script selection/body and any deliberate native overrides in the UI, then reconnecting. `proxy config rollback` refuses unsupported direct writes. `setup --fresh` remains Verge/Rev-only.

## Diagnosing Google-fast / ChatGPT-failing nodes

Compare the same subscription node in one client at a time under the rollback guard. A real local case reproduced ChatGPT TLS failure on the same Singapore VLESS node in native Clash and FlClash, while Google returned 204 and GitHub returned 200. A Singapore Hysteria2 node passed ChatGPT and native URLSession in both clients. That evidence isolates a node/path difference; it does not identify the provider's filtering policy or prove every VLESS node is faulty. Do not change DNS, TUN or domestic classification without matching evidence, or create a separate AI selector.

Honor a user-requested region during this diagnosis. Temporarily pin only a member already in the automatic group, test the actual ChatGPT endpoint, and preserve the main selector. Keep this explicit diagnosis separate from the recovery algorithm: do not silently add a new region/protocol whitelist or probe-until-success loop to background recovery.

A controller PUT is not proof of persistent App preferences. In native Clash, choose the node in the App's automatic group; its native UI records the profile selection. In FlClash, use its UI or, while closed, privately back up the native database and compare-and-swap only the current profile's `selected_map` entry. Preserve the existing main-to-automatic mapping and all other entries. Restart each client separately and inspect `/proxies` to require both automatic-group `fixed` and resolved node to match the saved choice, then repeat actual HTTP/native-network checks.

Temporary diagnostic tests restore the stable client afterward and do not authorize installing/rebinding background services. If using the existing recovery undo helper, provide its version-2 undo record; a rejected undo is not a successful node restoration.
