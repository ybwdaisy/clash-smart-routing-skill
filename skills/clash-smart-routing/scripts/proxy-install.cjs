'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const r=require('./clash-router.cjs'),c=require('./proxy-context.cjs'),manager=require('./proxy-manager.cjs'),safety=require('./proxy-safety.cjs');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms));
function paths(){const home=os.homedir();return {binary:path.join(home,'.local/bin/proxy'),oldBinary:path.join(home,'.local/bin/clash-net'),loader:path.join(home,'.config/zsh/proxy.zsh'),zshrc:path.join(home,'.zshrc')};}
function updateZshrc(text){const begin='# >>> proxy managed >>>',end='# <<< proxy managed <<<';const block=begin+'\nexport PATH="$HOME/.local/bin:$PATH"\n[[ -r "$HOME/.config/zsh/proxy.zsh" ]] && source "$HOME/.config/zsh/proxy.zsh"\n'+end;
 const managed=/# >>> proxy managed >>>[\s\S]*?# <<< proxy managed <<</g;
 const old=/^\[\[ -r ~\/\.config\/zsh\/proxy\.zsh \]\] && source ~\/\.config\/zsh\/proxy\.zsh[^\n]*$/m;
 if(managed.test(text))return text.replace(managed,block);
 if(old.test(text))return text.replace(old,block);
 return text.trimEnd()+'\n\n'+block+'\n';}

function legacyNoProxy(text){const match=text.match(/^\s*local bypass='([^']*)'\s*$/m);if(!match)return [];const entries=match[1].split(',');c.noProxy(entries);return entries;}
function checkOwnership(p){
 if(fs.existsSync(p.binary)&&!fs.readFileSync(p.binary,'utf8').includes('Managed by clash-smart-routing proxy'))throw Error('Existing proxy executable is not managed by this skill');
 if(fs.existsSync(p.oldBinary)&&!fs.readFileSync(p.oldBinary,'utf8').includes('Managed by clash-smart-routing'))throw Error('Existing clash-net executable is not managed by this skill');
 if(fs.existsSync(p.loader)&&!/^# (?:Clash mixed|Managed by clash-smart-routing)/.test(fs.readFileSync(p.loader,'utf8')))throw Error('Existing zsh proxy script needs review before replacement');
}
async function setup({dryRun=false}={}){
 if(process.platform!=='darwin')throw Error('All-in-one setup currently supports macOS and zsh');
 const selected=r.activeSelection();if(selected.status!=='active')throw Error('Open exactly one configured proxy client before setup');
 const p=paths();checkOwnership(p);
 for(const label of [...manager.legacy,manager.LABEL]){const f=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');if(fs.existsSync(f)&&!fs.readFileSync(f,'utf8').includes('clash-smart-routing'))throw Error('Unmanaged LaunchAgent collision: '+label);}
 const oldLoader=fs.existsSync(p.loader)?fs.readFileSync(p.loader,'utf8'):'';
 const files=[c.file('installation.json'),p.binary,p.oldBinary,p.loader,p.zshrc,manager.plist(),...manager.legacy.map(label=>path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'))];
 if(dryRun)return {dryRun:true,clientName:selected.appName,files,automatic:true,events:'App lifecycle + config changes',fallbackSeconds:15};
 const transaction=await safety.begin(files);
 try{
  safety.stage(transaction,'installing');
  for(const label of manager.legacy)manager.stop(label);manager.stop();
  const ctx=r.load(selected.root),api=r.controller(ctx,{timeoutMs:2000});
  let apply=false;try{await r.verify(ctx,api)}catch{apply=true}
  const clientSettings=path.join(ctx.stateDir,'settings.json'),saved=fs.existsSync(clientSettings)?JSON.parse(fs.readFileSync(clientSettings,'utf8')):{};
  const enableLearning=c.settings().learningEnabled&&(!saved.monitorEnabled||!ctx.config['rule-providers']?.['smart-routing-learned']);
  if(enableLearning)c.write('setup-routing.json',{monitorEnabled:true});
  if(apply||enableLearning)await r.main(['apply','--config-dir',selected.root,...(ctx.client==='flclash'?['--activate']:[]),...(enableLearning?['--settings-file',c.file('setup-routing.json')]:[])]);
  if(r.activeSelection().root!==selected.root)throw Error('Client changed during setup');
  const initial=await c.discover();if(initial.phase!=='ready')throw Error('Client proxy listener is not ready');
  if(!initial.systemProxy.matches){await require('./proxy-system.cjs').enable(selected,transaction);const ready=await c.discover();if(!ready.systemProxy?.matches)throw Error('Native system proxy did not become ready');}
  if(!fs.existsSync(c.file('settings.json')))c.write('settings.json',{...c.settings(),noProxy:[...new Set([...c.settings().noProxy,...legacyNoProxy(oldLoader)])]});
  const current=Object.fromEntries(c.KEYS.map(k=>[k,c.launchctl('getenv',k)])),owner=c.read('environment-owner.json');
  c.write('environment-owner.json',{baseline:owner?.baseline||current,last:current});
  safety.write(transaction,p.binary,fs.readFileSync(path.join(__dirname,'proxy')),0o755);
  const shellAsset=path.resolve(__dirname,'../assets/proxy-shell.zsh');
  safety.write(transaction,p.loader,'# Managed by clash-smart-routing proxy shell loader\nsource '+c.quote(shellAsset)+'\n');
  safety.write(transaction,p.zshrc,updateZshrc(fs.existsSync(p.zshrc)?fs.readFileSync(p.zshrc,'utf8'):''));
  if(fs.existsSync(p.oldBinary))safety.remove(transaction,p.oldBinary);
  for(const label of manager.legacy)safety.remove(transaction,path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'));
  safety.write(transaction,manager.plist(),manager.launchPlist());
  const installed=await manager.install();
  let state;for(let i=0;i<100;i++){state=c.read('runtime.json');if(managerReady(state,manager.serviceStatus(),selected.root))break;await pause(200)}
  if(!managerReady(state,manager.serviceStatus(),selected.root))throw Error('Manager did not publish a verified environment');
  const connectivity=await require('./node-recovery.cjs').main(['check']);if(connectivity.status!=='public-endpoint-ok')throw Error('Current ChatGPT public route did not pass verification');
  const gui=installed.events?await require('./proxy-gui.cjs').probe():{skipped:true,reason:'native-helper-unavailable'};if(!gui.skipped&&!gui.ok)throw Error('New native GUI proxy verification failed');
  const prior=c.read('installation.json');safety.write(transaction,c.file('installation.json'),JSON.stringify({first:prior?.first||transaction,last:transaction,version:1},null,2)+'\n');
  safety.commit(transaction);
  return {installed:true,clientName:state.clientName,ports:state.ports,eventMode:state.eventMode,manager:{...installed,...manager.serviceStatus()},backup:transaction,verification:{publicEndpoint:true,gui:gui.skipped?'skipped':true},
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
