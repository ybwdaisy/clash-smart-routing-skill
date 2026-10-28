const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {engine, render, preserved, argumentsOf, controller, verify} = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const copy = x => JSON.parse(JSON.stringify(x));
function fixture() {
  return {mode: 'rule', proxies: [{name: 'First node', type: 'ss'}, {name: 'Preferred node', type: 'trojan'}, {name: 'Fake direct node', type: 'direct'}],
    'proxy-groups': [{name: 'Existing', type: 'select', proxies: ['DIRECT', 'First node']}],
    'rule-providers': {custom: {type: 'inline', behavior: 'domain', payload: ['+.foreign.example']}},
    dns: {enable: true, nameserver: ['system']},
    rules: ['DOMAIN-SUFFIX,foreign.example,Existing', 'DOMAIN-SUFFIX,blocked.example,REJECT', 'GEOIP,CN,DIRECT,no-resolve', 'MATCH,Existing']};
}
test('preserves subscription rules, groups, DNS, nodes and original fallback', () => {
  const original = fixture(); const before = copy(original); const result = copy(engine.apply(original, {}));
  assert.deepEqual(result.rules.filter(r => !engine.managedRule(r)), before.rules);
  assert.deepEqual(result['proxy-groups'].slice(0, -1), before['proxy-groups']);
  assert.deepEqual(result.proxies, before.proxies); assert.deepEqual(result.dns, before.dns);
  assert.deepEqual(result['rule-providers'].custom, before['rule-providers'].custom);
  assert.equal(result.rules.at(-1), 'MATCH,Existing'); preserved(before.rules, result.rules);
});
test('AI and Apple Intelligence precede direct downloads and all subscription rules', () => {
  const result = engine.apply(fixture(), {}); const index = key => result.rules.findIndex(r => r.startsWith('RULE-SET,smart-routing-' + key + ','));
  assert.equal(index('ai-guard'), 0); assert.ok(index('ai') < index('icloud')); assert.ok(index('apple-ai') < index('icloud'));
  for (const name of ['baidu','icloud','apple-dev','apple-update','private','lan-ip']) {
    assert.ok(result.rules[index(name)].endsWith(',DIRECT')); assert.ok(index(name) < result.rules.indexOf('DOMAIN-SUFFIX,foreign.example,Existing'));
  }
});
test('domestic classification precedes explicit subscription proxy/reject without editing original rules', () => {
  const result = engine.apply(fixture(), {}); const rules = result.rules;
  for (const key of ['cn-domain','cn-ip']) {
    const direct=rules.indexOf('RULE-SET,smart-routing-'+key+',DIRECT');
    assert.ok(direct<rules.indexOf('DOMAIN-SUFFIX,foreign.example,Existing'));
    assert.ok(direct<rules.indexOf('DOMAIN-SUFFIX,blocked.example,REJECT'));
    assert.ok(direct>rules.indexOf('RULE-SET,smart-routing-ai-guard,'+engine.group));
  }
  assert.deepEqual(Array.from(rules.slice(13)),fixture().rules);
});
test('AI routes cannot inherit DIRECT/COMPATIBLE from subscription selector or empty providers', () => {
  const result = engine.apply(fixture(), {preferredNode:'Preferred node'}); const group = result['proxy-groups'].at(-1);
  assert.deepEqual(Array.from(group.proxies), ['Preferred node','First node']); assert.equal(group['empty-fallback'],'REJECT');
  assert.equal(group.type,'fallback'); assert.ok(!group.proxies.includes('Existing'));
  const providersOnly = fixture(); providersOnly.proxies=[]; providersOnly['proxy-providers']={airport:{type:'http',url:'https://example.invalid/sub'}};
  const p = engine.apply(providersOnly, {})['proxy-groups'].at(-1); assert.deepEqual(Array.from(p.use),['airport']); assert.equal(p['empty-fallback'],'REJECT');
});
test('refuses unsafe no-proxy config and namespace collisions instead of silently changing routing', () => {
  const empty=fixture(); empty.proxies=[]; assert.throws(()=>engine.apply(empty,{}),/No real proxy/);
  const collision=fixture(); collision['rule-providers']['smart-routing-ai']={type:'http',url:'https://example.invalid/user-owned'};
  assert.throws(()=>engine.apply(collision,{}),/collision/);
  assert.throws(()=>engine.apply(fixture(),{intranetDomains:['x,DIRECT']}),/domain names/);
});
test('repeat installation is idempotent; subscription updates and node renames are incorporated', () => {
  const once=copy(engine.apply(fixture(),{})); assert.deepEqual(copy(engine.apply(copy(once),{})),once);
  const updated=fixture(); updated.proxies=[{name:'New device node',type:'vless'}]; updated.rules.splice(1,0,'DOMAIN-SUFFIX,new.example,Existing');
  const result=engine.apply(updated,{}); assert.equal(result['proxy-groups'].at(-1).proxies[0],'New device node');
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,new.example,Existing'));
});
test('public-looking intranet domains can resolve to private addresses; inline data stays local', () => {
  const r=engine.apply(fixture(),{intranetDomains:['intranet.example']});
  assert.ok(r['rule-providers']['smart-routing-lan-domain'].payload.includes('+.intranet.example'));
  assert.ok(r['rule-providers']['smart-routing-lan-ip'].payload.every(r=>!r.includes('no-resolve')));
  assert.ok(r['rule-providers']['smart-routing-lan-ip'].payload.includes('IP-CIDR6,fc00::/7'));
});
test('generated global extension preserves an existing script once and runs on future subscriptions', () => {
  const existing='function main(config) { config.rules.unshift("DOMAIN-SUFFIX,previous.example,DIRECT"); return config; }';
  const script=render(existing,{}); const sandbox={}; vm.createContext(sandbox); vm.runInContext(script,sandbox,{timeout:1000});
  const result=sandbox.main(fixture(),'another device');
  assert.equal(result.rules.filter(r=>r==='DOMAIN-SUFFIX,previous.example,DIRECT').length,1);
  assert.ok(result.rules[0].includes('smart-routing-ai-guard'));
  assert.equal(script.split(existing).length-1,1);
});
test('does not invent a MATCH when subscription has no explicit fallback', () => {
  const f=fixture();f.rules.pop(); const r=engine.apply(f,{});assert.ok(!r.rules.some(r=>r.startsWith('MATCH,')));
});
test('CLI rejects unknown operations/arguments instead of interpreting shell content', () => {
  assert.deepEqual(argumentsOf(['plan','--config-dir','/tmp/fixture']),{command:'plan',args:{'config-dir':'/tmp/fixture'}});
  assert.throws(()=>argumentsOf(['apply','--unknown','x']),/Unknown/);
});
test('uses a real Unix controller when HTTP control is disabled, without exposing its secret', async () => {
  const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), http=require('node:http');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clash-router-'));
  const socket=path.join(root,'api.sock'); let authenticated=false;
  const server=http.createServer((req,res)=>{authenticated=req.headers.authorization==='Bearer local-test-only'; res.end('{"version":"test"}');});
  try {
    await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(socket,resolve);});
    const api=controller({root,config:{'external-controller':'','external-controller-unix':socket,secret:'local-test-only'}});
    assert.deepEqual(await api('GET','/version'),{version:'test'});assert.ok(authenticated);
    assert.throws(()=>controller({root,config:{'external-controller':'example.invalid:9090'}}),/local HTTP/);
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
test('live verification refuses rules shadowed by a later client extension', async () => {
  const rules=engine.apply(fixture(),{}).rules.filter(engine.managedRule).map(r=>{const [type,payload,proxy]=r.split(',');return{type:'RuleSet',payload,proxy};});
  const data={ '/rules':{rules}, ['/proxies/'+encodeURIComponent(engine.group)]:{all:['First node'],now:'First node'},
    '/configs':{mode:'rule'}, '/providers/rules':{providers:Object.fromEntries(Object.keys(engine.sources).map(k=>[engine.prefix+k,{ruleCount:1}]))}};
  const api=async(method,route)=>data[route];
  assert.equal((await verify({},api)).managedRules,13);
  const before=[...data['/rules'].rules];
  data['/rules'].rules.splice(11,0,{type:'DomainSuffix',payload:'douyin.com',proxy:'First node'});
  await assert.rejects(()=>verify({},api),/Domestic DIRECT priority/);
  data['/rules'].rules=before;
  data['/rules'].rules.unshift({type:'Match',payload:'',proxy:'DIRECT'});
  await assert.rejects(()=>verify({},api),/shadowed/);
});
