/* Independent routing overlay. No subscription files or original rules are rewritten. */
var SmartRouting = (function () {
  var PREFIX = "smart-routing-";
  var GROUP = "Smart Routing · Proxy";
  var BASE = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/";
  var SOURCES = {
    ai: "geosite/category-ai-!cn.mrs",
    "apple-ai": "geosite/apple-intelligence.mrs",
    github: "geosite/github.mrs",
    private: "geosite/private.mrs",
    baidu: "geosite/baidu.mrs",
    icloud: "geosite/icloud.mrs",
    "apple-dev": "geosite/apple-dev.mrs",
    "apple-update": "geosite/apple-update.mrs",
    "cn-domain": "geosite/cn.mrs",
    "cn-ip": "geoip/cn.mrs",
    "download-apple-cn": "https://ruleset.skk.moe/Clash/domainset/apple_cdn.txt",
    "download-microsoft-cn": "https://ruleset.skk.moe/Clash/non_ip/microsoft_cdn.txt"
  };
  var GUARDS = ["chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com", "anthropic.com", "claude.ai", "claude.com"];
  var PRIVATE = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"];
  function sourceURL(key) { return /^https:\/\//.test(SOURCES[key]) ? SOURCES[key] : BASE + SOURCES[key]; }
  function managedRule(rule) {
    var fields = String(rule).split(",");
    return fields[0] === "RULE-SET" && fields[1].indexOf(PREFIX) === 0;
  }
  function apply(config, settings) {
    settings = settings || {};
    if (!Array.isArray(config.rules)) throw new Error("A rule-based subscription is required");
    var original = config.rules.filter(function (r) { return !managedRule(r); });
    var oldProviders = config["rule-providers"] || {};
    Object.keys(oldProviders).forEach(function (key) {
      if (key.indexOf(PREFIX) !== 0) return;
      var p = oldProviders[key];
      if (p.type !== "inline" && p.url !== sourceURL(key.slice(PREFIX.length)))
        throw new Error("Reserved rule-provider name collision: " + key);
    });
    var groups = config["proxy-groups"] || [];
    if (groups.some(function (g) { return g.name === GROUP; }) && !oldProviders[PREFIX + "ai"])
      throw new Error("Reserved proxy-group name collision");
    var forbidden = ["direct", "reject", "reject-drop", "pass", "dns", "compatible"];
    var nodes = (config.proxies || []).filter(function (p) {
      return p.name && forbidden.indexOf(String(p.type).toLowerCase()) < 0 &&
        ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].indexOf(String(p.name).toUpperCase()) < 0;
    }).map(function (p) { return p.name; });
    var providerNames = Object.keys(config["proxy-providers"] || {});
    if (!nodes.length && !providerNames.length) throw new Error("No real proxy nodes/providers; refusing an AI DIRECT fallback");
    if (nodes.indexOf(settings.preferredNode) >= 0)
      nodes = [settings.preferredNode].concat(nodes.filter(function (n) { return n !== settings.preferredNode; }));
    var group = {
      name: GROUP, type: "fallback", proxies: nodes, url: "https://www.gstatic.com/generate_204",
      interval: 300, lazy: true, "empty-fallback": "REJECT",
      "exclude-type": "Direct|Reject|RejectDrop|Pass|Dns|Compatible"
    };
    if (providerNames.length) group.use = providerNames;
    config["proxy-groups"] = groups.filter(function (g) { return g.name !== GROUP; }).concat([group]);
    var providers = {};
    Object.keys(oldProviders).forEach(function (key) { if (key.indexOf(PREFIX) !== 0) providers[key] = oldProviders[key]; });
    Object.keys(SOURCES).forEach(function (key) {
      var format = /\.mrs$/.test(SOURCES[key]) ? "mrs" : "text";
      providers[PREFIX + key] = {
        type: "http", behavior: key === "cn-ip" ? "ipcidr" : key === "download-microsoft-cn" ? "classical" : "domain", format: format,
        path: "./ruleset/smart-routing/" + key + (format === "mrs" ? ".mrs" : ".txt"), url: sourceURL(key),
        interval: 86400, proxy: GROUP
      };
    });
    providers[PREFIX + "ai-guard"] = {type: "inline", behavior: "domain", payload: GUARDS.map(function (d) { return "+." + d; })};
    // Deliberately allow resolution: a public-looking intranet name may resolve to a private IP.
    providers[PREFIX + "lan-ip"] = {type: "inline", behavior: "classical", payload: PRIVATE.map(function (cidr) {
      return (cidr.indexOf(":") >= 0 ? "IP-CIDR6," : "IP-CIDR,") + cidr;
    })};
    var intranet = settings.intranetDomains || [];
    if (!Array.isArray(intranet) || intranet.some(function (d) { return typeof d !== "string" || !/^[a-zA-Z0-9._-]+$/.test(d); }))
      throw new Error("intranetDomains must be domain names without rule syntax");
    providers[PREFIX + "lan-domain"] = {type: "inline", behavior: "domain", payload: ["+.localhost", "+.local", "+.lan", "+.internal"].concat(intranet.map(function (d) { return "+." + d; }))};
    config["rule-providers"] = providers;
    function rule(name, target) { return "RULE-SET," + PREFIX + name + "," + target; }
    var priority = [rule("ai-guard", GROUP), rule("ai", GROUP), rule("apple-ai", GROUP), rule("github", GROUP),
      rule("private", "DIRECT"), rule("lan-domain", "DIRECT"), rule("lan-ip", "DIRECT"),
      rule("baidu", "DIRECT"), rule("icloud", "DIRECT"), rule("apple-dev", "DIRECT"), rule("apple-update", "DIRECT"),
      rule("download-apple-cn", "DIRECT"), rule("download-microsoft-cn", "DIRECT")];
    // Domestic classification must beat subscription proxy decisions, not just MATCH.
    // Otherwise a broad subscription proxy rule can consume GB of domestic traffic.
    config.rules = priority.concat([rule("cn-domain", "DIRECT"), rule("cn-ip", "DIRECT")], original);
    config.mode = "rule";
    return config;
  }
  return {apply: apply, sources: SOURCES, sourceURL: sourceURL, group: GROUP, prefix: PREFIX, managedRule: managedRule, guards: GUARDS, privateRanges: PRIVATE};
})();
