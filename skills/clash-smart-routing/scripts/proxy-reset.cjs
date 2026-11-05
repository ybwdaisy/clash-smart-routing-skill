'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const YAML=require('yaml'),shell=require('./proxy-clean-shell.cjs'),c=require('./proxy-context.cjs'),r=require('./clash-router.cjs');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const IDENTITY=['mixed-port','port','socks-port','redir-port','tproxy-port','bind-address','external-controller','external-controller-unix','external-controller-pipe','external-controller-cors','secret','external-ui'];
const EXTENSIONS=new Set(['merge','script','rules','proxies','groups']);
function nativeCore(config){return {...Object.fromEntries(IDENTITY.filter(k=>Object.hasOwn(config,k)).map(k=>[k,config[k]])),mode:'rule',tun:{enable:false},'allow-lan':false,'log-level':'info'};}
function neutral(type){return type==='script'?'function main(config) { return config; }\n':type==='merge'?'{}\n':'prepend: []\nappend: []\ndelete: []\n';}
function decode(text){return text.replace(/&(amp|lt|gt|quot|apos);/g,(_,k)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[k]);}
function agent(file){
 let doc;if(process.platform==='darwin'){const x=cp.spawnSync('/usr/bin/plutil',['-convert','json','-o','-',file],{encoding:'utf8',timeout:2000});if(x.status!==0)throw Error('Unreadable LaunchAgent');doc=JSON.parse(x.stdout)}else{
  const text=fs.readFileSync(file,'utf8');doc={Label:decode(text.match(/<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/)?.[1]||''),ProgramArguments:[...(text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1]||'').matchAll(/<string>([\s\S]*?)<\/string>/g)].map(x=>decode(x[1]))};
 }
 const args=doc.ProgramArguments||[],knownLabel=/^io\.github\.clash-smart-routing\.(?:proxy-manager|monitor|node-watchdog)$/.test(doc.Label);
 const known=knownLabel&&args.some(x=>/\/(?:node-watchdog|routing-monitor|proxy-manager)\.cjs$/.test(x));
 const envOnly=/^(?:\/bin\/)?launchctl$/.test(args[0]||'')&&['setenv','unsetenv'].includes(args[1])&&c.KEYS.includes(args[2])&&args.length===(args[1]==='setenv'?4:3);
 const script=args.find(x=>/^\//.test(x)&&/^(?:proxy(?:[-_][\w-]+)?|clash-net)(?:\.(?:cjs|js|sh|zsh))?$/.test(path.basename(x)));
 let dedicated=false;if(script&&fs.existsSync(script)&&fs.statSync(script).isFile()&&fs.statSync(script).size<512*1024){const text=fs.readFileSync(script,'utf8'),parsed=shell.clean(text),tail=args.slice(args.indexOf(script)+1),control=!tail.length||['on','off','auto','monitor','watch','recover','status','check','setup'].includes(tail[0]);dedicated=parsed.removed>0&&parsed.issues.length===0&&parsed.text.split('\n').every(line=>!line.trim()||line.trim().startsWith('#'))||control&&/^# Managed by clash-smart-routing/m.test(text);}
 const client=args.some(x=>/\.app(?:\/Contents\/MacOS\/[^\s]+)?$/.test(x));
 return {label:doc.Label,proxy:!!(known||envOnly||dedicated&&!client),suspicious:(knownLabel||!client&&/proxy|clash-net/i.test(doc.Label||''))&&!known&&!envOnly&&!dedicated,script,environmentKeys:Object.keys(doc.EnvironmentVariables||{}).filter(k=>c.KEYS.includes(k))};
}
function plan({home=os.homedir(),root,proxyHome=c.base(),env=process.env}={}){
 if(!root||!fs.existsSync(path.join(root,'profiles.yaml')))throw Error('Fresh rebuild currently supports macOS Clash Verge/Rev; FlClash retains normal setup');
 const edits=new Map(),issues=[],agents=[],visited=new Set();
 function safe(file){const parent=path.dirname(file);if(!path.resolve(file).startsWith(path.resolve(home)+path.sep)&&!path.resolve(file).startsWith(path.resolve(root)+path.sep))throw Error('Cleanup path is outside this user/client');if(fs.existsSync(file)&&(fs.lstatSync(file).isSymbolicLink()||!fs.lstatSync(file).isFile()))throw Error('Cleanup requires a regular file: '+file);if(fs.existsSync(parent)&&fs.realpathSync(parent)!==path.resolve(parent))throw Error('Cleanup parent is symlinked: '+parent);}
 function edit(file,text,kind){safe(file);edits.set(file,{file,text,kind,before:fs.existsSync(file)?hash(fs.readFileSync(file)):null,mode:fs.existsSync(file)?fs.statSync(file).mode&0o777:0o600});}
 const loader=path.join(home,'.config/zsh/proxy.zsh');let loaderRemainder='';
 const dotdir=env.ZDOTDIR?path.resolve(env.ZDOTDIR):home;
 if(!dotdir.startsWith(home+path.sep)&&dotdir!==home)issues.push('ZDOTDIR is outside this user home');
 const queue=[...new Set([home,dotdir])].flatMap(base=>['.zshrc','.zprofile','.zshenv','.zlogin'].map(name=>path.join(base,name)));
 if(fs.existsSync(loader))queue.push(loader);
 while(queue.length&&visited.size<48){const file=queue.shift();if(visited.has(file)||!fs.existsSync(file))continue;visited.add(file);safe(file);const text=fs.readFileSync(file,'utf8');if(text.length>512*1024){issues.push('Oversized shell file: '+file);continue}
  if(file===loader&&text.startsWith('# Managed by clash-smart-routing')){edit(file,'','old-shell-loader');continue}
  const cleaned=shell.clean(text,{home,loader});if(cleaned.text!==text&&fs.existsSync('/bin/zsh')){const check=cp.spawnSync('/bin/zsh',['-f','-n'],{input:cleaned.text,encoding:'utf8',timeout:2000});if(check.status!==0)issues.push(file+': cleaned shell syntax requires review')}for(const issue of cleaned.issues)issues.push(file+': '+issue);
  if(file===loader)loaderRemainder=cleaned.text;
  if(cleaned.text!==text||file===loader)edit(file,cleaned.text,'shell');
  for(const line of text.split('\n')){if(line.trim().startsWith('#'))continue;const tokens=shell.words(line).rows,i=tokens.findIndex(x=>['source','.'].includes(x.raw));if(i<0||!tokens[i+1])continue;const target=shell.literal(tokens[i+1].raw,home);if(!target){if(/proxy|clash-net/i.test(tokens[i+1].raw))issues.push(file+': dynamic proxy source requires review');continue}const resolved=path.resolve(target);if(resolved===loader)continue;if(!resolved.startsWith(home+path.sep)||resolved.includes('/skills/clash-smart-routing/'))continue;if(fs.existsSync(resolved)&&fs.statSync(resolved).isFile()&&fs.statSync(resolved).size<512*1024)queue.push(resolved)}
 }
 if(queue.length)issues.push('Shell source inventory exceeded 48 files');
 for(const dir of new Set([path.join(home,'.local/bin'),path.join(home,'bin'),path.join(home,'.bin'),...(env.PATH||'').split(path.delimiter).filter(x=>x.startsWith(home+path.sep)&&!x.includes('/skills/'))]))for(const name of ['proxy','clash-net']){const file=path.join(dir,name);if(fs.existsSync(file))edit(file,null,'old-command')}
 const launch=path.join(home,'Library/LaunchAgents');if(fs.existsSync(launch))for(const name of fs.readdirSync(launch).filter(x=>x.endsWith('.plist'))){const file=path.join(launch,name);let a;try{a=agent(file)}catch{if(/proxy|clash-net/i.test(name))issues.push('Unrecognized proxy LaunchAgent: '+file);continue}if(a.environmentKeys.length&&!a.proxy)issues.push('Mixed-purpose LaunchAgent sets proxy environment: '+file);if(a.suspicious)issues.push('Unrecognized proxy LaunchAgent: '+file);if(a.proxy){if(!a.label||!/^[\w.-]+$/.test(a.label))throw Error('Unsafe LaunchAgent label');if(agents.some(x=>x.label===a.label))issues.push('Duplicate proxy service label: '+a.label);agents.push({file,label:a.label});edit(file,null,'old-service');if(a.script&&a.script.startsWith(home+path.sep)&&!a.script.includes('/skills/')&&fs.existsSync(a.script))edit(a.script,null,'old-service-script')}}
 const registry=YAML.parse(fs.readFileSync(path.join(root,'profiles.yaml'),'utf8'));
 if(!Array.isArray(registry.items)||!registry.items.some(x=>x.uid===registry.current&&['remote','local'].includes(x.type)))throw Error('Unsupported active subscription registry');
 const profileDir=path.join(root,'profiles'),subscriptions=[];
 for(const item of registry.items){if(!item.file||path.basename(item.file)!==item.file)throw Error('Unsafe profile filename');const file=path.join(profileDir,item.file);if(['local','remote'].includes(item.type)){if(!fs.existsSync(file))throw Error('Subscription file missing');subscriptions.push({file,sha256:hash(fs.readFileSync(file))});}else if(EXTENSIONS.has(item.type))edit(file,neutral(item.type),'client-override');else issues.push('Unknown profile extension type: '+item.type)}
 if(subscriptions.some(x=>edits.has(x.file)))throw Error('An extension aliases a subscription file');
 const coreFile=path.join(root,'config.yaml');if(!fs.existsSync(coreFile))throw Error('Native core config.yaml is missing');edit(coreFile,YAML.stringify(nativeCore(YAML.parse(fs.readFileSync(coreFile,'utf8')))),'native-core');
 const preferences=path.join(root,'verge.yaml'),doc=YAML.parseDocument(fs.readFileSync(preferences,'utf8'));
 for(const [k,v]of Object.entries({enable_builtin_enhanced:true,enable_tun_mode:false,enable_system_proxy:true,enable_proxy_guard:false,proxy_auto_config:false,enable_dns_settings:false,profile_dns_settings:null,startup_script:null,use_default_bypass:true,system_proxy_bypass:null,proxy_host:'127.0.0.1'}))doc.set(k,v);
 edit(preferences,String(doc),'native-proxy');if(fs.existsSync(path.join(root,'dns_config.yaml')))edit(path.join(root,'dns_config.yaml'),'{}\n','old-dns-override');
 for(const name of ['state.json','settings.json','verification.json','learned.yaml']){const file=path.join(root,'smart-routing-state',name);if(fs.existsSync(file))edit(file,null,'old-routing-state')}
 const settings=path.join(proxyHome,'settings.json');edit(settings,JSON.stringify({recoveryEnabled:true,learningEnabled:true,noProxy:c.defaults().noProxy},null,2)+'\n','new-settings');
 const binding=path.join(home,'.config/clash-net/client.json');if(fs.existsSync(binding))edit(binding,null,'old-binding');
 return {home,root,edits:[...edits.values()],agents,issues:[...new Set(issues)],subscriptions,loaderRemainder,coreIdentity:IDENTITY};
}
function summary(p){return {fresh:true,supportedClient:'Clash Verge/Rev',files:p.edits.map(x=>({file:x.file,operation:x.text===null?'remove':'replace',kind:x.kind})),agents:p.agents.map(x=>x.label),subscriptionsPreserved:p.subscriptions.length,issues:p.issues,ready:p.issues.length===0,backups:'Private transaction snapshot; no original files removed before guard readiness'};}
function apply(p,transaction,safety=require('./proxy-safety.cjs')){if(p.issues.length)throw Error('Fresh preflight has unresolved items');for(const x of p.edits){const actual=fs.existsSync(x.file)?hash(fs.readFileSync(x.file)):null;if(actual!==x.before)throw Error('Cleanup input changed after preview: '+x.file)}for(const x of p.edits){safety.include(transaction,x.file);if(x.text===null)safety.remove(transaction,x.file);else safety.write(transaction,x.file,x.text,x.mode)}}
function recheck(before,after){
 const same=require('node:util').isDeepStrictEqual;
 if(!same(before.agents,after.agents)||!same(before.subscriptions,after.subscriptions))throw Error('Cleanup services or subscriptions changed during shutdown');
 for(const old of before.edits){const current=after.edits.find(x=>x.file===old.file);if(!current)throw Error('Cleanup target disappeared during shutdown: '+old.file);
  if(old.kind==='native-proxy'){if(!same(YAML.parse(old.text),YAML.parse(current.text)))throw Error('Unrelated client preferences changed during shutdown');}
  else if(!['native-core','old-routing-state'].includes(old.kind)&&old.before!==current.before)throw Error('Cleanup input changed during shutdown: '+old.file);
 }
 if(after.edits.some(x=>!before.edits.some(old=>old.file===x.file)))throw Error('New cleanup target appeared during shutdown');
}
function verifySubscriptions(p){return p.subscriptions.every(x=>fs.existsSync(x.file)&&hash(fs.readFileSync(x.file))===x.sha256);}
module.exports={recheck,plan,summary,apply,verifySubscriptions,nativeCore,neutral,agent,IDENTITY};
