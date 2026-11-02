const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validatePublic,releaseText,main,UPDATE_URL,BASE}=require('../skills/clash-smart-routing/scripts/publish-shadowrocket.cjs');
const {merge,KEYS,REMOTES,stripManaged}=require('../skills/clash-smart-routing/scripts/shadowrocket.cjs');
const {engine}=require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const base=fs.readFileSync(BASE,'utf8'),revision='a'.repeat(40);
const source=()=>Object.fromEntries(KEYS.map(k=>[k,'+.category.example\n']));
test('public publishing preserves reviewed base, push optimization and selected-node PROXY',()=>{
  assert.equal(validatePublic(base),true);
  const merged=merge(base,source(),{dns:'saving',remote:'on'});
  const out=releaseText(merged.output,revision,{sources:{test:{url:'https://example.org/rules'}},remoteSources:{}});
  assert.equal(validatePublic(out,true),true);assert.ok(out.includes('update-url = '+UPDATE_URL));
  assert.ok(out.indexOf('DOMAIN-SUFFIX,push.apple.com,PROXY')<out.indexOf('DOMAIN-SUFFIX,apple.com,DIRECT'));
  assert.ok(out.includes('FINAL,PROXY'));assert.ok(!out.includes('[Proxy Group]'));
  assert.equal(stripManaged(merged.output.split('\n')).join('\n'),base);
});
test('publisher rejects nodes, subscriptions, private host/rewrite settings and unknown remote resources',()=>{
  for(const bad of [base+'\n[Proxy]\nnode = ss,private.example,443,password\n',
    base.replace('dns-server = https://dns.alidns.com/dns-query,https://doh.pub/dns-query','dns-server = https://private.example/dns?token=secret'),
    base.replace('localhost = 127.0.0.1','intranet.example = 10.1.2.3'),
    base.replace('FINAL,PROXY','RULE-SET,https://private.example/list?token=secret,DIRECT\nFINAL,PROXY'),
    base.replace('FINAL,PROXY','FINAL,DIRECT'),
    base.replace('[General]','[General]\nsubscription = https://private.example/sub'),
    base.replace('[General]','[General]\nupdate-url = https://private.example/sub')]) assert.throws(()=>validatePublic(bad));
  assert.throws(()=>main(['--input','/tmp/private.conf']),/Unsupported publish argument/);
  assert.throws(()=>releaseText(base,'bad',{sources:{}}),/full source commit/);
});
test('offline build exports only reviewed public files and leaves previous output intact after validation failure',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-shadowrocket-'));
  try {
    for(const k of KEYS)fs.writeFileSync(path.join(root,path.basename(engine.sources[k].replace('.mrs','.list'))),source()[k]);
    for(const remote of REMOTES)fs.writeFileSync(path.join(root,'remote-'+remote.name+'.list'),'DOMAIN-SUFFIX,upstream.example\n');
    const target=path.join(root,'output'),args=['--source-dir',root,'--output-dir',target,'--revision',revision];
    main([...args]);const file=path.join(target,'smart-routing.conf'),before=fs.readFileSync(file,'utf8');
    assert.equal(validatePublic(before,true),true);assert.deepEqual(fs.readdirSync(target).sort(),['smart-routing.conf','smart-routing.sources.json']);
    const report=JSON.parse(fs.readFileSync(path.join(target,'smart-routing.sources.json')));
    assert.equal(report.sourceCommit,revision);assert.equal(report.apnsProxyProtected,true);assert.equal(report.noNodesOrSubscriptionCredentials,true);
    assert.ok(!JSON.stringify(report).includes(os.homedir()));
    main([...args]);assert.equal(fs.readFileSync(file,'utf8'),before);
    fs.writeFileSync(path.join(root,'remote-openai.list'),'IP-ASN,20473,no-resolve');
    assert.throws(()=>main([...args]),/broad IP/);assert.equal(fs.readFileSync(file,'utf8'),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
