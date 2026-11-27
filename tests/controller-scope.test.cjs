'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const base='../skills/clash-smart-routing/scripts/';
const router=require(base+'clash-router.cjs'),active=require(base+'active-client.cjs'),service=require(base+'verge-service.cjs');
test('a verified service socket is used only for its active App directory, never an explicit other root',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ctrl-scope-')),owned=path.join(temp,'active'),other=path.join(temp,'fixture');
 fs.mkdirSync(owned);fs.mkdirSync(other);
 const socket=path.join(temp,'service.sock'),server=http.createServer((_,res)=>res.end('{"source":"fixture"}')),
 privileged=http.createServer((_,res)=>res.end('{"source":"owned-service"}'));
 const before={detect:active.detect,socketPath:service.socketPath};let serviceCalls=0;
 try{
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes)});
  await new Promise((yes,no)=>{privileged.once('error',no);privileged.listen(socket,yes)});
  service.socketPath=()=>{serviceCalls++;return socket};
  active.detect=()=>({status:'active',client:'verge',root:owned});
  const ctx=root=>({root,client:'verge',config:{'external-controller':'127.0.0.1:'+server.address().port}});
  assert.deepEqual(await router.controller(ctx(other),{followActive:false})('GET','/version'),{source:'fixture'});
  assert.equal(serviceCalls,0,'foreign context must not even discover the privileged socket');
  assert.deepEqual(await router.controller(ctx(owned),{followActive:false})('GET','/version'),{source:'owned-service'});
  assert.equal(serviceCalls,1);
  active.detect=()=>({status:'paused-no-client'});
  assert.deepEqual(await router.controller(ctx(owned),{followActive:false})('GET','/version'),{source:'fixture'});
  assert.equal(serviceCalls,1,'no active App must not authorize service preference');
 }finally{
  active.detect=before.detect;service.socketPath=before.socketPath;
  await Promise.all([server,privileged].filter(s=>s.listening).map(s=>new Promise(yes=>s.close(yes))));
  fs.rmSync(temp,{recursive:true,force:true});
 }
});
