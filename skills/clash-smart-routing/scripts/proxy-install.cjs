'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const r=require('./clash-router.cjs'),c=require('./proxy-context.cjs'),manager=require('./proxy-manager.cjs'),safety=require('./proxy-safety.cjs');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms));
function paths(){const home=os.homedir();return {binary:path.join(home,'.local/bin/proxy'),oldBinary:path.join(home,'.local/bin/clash-net'),loader:path.join(home,'.config/zsh/proxy.zsh'),zshrc:path.join(process.env.ZDOTDIR||home,'.zshrc')};}
function updateZshrc(text){const begin='# >>> proxy managed >>>',end='# <<< proxy managed <<<';const block=begin+'\nexport PATH="$HOME/.local/bin:$PATH"\n[[ -r "$HOME/.config/zsh/proxy.zsh" ]] && source "$HOME/.config/zsh/proxy.zsh"\n'+end;
 const managed=/# >>> proxy managed >>>[\s\S]*?# <<< proxy managed <<</g;
 const old=/^\[\[ -r ~\/\.config\/zsh\/proxy\.zsh \]\] && source ~\/\.config\/zsh\/proxy\.zsh[^\n]*$/m;
 if(managed.test(text))return text.replace(managed,block);
 if(old.test(text))return text.replace(old,block);
 const highlight=text.search(/^.*(?:# Syntax highlighting|source .*zsh-syntax-highlighting).*$/m);if(highlight>=0)return text.slice(0,highlight)+block+'\n\n'+text.slice(highlight);
 return text.trimEnd()+'\n\n'+block+'\n';}

function legacyNoProxy(text){const match=text.match(/^\s*local bypass='([^']*)'\s*$/m);if(!match)return [];const entries=match[1].split(',');c.noProxy(entries);return entries;}
function checkOwnership(p){
 if(fs.existsSync(p.binary)&&!fs.readFileSync(p.binary,'utf8').includes('Managed by clash-smart-routing proxy'))throw Error('Existing proxy executable is not managed by this skill');
 if(fs.existsSync(p.oldBinary)&&!fs.readFileSync(p.oldBinary,'utf8').includes('Managed by clash-smart-routing'))throw Error('Existing clash-net executable is not managed by this skill');
 if(fs.existsSync(p.loader)&&!/^# (?:Clash mixed|Managed by clash-smart-routing)/.test(fs.readFileSync(p.loader,'utf8')))throw Error('Existing zsh proxy script needs review before replacement');
}
async function setup({dryRun=false,fresh=false,platform=process.platform}={}){
 if(platform!=='darwin')throw Error('All-in-one setup currently supports macOS and zsh');
 const selected=r.activeSelection();if(selected.status!=='active')throw Error('Open exactly one configured proxy client before setup');
 const p=paths(),reset=require('./proxy-reset.cjs');let cleanup=fresh?reset.plan({root:selected.root}):null;if(!fresh)checkOwnership(p);
 for(const label of [...manager.legacy,manager.LABEL]){const f=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');if(!fresh&&fs.existsSync(f)&&!fs.readFileSync(f,'utf8').includes('clash-smart-routing'))throw Error('Unmanaged LaunchAgent collision: '+label);}
 const oldLoader=fs.existsSync(p.loader)?fs.readFileSync(p.loader,'utf8'):'';
 const files=[c.file('installation.json'),p.binary,p.oldBinary,p.loader,p.zshrc,manager.plist(),...manager.legacy.map(label=>path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'))];
 if(dryRun&&fresh)return {dryRun:true,clientName:selected.appName,...reset.summary(cleanup)};
 if(fresh&&cleanup.issues.length)throw Error('Fresh preflight requires review: '+cleanup.issues.join('; '));
 if(fresh)files.push(...cleanup.edits.map(x=>x.file),path.join(selected.root,'profiles.yaml'),r.load(selected.root).runtimeFile);
 if(dryRun)return {dryRun:true,clientName:selected.appName,files,automatic:true,events:'App lifecycle + config changes',fallbackSeconds:15};
 const transaction=await safety.begin(files,{timeoutMs:fresh?300000:180000,extraAgents:cleanup?.agents||[]});
 try{
  safety.stage(transaction,'installing');
  for(const label of new Set([...manager.legacy,...(cleanup?.agents||[]).map(x=>x.label)]))manager.stop(label);manager.stop();
  if(fresh){
   const j=safety.read(transaction);j.fresh={root:selected.root};const runtime=r.load(selected.root).runtimeFile;j.entries.find(e=>e.file===runtime).nativeGenerated=true;safety.save(transaction,j);
   await require('./proxy-system.cjs').quit(selected);
   const refreshed=reset.plan({root:selected.root});reset.recheck(cleanup,refreshed);cleanup=refreshed;if(cleanup.issues.length)throw Error('Fresh preflight changed after client exit');reset.apply(cleanup,transaction);
   for(const key of c.KEYS)c.launchctl('unsetenv',key);c.write('environment-owner.json',{baseline:Object.fromEntries(c.KEYS.map(k=>[k,null])),last:Object.fromEntries(c.KEYS.map(k=>[k,null]))});
   const opened=cp.spawnSync('/usr/bin/open',['-a',selected.app],{encoding:'utf8',timeout:5000});if(opened.status!==0)throw Error('Could not reopen client after fresh cleanup');
   let ready;for(let i=0;i<75;i++){ready=await c.discover();if(ready.phase==='ready'&&ready.selection.root===selected.root&&ready.systemProxy.matches)break;await pause(200)}
   if(ready?.phase!=='ready'||!ready.systemProxy?.matches)throw Error('Fresh client did not become ready');
  }
  const ctx=r.load(selected.root),api=r.controller(ctx,{timeoutMs:2000});
  let apply=false;try{await r.verify(ctx,api)}catch(e){if(ctx.client==='clash-app')throw Error('Import the generated routing script in native Clash and reconnect before setup: '+e.message);apply=true}
  const clientSettings=path.join(ctx.stateDir,'settings.json'),saved=fs.existsSync(clientSettings)?JSON.parse(fs.readFileSync(clientSettings,'utf8')):{};
  const enableLearning=ctx.capabilities?.learning!==false&&c.settings().learningEnabled&&(!saved.monitorEnabled||!ctx.config['rule-providers']?.['smart-routing-learned']);
  if(enableLearning)c.write('setup-routing.json',{monitorEnabled:true});
  if(fresh){
   if(JSON.stringify(ctx.config.rules||[])!==JSON.stringify(ctx.subscription.rules||[]))throw Error('Original subscription rules were not restored by native client');
   const io={write:(file,data)=>{safety.include(transaction,file);safety.write(transaction,file,data)}};await r.apply(ctx,api,{'settings-file':c.file('setup-routing.json')},io);
  }else if(apply||enableLearning)await r.main(['apply','--config-dir',selected.root,...(ctx.client==='flclash'?['--activate']:[]),...(enableLearning?['--settings-file',c.file('setup-routing.json')]:[])]);
  if(r.activeSelection().root!==selected.root)throw Error('Client changed during setup');
  const initial=await c.discover();if(initial.phase!=='ready')throw Error('Client proxy listener is not ready');
  if(!c.guiReady(initial)){await require('./proxy-system.cjs').enable(selected,transaction);const ready=await c.discover();if(!ready.systemProxy?.matches)throw Error('Native system proxy did not become ready');}
  if(!fs.existsSync(c.file('settings.json')))c.write('settings.json',{...c.settings(),noProxy:[...new Set([...c.settings().noProxy,...legacyNoProxy(oldLoader)])]});
  const current=Object.fromEntries(c.KEYS.map(k=>[k,c.launchctl('getenv',k)])),owner=c.read('environment-owner.json');
  c.write('environment-owner.json',{baseline:owner?.baseline||current,last:current});
  safety.write(transaction,p.binary,fs.readFileSync(path.join(__dirname,'proxy')),0o755);
  const shellAsset=path.resolve(__dirname,'../assets/proxy-shell.zsh');
  safety.write(transaction,p.loader,'# Managed by clash-smart-routing proxy shell loader\n'+(cleanup?.loaderRemainder||'')+'\nsource '+c.quote(shellAsset)+'\n');
  safety.write(transaction,p.zshrc,updateZshrc(fs.existsSync(p.zshrc)?fs.readFileSync(p.zshrc,'utf8'):''));
  if(fs.existsSync(p.oldBinary))safety.remove(transaction,p.oldBinary);
  for(const label of manager.legacy)safety.remove(transaction,path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'));
  safety.write(transaction,manager.plist(),manager.launchPlist());
  const installed=await manager.install();
  let state;for(let i=0;i<100;i++){state=c.read('runtime.json');if(managerReady(state,manager.serviceStatus(),selected.root))break;await pause(200)}
  if(!managerReady(state,manager.serviceStatus(),selected.root))throw Error('Manager did not publish a verified environment');
  const connectivity=await require('./node-recovery.cjs').main(['check']);if(connectivity.status!=='public-endpoint-ok')throw Error('Current ChatGPT public route did not pass verification');
  const gui=installed.events?await require('./proxy-gui.cjs').probe():{skipped:true,reason:'native-helper-unavailable'};if(!gui.skipped&&!gui.ok)throw Error('New native GUI proxy verification failed');
  if(fresh&&!reset.verifySubscriptions(cleanup))throw Error('A subscription changed during fresh setup');
  const prior=c.read('installation.json');safety.write(transaction,c.file('installation.json'),JSON.stringify({first:fresh?transaction:prior?.first||transaction,last:transaction,version:1},null,2)+'\n');
  safety.commit(transaction);
  return {installed:true,fresh,cleanup:fresh?{files:cleanup.edits.length,subscriptionsUnchanged:true}:undefined,clientName:state.clientName,ports:state.ports,eventMode:state.eventMode,manager:{...installed,...manager.serviceStatus()},backup:transaction,verification:{publicEndpoint:true,gui:gui.skipped?'skipped':true},
   shellActivation:'source ~/.config/zsh/proxy.zsh',guiNote:'launchctl changes apply to newly launched processes; restart an affected existing App if it uses old proxy variables'};
 }catch(e){safety.fail(transaction,e.message);throw Error(e.message+'; independent guard will restore Clash Verge. Backup: '+transaction);}
}
async function uninstall(){
 const installation=c.read('installation.json');if(!installation)throw Error('No managed proxy installation found');
 manager.stop();c.restoreLaunchd();const conflicts=await safety.restoreFiles(installation.first);
 const saved=safety.read(installation.first);
 for(const agent of saved.agents)if(agent.loaded&&fs.existsSync(agent.file)&&!manager.loaded(agent.label))cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),agent.file],{encoding:'utf8',timeout:10000});
 c.write('shell-env.zsh',c.shell({phase:'uninstalled'}));c.write('runtime.json',{phase:'uninstalled'});return {uninstalled:true,conflicts,privateBackupsRetained:true};
}
async function rollback(){const installation=c.read('installation.json');if(!installation)throw Error('No installation to roll back');const dir=installation.last;if(!dir.startsWith(c.file('backups/') )||!fs.existsSync(require('node:path').join(dir,'journal.json')))throw Error('Invalid installation journal');await safety.rollback(dir);safety.retire(dir);return {rolledBack:true,backup:dir};}
function managerReady(state,service,root){return !!(service.running&&service.pid&&state?.phase==='ready'&&state.managerPid===service.pid&&state.selection.root===root&&state.launchd?.ok);}
module.exports={managerReady,rollback,paths,updateZshrc,legacyNoProxy,checkOwnership,setup,uninstall};
