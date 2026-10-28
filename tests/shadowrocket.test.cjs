const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {merge,domainRules,stripManaged,main,KEYS}=require('../skills/clash-smart-routing/scripts/shadowrocket.cjs');
const {engine}=require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const source=()=>Object.fromEntries(KEYS.map(k=>[k,'+.'+k+'.example\nexact.'+k+'.example\n']));
const input='# original\n[General]\ndns-server = system\n[Proxy Group]\nOriginal = select,PROXY,DIRECT\n[Rule]\n# keep this comment\nDOMAIN-SUFFIX,foreign.example,Original\nDOMAIN-SUFFIX,blocked.example,REJECT\nFINAL,Original\n[Host]\ninternal.example = 10.0.0.2\n';
test('Shadowrocket keeps original lines and sections while domestic DIRECT outranks subscription rules',()=>{
  const r=merge(input,source());assert.equal(stripManaged(r.output.split('\n')).join('\n'),input);
  assert.ok(r.output.indexOf('DOMAIN-SUFFIX,chatgpt.com,PROXY')<r.output.indexOf('DOMAIN-SUFFIX,foreign.example,Original'));
  assert.ok(r.output.indexOf('GEOIP,CN,DIRECT')<r.output.indexOf('DOMAIN-SUFFIX,foreign.example,Original'));
  assert.ok(r.output.indexOf('GEOIP,CN,DIRECT')<r.output.indexOf('DOMAIN-SUFFIX,blocked.example,REJECT'));
  assert.ok(r.output.indexOf('DOMAIN-SUFFIX,chatgpt.com,PROXY')<r.output.indexOf('GEOIP,CN,DIRECT'));
  assert.ok(r.output.indexOf('GEOIP,CN,DIRECT')<r.output.indexOf('FINAL,Original'));
});
test('Shadowrocket handles overlapping AI/Apple categories and IP resolution without broad proxy IP lists',()=>{
  const s=source();s['apple-ai']='apple-relay.apple.com';s.icloud='+.apple.com';const r=merge(input,s).output;
  assert.ok(r.indexOf('DOMAIN,apple-relay.apple.com,PROXY')<r.indexOf('DOMAIN-SUFFIX,apple.com,DIRECT'));
  assert.ok(r.includes('IP-CIDR,10.0.0.0/8,DIRECT'));assert.ok(r.includes('IP-CIDR6,fc00::/7,DIRECT'));
  assert.ok(!r.includes('no-resolve'));assert.ok(!r.includes('IP-ASN'));
});
test('Shadowrocket export is idempotent and preserves CRLF and missing final newline',()=>{
  for(const text of [input,input.replace(/\n/g,'\r\n'),input.trimEnd()]) {
    const one=merge(text,source()).output,two=merge(one,source()).output;assert.equal(one,two);
    const nl=text.includes('\r\n')?'\r\n':'\n';assert.equal(stripManaged(one.split(/\r?\n/)).join(nl),text);
  }
});
test('Shadowrocket upgrades the previous China-before-FINAL layout instead of leaving domestic traffic shadowed',()=>{
  const legacy=input.replace('FINAL,Original','# smart-routing-shadowrocket:china:begin\nGEOIP,CN,DIRECT\n# smart-routing-shadowrocket:china:end\nFINAL,Original');
  const upgraded=merge(legacy,source()).output;
  assert.ok(upgraded.indexOf('GEOIP,CN,DIRECT')<upgraded.indexOf('DOMAIN-SUFFIX,foreign.example,Original'));
  assert.equal(upgraded.split('GEOIP,CN,DIRECT').length-1,1);
  assert.equal(stripManaged(upgraded.split('\n')).join('\n'),input);
});
test('Shadowrocket refuses missing/ambiguous fallback, malformed blocks, and policy name collisions',()=>{
  for(const bad of [input.replace('FINAL,Original',''),input+'[Rule]\nFINAL,PROXY\n',input.replace('FINAL,Original','FINAL,Original\nFINAL,DIRECT'),
    input+'# smart-routing-shadowrocket:priority:begin\n',input.replace('Original = select','PROXY = select')]) assert.throws(()=>merge(bad,source()));
  assert.throws(()=>merge('rules:\n  - MATCH,PROXY',source()),/\[Rule\]/);
});
test('Shadowrocket rejects unsupported upstream syntax rather than weakening AI routing',()=>{
  assert.deepEqual(domainRules('+.openai.com\nchatgpt.com\n','PROXY'),['DOMAIN-SUFFIX,openai.com,PROXY','DOMAIN,chatgpt.com,PROXY']);
  for(const data of ['', '*.example.com','example.com,DIRECT','regexp:.*']) assert.throws(()=>domainRules(data,'PROXY'));
});
test('Shadowrocket remote China classification includes both maintained domain and classical lists',()=>{
  const out=merge(input,source()).output;
  assert.match(out,/DOMAIN-SET,https:\/\/raw\.githubusercontent\.com\/blackmatrix7\/ios_rule_script\/master\/rule\/Shadowrocket\/ChinaMaxNoIP\/ChinaMaxNoIP_Domain\.list,DIRECT/);
  assert.match(out,/RULE-SET,https:[^\n]+ChinaMaxNoIP\.list,DIRECT/);
});
test('Shadowrocket CLI creates a new private file with provenance and refuses overwrites',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shadowrocket-test-'));
  try {
    const original=path.join(root,'source.conf'),output=path.join(root,'export.conf');fs.writeFileSync(original,input);
    for(const k of KEYS) fs.writeFileSync(path.join(root,path.basename(engine.sources[k].replace('.mrs','.list'))),source()[k]);
    const args=['--input',original,'--output',output,'--source-dir',root];const report=main([...args]);
    assert.ok(report.sourceUnchanged);assert.equal(fs.readFileSync(original,'utf8'),input);
    if(process.platform!=='win32')assert.equal(fs.statSync(output).mode&0o777,0o600);
    const provenance=JSON.parse(fs.readFileSync(output+'.manifest.json'));assert.equal(Object.keys(provenance.sources).length,8);
    assert.throws(()=>main([...args]),/never overwritten/);
    assert.throws(()=>main(['--input',original,'--output',original,'--source-dir',root]),/never overwritten/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
