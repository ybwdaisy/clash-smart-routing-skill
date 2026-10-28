#!/usr/bin/env node
'use strict';
// On-demand, read-only connection audit. Never disconnects traffic or schedules jobs.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const {engine,discover,load,controller}=require('./clash-router.cjs');
const {APNS_RANGES}=require('./shadowrocket.cjs');
function address(value){
  if(typeof value!=='string')return null;
  const family=net.isIP(value);if(!family)return null;
  if(family===4)return {family,value:value.split('.').reduce((v,n)=>(v<<8n)+BigInt(n),0n)};
  let s=value.split('%')[0];
  if(s.includes('.')){const i=s.lastIndexOf(':'),ip=address(s.slice(i+1));s=s.slice(0,i)+':'+(ip.value>>16n).toString(16)+':'+(ip.value&65535n).toString(16);}
  const pieces=s.split('::');let words;
  if(pieces.length===2){const a=pieces[0]?pieces[0].split(':'):[],b=pieces[1]?pieces[1].split(':'):[];words=[...a,...Array(8-a.length-b.length).fill('0'),...b];}
  else words=s.split(':');
  return {family,value:words.reduce((v,w)=>(v<<16n)+BigInt('0x'+w),0n)};
}
function ranges(text){
  return text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')).map(l=>{
    const parts=l.split('/'),ip=address(parts[0]),bits=Number(parts[1]),width=ip?.family===4?32:128;
    if(!ip||parts.length!==2||!Number.isInteger(bits)||bits<0||bits>width)throw Error('Invalid public IP classification data');
    const shift=BigInt(width-bits);return {family:ip.family,shift,base:ip.value>>shift};
  });
}
function contains(list,value){
  let ip=typeof value==='string'?address(value):value;if(!ip)return false;
  if(ip.family===6&&(ip.value>>32n)===65535n)ip={family:4,value:ip.value&0xffffffffn};
  return list.some(r=>r.family===ip.family&&(ip.value>>r.shift)===r.base);
}
function domains(text){
  const exact=new Set(),suffix=new Set();
  for(const row of text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'))){
    if(!/^(?:\+\.)?[a-zA-Z0-9._-]+$/.test(row))throw Error('Unsupported domain classification data');
    if(row.startsWith('+.'))suffix.add(row.slice(2).toLowerCase());else exact.add(row.toLowerCase());
  }
  return host=>{let s=String(host||'').toLowerCase().replace(/\.$/,'');if(exact.has(s))return true;while(s){if(suffix.has(s))return true;const at=s.indexOf('.');if(at<0)break;s=s.slice(at+1);}return false;};
}
function site(host){
  if(!host)return '(no hostname)';if(net.isIP(host))return '(IP destination)';
  const p=String(host).toLowerCase().replace(/\.$/,'').split('.');
  const count=['com.cn','net.cn','org.cn','co.uk','com.hk'].includes(p.slice(-2).join('.'))?3:2;
  return p.length>=count?p.slice(-count).join('.'):'(local hostname)';
}
function summarize(connections,chinaIPs,chinaHost,originalRules=[],limit=10){
  const privateIPs=ranges(Array.from(engine.privateRanges).join('\n')),apns=ranges(APNS_RANGES.join('\n'));
  const rows=connections.map(c=>{
    const m=c.metadata||{},ip=m.destinationIP||'',host=m.host||'',chains=c.chains||[];
    const direct=chains.some(x=>/^(DIRECT|COMPATIBLE)$/i.test(x));
    const proxied=!direct&&chains.length>0&&!chains.some(x=>/^REJECT/.test(x));
    const domestic=contains(chinaIPs,ip)||contains(privateIPs,ip)||chinaHost(host);
    const exempt=['ai-guard','ai','apple-ai','github'].some(k=>c.rulePayload===engine.prefix+k)||
      Array.from(engine.guards).some(d=>host===d||host.endsWith('.'+d))||['push.apple.com','push-apple.com.akadns.net','courier-push-apple.com.akadns.net'].some(d=>host===d||host.endsWith('.'+d))||contains(apns,ip);
    return {site:contains(privateIPs,ip)?'(private destination)':site(host),proxied,domestic,expectedProxyException:exempt,
      destinationIpKnown:Boolean(address(ip)),downloadBytes:Math.max(0,Number(c.download)||0),uploadBytes:Math.max(0,Number(c.upload)||0),matchedRule:c.rule||'unknown'};
  });
  const proxy=rows.filter(r=>r.proxied).sort((a,b)=>b.downloadBytes-a.downloadBytes);
  return {activeConnections:rows.length,proxiedConnections:proxy.length,unknownDestinationIPs:rows.filter(r=>!r.destinationIpKnown).length,
    domesticProxyCandidates:proxy.filter(r=>r.domestic&&!r.expectedProxyException),topProxied:proxy.slice(0,limit),
    originalRejectRulesAfterOverlay:originalRules.filter(r=>/,(REJECT|REJECT-DROP)(?:,|$)/i.test(r)).length,
    note:'Current active connections only, not billing history. Missing IPs remain unknown. Reject-rule overlap needs review; rules are never reordered automatically.'};
}
function cached(ctx,key,filename,proxy){
  const file=path.join(ctx.stateDir,'audit-cache',filename);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(fs.existsSync(file)&&Date.now()-fs.statSync(file).mtimeMs<86400000&&fs.statSync(file).size>0)return fs.readFileSync(file,'utf8');
  const url='https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/'+key+'.list';
  const result=cp.spawnSync('curl',['-fsSL','--connect-timeout','10','--max-time','30',...(proxy?['--proxy',proxy]:[]),url],{encoding:'utf8',timeout:35000,maxBuffer:8*1024*1024});
  if(result.status!==0||!result.stdout.trim())throw Error('Cannot refresh public audit data; no route changes made');
  if(key==='geoip/cn')ranges(result.stdout);else domains(result.stdout);
  const temp=file+'.tmp';fs.writeFileSync(temp,result.stdout,{mode:0o600});fs.renameSync(temp,file);fs.chmodSync(file,0o600);return result.stdout;
}
async function main(argv){
  if(argv.length&&(argv.length!==2||argv[0]!=='--config-dir'))throw Error('Usage: traffic-audit.cjs [--config-dir path]');
  const roots=argv.length?[argv[1]]:discover();if(roots.length!==1)throw Error('Choose one active client with --config-dir');
  const ctx=load(roots[0]),api=controller(ctx),port=ctx.config['mixed-port']||ctx.config.port,proxy=port?'http://127.0.0.1:'+port:null;
  await api('GET','/version');
  const ip=ranges(cached(ctx,'geoip/cn','cn-ip.list',proxy)),host=domains(cached(ctx,'geosite/cn','cn-domain.list',proxy));
  const active=await api('GET','/connections');return summarize(active.connections||[],ip,host,ctx.subscription.rules||[]);
}
if(require.main===module)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={address,ranges,contains,domains,summarize};
