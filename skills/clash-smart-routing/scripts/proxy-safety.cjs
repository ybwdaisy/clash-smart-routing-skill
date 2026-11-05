'use strict';
// Independent, user-launchd rollback. The journal is private and never published.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const c=require('./proxy-context.cjs'),r=require('./clash-router.cjs'),manager=require('./proxy-manager.cjs');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms)),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function read(dir){return JSON.parse(fs.readFileSync(path.join(dir,'journal.json'),'utf8'));}
function save(dir,value){r.writePrivate(path.join(dir,'journal.json'),JSON.stringify(value,null,2)+'\n');}
function inspect(file){return fs.existsSync(file)?{exists:true,hash:hash(fs.readFileSync(file)),mode:fs.statSync(file).mode&0o777}:{exists:false,hash:null};}
function include(dir,file){const j=read(dir);active(j);if(j.entries.some(e=>e.file===file))return;const original=inspect(file),backup=path.join(dir,'file-'+j.entries.length);if(original.exists)r.writePrivate(backup,fs.readFileSync(file));j.entries.push({file,backup,original,expected:original});save(dir,j);}
function loaded(label){return cp.spawnSync('/bin/launchctl',['print','gui/'+process.getuid()+'/'+label],{encoding:'utf8',timeout:3000}).status===0;}
const xml=x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function begin(files,{timeoutMs=180000,extraAgents=[]}={}){
 const dir=c.file('backups/'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'));
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const entries=[];for(const file of [...new Set(files)]){const original=inspect(file),backup=path.join(dir,'file-'+entries.length);if(original.exists)r.writePrivate(backup,fs.readFileSync(file));entries.push({file,backup,original,expected:original});}
 const agents=[...new Map([...manager.legacy,manager.LABEL].map(label=>({label,file:path.join(os.homedir(),'Library/LaunchAgents',label+'.plist')})).concat(extraAgents).map(a=>[a.label,{...a,loaded:loaded(a.label)}])).values()];
 const selected=r.activeSelection(),fallback=selected.status==='active'&&selected.client==='verge'?selected.root:r.discover().find(root=>path.basename(root)!=='com.follow.clash')||r.resolveConfigDir();
 const fallbackApp=selected.status==='active'&&selected.root===fallback?selected.app:null;
 const started=cp.spawnSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).stdout.trim();
 const journal={version:1,phase:'armed',deadline:Date.now()+timeoutMs,workerPid:process.pid,workerStarted:started,entries,agents,fallback,fallbackApp,environmentOwner:c.read('environment-owner.json'),launchd:Object.fromEntries(c.KEYS.map(k=>[k,c.launchctl('getenv',k)])),label:'io.github.clash-smart-routing.proxy-guard-'+path.basename(dir)};
 save(dir,journal);
 const plist=path.join(os.homedir(),'Library/LaunchAgents',journal.label+'.plist');
 const args=[process.execPath,fs.realpathSync(__filename),'guard',dir].map(x=>'<string>'+xml(x)+'</string>').join('');
 r.writePrivate(plist,'<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>'+journal.label+'</string><key>ProgramArguments</key><array>'+args+'</array><key>RunAtLoad</key><true/><key>StandardErrorPath</key><string>'+xml(path.join(dir,'guard-error.log'))+'</string></dict></plist>');
 const boot=cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist],{encoding:'utf8',timeout:5000});if(boot.status!==0)throw Error('Cannot arm independent rollback guard');
 for(let i=0;i<50&&!fs.existsSync(path.join(dir,'ready'));i++)await pause(100);
 if(!fs.existsSync(path.join(dir,'ready')))throw Error('Independent guard did not acknowledge readiness');
 return dir;
}
function active(j){if(['rolling-back','rolled-back','committed','failed'].includes(j.phase)||Date.now()>j.deadline)throw Error('Transaction is no longer active');}
function write(dir,file,data,mode=0o600){const j=read(dir);active(j);const e=j.entries.find(x=>x.file===file);if(!e)throw Error('File was not included in transaction');e.expected={exists:true,hash:hash(data)};save(dir,j);r.writePrivate(file,data);fs.chmodSync(file,mode);}
function remove(dir,file){const j=read(dir);active(j);const e=j.entries.find(x=>x.file===file);if(!e)throw Error('File was not included in transaction');e.expected={exists:false,hash:null};save(dir,j);fs.rmSync(file,{force:true});}
function stage(dir,phase){const j=read(dir);if(j.phase==='rolling-back'||j.phase==='rolled-back')throw Error('Rollback already began');save(dir,{...j,phase});}
function retire(dir){const j=read(dir),target='gui/'+process.getuid()+'/'+j.label;if(loaded(j.label))cp.spawnSync('/bin/launchctl',['bootout',target],{encoding:'utf8',timeout:5000});fs.rmSync(path.join(os.homedir(),'Library/LaunchAgents',j.label+'.plist'),{force:true});}
function commit(dir){stage(dir,'committed');retire(dir);}
function fail(dir,message){const j=read(dir);save(dir,{...j,phase:'failed',failure:message});}
async function restoreFiles(dir){const j=read(dir),conflicts=[];for(const e of [...j.entries].reverse()){
 const actual=inspect(e.file);if(actual.exists===e.original.exists&&actual.hash===e.original.hash)continue;
 if(!e.nativeGenerated&&(actual.exists!==e.expected.exists||actual.hash!==e.expected.hash)){conflicts.push(e.file);continue;}
 if(e.original.exists){r.writePrivate(e.file,fs.readFileSync(e.backup));fs.chmodSync(e.file,e.original.mode||0o600)}else fs.rmSync(e.file,{force:true});
 }return conflicts;
}
async function restoreVerge(root,app){
 const isFl=path.basename(root)==='com.follow.clash';
 const fl=require('./flclash-client.cjs');if(!isFl)try{await fl.quit()}catch{const p=cp.spawnSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'});for(const line of p.stdout.split('\n')){const m=line.trim().match(/^(\d+)\s+(.*)$/);if(m&&m[2].startsWith('/Applications/FlClash.app/Contents/MacOS/'))try{process.kill(Number(m[1]),'SIGTERM')}catch{}}}
 if(isFl)cp.spawnSync('/usr/bin/osascript',['-e','tell application "Clash Verge" to quit'],{encoding:'utf8',timeout:8000});
 cp.spawnSync('/usr/bin/open',['-a',app||(isFl?'/Applications/FlClash.app':'/Applications/Clash Verge.app')],{encoding:'utf8',timeout:5000});
 let ctx;for(let i=0;i<60;i++){try{ctx=r.load(root);await r.controller(ctx,{followActive:false,timeoutMs:1000})('GET','/configs');break}catch{ctx=null;await pause(500)}}
 if(!ctx)throw Error('Verge controller did not restart');
 // The client normally restores its own system proxy. Only repair matching loopback endpoints if necessary.
 const port=Number(ctx.config['mixed-port']||ctx.config.port);let proxy=require('./client-readiness.cjs').systemProxy();
 if(!c.systemMatches(proxy,{http:port,socks:port})){
  const services=cp.spawnSync('/usr/sbin/networksetup',['-listallnetworkservices'],{encoding:'utf8'}).stdout.split('\n').slice(1).filter(s=>s&&!s.startsWith('*'));
  for(const name of services)for(const kind of ['web','secureweb','socksfirewall']){
   const old=cp.spawnSync('/usr/sbin/networksetup',['-get'+kind+'proxy',name],{encoding:'utf8'}).stdout;
   if(!/Server: (127\.0\.0\.1|localhost)/.test(old))continue;
   cp.spawnSync('/usr/sbin/networksetup',['-set'+kind+'proxy',name,'127.0.0.1',String(port)],{encoding:'utf8'});cp.spawnSync('/usr/sbin/networksetup',['-set'+kind+'proxystate',name,'on'],{encoding:'utf8'});
  }
 }
 const rec=require('./node-recovery.cjs'),api=r.controller(ctx,{followActive:false}),p=(await api('GET','/proxies')).proxies,main=r.engine.upstreamTarget(ctx.config,{}),node=rec.resolve(p,main);
 const probe=await rec.publicProbe(ctx,api,main,node.node);return {client:ctx.client,port,node:node.node,publicHttp:probe.httpStatus,publicReachable:probe.publicEndpointReachable};
}
async function rollback(dir){
 const claim=path.join(dir,'rollback-claimed');try{fs.writeFileSync(claim,'1',{flag:'wx',mode:0o600})}catch(e){if(e.code==='EEXIST')return;throw e}
 let j=read(dir);save(dir,{...j,phase:'rolling-back'});
 if(j.workerPid&&j.workerPid!==process.pid){const start=cp.spawnSync('/bin/ps',['-p',String(j.workerPid),'-o','lstart='],{encoding:'utf8'}).stdout.trim();if(start&&start===j.workerStarted)try{process.kill(j.workerPid,'SIGTERM')}catch{}}
 try{manager.stop()}catch{}for(const a of j.agents)try{manager.stop(a.label)}catch{}
 if(j.fresh){try{const selected=r.activeSelection();if(selected.status==='active'&&selected.root===j.fresh.root)await require('./proxy-system.cjs').quit(selected)}catch{}}
 const owner=c.read('environment-owner.json');for(const k of c.KEYS){const value=c.launchctl('getenv',k);if(!owner||value===owner.last[k]){c.launchctl(j.launchd[k]===null?'unsetenv':'setenv',k,j.launchd[k]===null?undefined:j.launchd[k]);if(owner)owner.last[k]=j.launchd[k];}}if(owner)c.write('environment-owner.json',{...(j.environmentOwner||{baseline:j.launchd}),last:owner.last});
 const conflicts=await restoreFiles(dir);let fallback,error;
 if(j.nativePreferences){try{const fl=require('./flclash-client.cjs');await fl.quit();const n=j.nativePreferences;const prefs=fl.preferences(n.root);for(const x of n.changes){if(String(prefs[x.section][x.key])===String(x.after))prefs[x.section][x.key]=x.before;else conflicts.push('FlClash native preference '+x.section+'.'+x.key)}fl.writePreferences(prefs)}catch{conflicts.push('FlClash native preferences')}}
 try{fallback=await restoreVerge(j.fallback,j.fallbackApp)}catch(e){error=e.message}
 for(const a of j.agents)if(a.loaded&&fs.existsSync(a.file)&&!loaded(a.label))cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),a.file],{encoding:'utf8',timeout:10000});
 j=read(dir);save(dir,{...j,phase:'rolled-back',conflicts,fallback,error,finishedAt:new Date().toISOString()});
}
async function guard(dir){fs.writeFileSync(path.join(dir,'ready'),String(process.pid),{mode:0o600});while(true){const j=read(dir);if(['committed','rolled-back'].includes(j.phase))return;if(j.phase==='failed'||Date.now()>j.deadline){await rollback(dir);fs.rmSync(path.join(os.homedir(),'Library/LaunchAgents',j.label+'.plist'),{force:true});const cleanup=cp.spawn('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+j.label],{detached:true,stdio:'ignore',env:c.cleanEnv()});cleanup.unref();return;}await pause(500)}}
if(require.main===module&&process.argv[2]==='guard')guard(process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={begin,read,save,include,write,remove,stage,commit,fail,restoreFiles,rollback,retire,restoreVerge};
