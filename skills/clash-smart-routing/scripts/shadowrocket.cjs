#!/usr/bin/env node
'use strict';
// Export only. Never edit the input, activate a VPN, or upload device configuration.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {engine} = require('./clash-router.cjs');
const CNBASE = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP';
const KEYS = Object.keys(engine.sources).filter(k => !k.startsWith('cn-'));
const NATIVE_BASE='https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/';
const REMOTES=[
  {name:'openai',url:'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list',policy:'PROXY'},
  {name:'claude',url:NATIVE_BASE+'Claude/Claude.list',policy:'PROXY'},
  {name:'github',url:NATIVE_BASE+'GitHub/GitHub.list',policy:'PROXY'},
  ...[['baidu','Baidu'],['icloud','iCloud'],['apple-dev','AppleDev'],['apple-update','AppleFirmware']].map(([name,file])=>
    ({name,url:NATIVE_BASE+file+'/'+file+'.list',policy:'DIRECT'}))
];
// Apple's APNs-specific ranges, not all Apple/CDN traffic. Reviewed against:
// https://support.apple.com/en-us/102266
const APNS_RANGES = ['17.249.0.0/16','17.252.0.0/16','17.57.144.0/22','17.188.128.0/18','17.188.20.0/23',
  '2620:149:a44::/48','2403:300:a42::/48','2403:300:a51::/48','2a01:b740:a42::/48'];
