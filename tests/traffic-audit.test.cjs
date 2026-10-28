const {test}=require('node:test'),assert=require('node:assert/strict');
const {address,ranges,contains,domains,summarize}=require('../skills/clash-smart-routing/scripts/traffic-audit.cjs');
test('audit classifies IPv4, compressed IPv6 and mapped IPv4 without guessing missing addresses',()=>{
  const r=ranges('223.5.0.0/16\n240e::/20');
  for(const ip of ['223.5.5.5','240e:123::1','::ffff:223.5.5.5'])assert.ok(contains(r,ip));
  for(const ip of ['1.1.1.1','240e:1234::1','2606:4700::1','','not-an-IP'])assert.equal(contains(r,ip),false);
  assert.equal(address('invalid'),null);assert.throws(()=>ranges('223.5.0.0/999'),/Invalid/);
});
test('audit detects domains at label boundaries and exempts legitimate AI/APNs proxy routes',()=>{
  const match=domains('+.douyin.com\n+.chatgpt.com\nexact.example');
  assert.ok(match('v.douyin.com'));assert.ok(!match('fakedouyin.com'));assert.ok(!match('sub.exact.example'));
  const row=(host,ip,chain,download,payload)=>({metadata:{host,destinationIP:ip},chains:[chain],download,rule:'RuleSet',rulePayload:payload});
  const r=summarize([row('cdn.douyin.com','223.5.5.5','node',100),row('chatgpt.com','223.5.5.5','node',200,'smart-routing-ai-guard'),
    row('courier.push.apple.com','17.249.0.1','node',3),row('unknown.example','','node',400),row('v.douyin.com','223.5.5.5','DIRECT',500)],ranges('223.5.0.0/16'),match,['DOMAIN,ad.example,REJECT']);
  assert.equal(r.domesticProxyCandidates.length,1);assert.equal(r.domesticProxyCandidates[0].site,'douyin.com');
  assert.equal(r.topProxied[0].site,'unknown.example');assert.equal(r.unknownDestinationIPs,1);assert.equal(r.originalRejectRulesAfterOverlay,1);
});