const TAG = '# smart-routing-shadowrocket:';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function stripManaged(lines) {
  let block = null;
  const output = [];
  for (const line of lines) {
    if (!line.startsWith(TAG)) {if (!block) output.push(line); continue;}
    const match = line.match(/^# smart-routing-shadowrocket:(priority|china):(begin|end)$/);
    if (!match) throw Error('Unrecognized managed marker; review existing configuration');
    if (match[2] === 'begin') {if (block) throw Error('Nested managed block'); block = match[1];}
    else {if (block !== match[1]) throw Error('Unmatched managed block'); block = null;}
  }
  if (block) throw Error('Unclosed managed block');
  return output;
}
function domainRules(text, target) {
  const rows = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  if (!rows.length) throw Error('Empty upstream domain category');
  return rows.map(row => {
    if (/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD),[a-zA-Z0-9._-]+$/.test(row)) return row+','+target;
    if (/^\+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(row)) return 'DOMAIN-SUFFIX,' + row.slice(2) + ',' + target;
    if (/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(row)) return 'DOMAIN,' + row + ',' + target;
    throw Error('Unsupported upstream domain syntax; no configuration exported');
  });
}
function savingDns(input, mode='preserve') {
  if(!['preserve','saving'].includes(mode)) throw Error('DNS mode must be preserve or saving');
  if(mode==='preserve')return {output:input,changes:[]};
  const nl=input.includes('\r\n')?'\r\n':'\n', lines=input.split(/\r?\n/);
  const starts=lines.map((l,i)=>/^\s*\[General\]\s*$/i.test(l)?i:-1).filter(i=>i>=0);
  if(starts.length!==1)throw Error('Saving DNS requires exactly one [General] section; review the actual configuration');
  const begin=starts[0];let end=lines.findIndex((l,i)=>i>begin&&/^\s*\[/.test(l));if(end<0)end=lines.length;
  const changes=[];
  for(const [key,value] of Object.entries({'dns-server':'https://dns.alidns.com/dns-query,https://doh.pub/dns-query','fallback-dns-server':'system','dns-direct-fallback-proxy':'false'})){
    const matches=[];for(let i=begin+1;i<end;i++)if(new RegExp('^\\s*'+key+'\\s*=', 'i').test(lines[i]))matches.push(i);
    if(matches.length>1)throw Error('Ambiguous duplicate DNS setting: '+key);
    const before=matches.length?lines[matches[0]]:null;
    if(matches.length)lines[matches[0]]=key+' = '+value;
    else {lines.splice(end,0,key+' = '+value);end++;}
    if(before!==key+' = '+value)changes.push({key,before,after:value});
  }
  return {output:lines.join(nl),changes};
}
function validateRemote(text) {
  const rows=text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  if(!rows.length||rows.some(l=>! /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD),[a-zA-Z0-9._-]+$/.test(l)))
    throw Error('Remote classification contains empty/unsupported or broad IP/ASN rules; inspect before exporting');
  return rows.length;
}
function merge(input, sources, settings = {}) {
  const newline = input.includes('\r\n') ? '\r\n' : '\n';
  const lines = stripManaged(input.split(/\r?\n/));
  if (lines.some(l => /^\s*PROXY\s*=/i.test(l))) throw Error('Reserved PROXY name is redefined; inspect actual proxy-only policy before export');
  const sections = lines.map((l, i) => /^\s*\[Rule\]\s*(?:[#;].*)?$/i.test(l) ? i : -1).filter(i => i >= 0);
  if (sections.length !== 1) throw Error('Expected one [Rule] section in a Shadowrocket .conf');
  const start = sections[0];
  let end = lines.findIndex((l,i) => i > start && /^\s*\[[^\]]+\]/.test(l));
  if (end < 0) end = lines.length;
  const finals = lines.map((l,i) => i > start && i < end && /^\s*FINAL\s*,/i.test(l) ? i : -1).filter(i=>i>=0);
  if (finals.length !== 1) throw Error('Expected one original FINAL fallback; refusing to invent or replace it');
  const apnsMode=settings.apns || 'auto';
  const remoteMode=settings.remote || 'off';
  if(!['on','off'].includes(remoteMode))throw Error('Remote mode must be on or off');
  if (!['auto','proxy','off'].includes(apnsMode)) throw Error('APNs mode must be auto, proxy or off');
  const specificPush=lines.slice(start+1,end).map(l=>l.trim().split(',').map(p=>p.trim()))
    .filter(p=>/^(DOMAIN|DOMAIN-SUFFIX)$/i.test(p[0]) && /^(?:[^.]+\.)*push\.apple\.com$/i.test(p[1] || ''));
  const wantsProxy=specificPush.some(p=>p[2]==='PROXY');
  if(apnsMode==='auto' && specificPush.some(p=>!['PROXY','DIRECT'].includes(p[2])))
    throw Error('Custom APNs policy requires inspection; choose --apns proxy or off after reviewing the original group');
  if(apnsMode==='auto' && wantsProxy && specificPush.some(p=>p[2]!=='PROXY'))
    throw Error('Conflicting APNs policies; inspect them and explicitly choose --apns proxy or off');
  // Also retain a protection installed by a previous explicit --apns proxy export.
  const previouslyProtected=input.includes('# APNs proxy protection: Apple-specific ranges; no broad CDN proxy rules.');
  const protectApns=apnsMode==='proxy'||(apnsMode==='auto'&&(wantsProxy||previouslyProtected));
  const apns=protectApns ? ['DOMAIN-SUFFIX,push.apple.com,PROXY','DOMAIN-SUFFIX,push-apple.com.akadns.net,PROXY','DOMAIN-SUFFIX,courier-push-apple.com.akadns.net,PROXY',...APNS_RANGES.map(c=>
    (c.includes(':')?'IP-CIDR6,':'IP-CIDR,')+c+',PROXY,no-resolve')] : [];
  const priority = engine.guards.map(d=>'DOMAIN-SUFFIX,' + d + ',PROXY');
  const category = (key, target) => domainRules(sources[key] || '', target);
  for (const key of ['ai', 'apple-ai', 'github']) priority.push(...category(key, 'PROXY'));
  if(remoteMode==='on')priority.push(...REMOTES.filter(r=>r.policy==='PROXY').map(r=>'RULE-SET,'+r.url+','+r.policy));
  if(protectApns) priority.push('# APNs proxy protection: Apple-specific ranges; no broad CDN proxy rules.',...apns);
  priority.push(...category('private', 'DIRECT'));
  priority.push(...['localhost','local','lan','internal'].map(d=>'DOMAIN-SUFFIX,'+d+',DIRECT'));
  priority.push(...engine.privateRanges.map(c=>(c.includes(':')?'IP-CIDR6,':'IP-CIDR,')+c+',DIRECT'));
  if(remoteMode==='on')priority.push(...REMOTES.filter(r=>r.policy==='DIRECT').map(r=>'RULE-SET,'+r.url+','+r.policy));
  for (const key of ['baidu','icloud','apple-dev','apple-update']) priority.push(...category(key,'DIRECT'));
  for (const key of ['download-apple-cn','download-microsoft-cn']) priority.push(...category(key,'DIRECT'));
  const unique = [...new Set(priority)];
  const china = ['DOMAIN-SET,'+CNBASE+'_Domain.list,DIRECT', 'RULE-SET,'+CNBASE+'.list,DIRECT', 'GEOIP,CN,DIRECT'];
  const block = (name, rows) => [TAG+name+':begin', ...rows, TAG+name+':end'];
  const output = [...lines.slice(0,start+1), ...block('priority',unique), ...block('china',china), ...lines.slice(start+1)].join(newline);
  if (stripManaged(output.split(/\r?\n/)).join(newline) !== lines.join(newline)) throw Error('Original configuration changed');
  const dns=savingDns(output,settings.dns);
  return {output:dns.output,dnsChanges:dns.changes,dnsMode:settings.dns||'preserve',remoteRuleSets:remoteMode==='on'?REMOTES.length:0,
    priorityRules: unique.filter(r=>!r.startsWith('#')).length, originalRulesPreserved: true,
    domesticDirectBeforeSubscription: true, apnsProxyProtected: protectApns, apnsRules:apns.length};
}
function argumentsOf(argv) {
  const args = {};
  while (argv.length) {
    const k=argv.shift(); if (!/^--(input|output|source-dir|apns|dns|remote|http-proxy)$/.test(k)||!argv.length) throw Error('Usage: shadowrocket.cjs --output new.conf [--input original.conf] [--apns auto|proxy|off] [--dns preserve|saving] [--remote on|off] [--http-proxy URL] [--source-dir directory]');
    if (args[k.slice(2)]) throw Error('Duplicate argument'); args[k.slice(2)]=argv.shift();
  }
  if (!args.output) throw Error('--output is required');
  if(args['http-proxy']&&!/^https?:\/\/[^\s]+$/.test(args['http-proxy']))throw Error('Invalid HTTP proxy');
  return args;
}
function main(argv) {
  const args=argumentsOf(argv);
  const inputFile=path.resolve(args.input || path.join(__dirname,'../assets/shadowrocket.example.conf'));
  const outputFile=path.resolve(args.output), manifestFile=outputFile+'.manifest.json';
  if (outputFile === inputFile || fs.existsSync(outputFile) || fs.existsSync(manifestFile)) throw Error('Output must be new; source and existing files are never overwritten');
  const input=fs.readFileSync(inputFile,'utf8'), sources={}, manifest={format:1,generatedAt:new Date().toISOString(),inputSha256:sha(input),sources:{}};
  // Preflight the source before making network requests.
  merge(input,Object.fromEntries(KEYS.map(k=>[k,'validation.example'])),args);
  const fetchText=url=>{
    const result=cp.spawnSync('curl',['-fsSL','--connect-timeout','10','--max-time','30','--retry','1',...(args['http-proxy']?['--proxy',args['http-proxy']]:[]),url],{encoding:'utf8',timeout:75000,maxBuffer:2*1024*1024});
    if(result.status!==0)throw Error('Public category fetch failed; no output written');return result.stdout;
  };
  for (const key of KEYS) {
    const filename=engine.sources[key].replace(/\.mrs$/,'.list'), url=engine.sourceURL(key).replace(/\.mrs$/,'.list');
    let text;
    if (args['source-dir']) text=fs.readFileSync(path.join(args['source-dir'],path.basename(filename)),'utf8');
    else {
      text=fetchText(url);
    }
    domainRules(text,'DIRECT'); sources[key]=text;
    manifest.sources[key]={url,sha256:sha(text)};
  }
  manifest.remoteSources={};
  if(args.remote==='on')for(const remote of REMOTES){
    const text=args['source-dir']?fs.readFileSync(path.join(args['source-dir'],'remote-'+remote.name+'.list'),'utf8'):fetchText(remote.url);
    manifest.remoteSources[remote.name]={url:remote.url,rules:validateRemote(text),sha256:sha(text)};
  }
  const result=merge(input,sources,args); manifest.outputSha256=sha(result.output);manifest.priorityRules=result.priorityRules;
  manifest.dns={mode:result.dnsMode,changes:result.dnsChanges};
  manifest.apns={proxyProtected:result.apnsProxyProtected,rules:result.apnsRules,source:'https://support.apple.com/en-us/102266'};
  if(sha(fs.readFileSync(inputFile))!==manifest.inputSha256)throw Error('Source configuration changed during export; retry from the current file');
  fs.mkdirSync(path.dirname(outputFile),{recursive:true,mode:0o700});
  fs.writeFileSync(outputFile,result.output,{flag:'wx',mode:0o600});
  try {fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});}
  catch(error){fs.rmSync(outputFile);throw error;}
  return {outputFile,sourceUnchanged:sha(fs.readFileSync(inputFile))===manifest.inputSha256,priorityRules:result.priorityRules,
    originalRulesPreserved:true,domesticDirectBeforeSubscription:true,apnsProxyProtected:result.apnsProxyProtected,apnsRules:result.apnsRules,
    dnsMode:result.dnsMode,dnsSettingsChanged:result.dnsChanges.map(c=>c.key),remoteServiceRuleSets:result.remoteRuleSets,
    deviceImportAndRoutingVerificationRequired:true,categoryUpdates:'Native remote sets refresh through Shadowrocket; static guards/fallback categories refresh on export.'};
}
if (require.main===module) {try {console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={merge,domainRules,stripManaged,main,KEYS,APNS_RANGES,REMOTES,savingDns,validateRemote};
