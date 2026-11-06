'use strict';
const fs=require('node:fs'),cp=require('node:child_process');
const c=require('./proxy-context.cjs'),r=require('./clash-router.cjs'),manager=require('./proxy-manager.cjs');
function workerReport(state,kind){if(state?.phase!=='ready')return null;const file=require('node:path').join(state.selection.root,'smart-routing-state',kind==='recovery'?'node-watchdog-report.json':'monitor-report.json');try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
async function status(){
 const state=await c.discover(),cached=c.read('runtime.json'),expected=c.variables(state),actual=Object.fromEntries(c.KEYS.map(k=>[k,c.launchctl('getenv',k)]));
 return {...state,selectionMode:'automatic',manager:manager.serviceStatus(),eventMode:cached?.eventMode||'not-running',metrics:cached?.metrics,
  shell:{optOut:process.env.PROXY_SHELL_MODE==='off',matches:c.KEYS.every(k=>(process.env[k]||null)===expected[k])},launchd:{matches:c.KEYS.every(k=>actual[k]===expected[k]),existingAppsNeedRestart:true},
  workers:cached?.workers||{},recovery:workerReport(state,'recovery'),learning:workerReport(state,'learning')};
}
function summary(s,brief=false){const lines=['当前客户端：'+(s.clientName||'未确定')+'（自动跟随）'];
 if(s.phase==='ready')lines.push('代理端口：HTTP '+s.ports.http+(s.ports.socks?' / SOCKS '+s.ports.socks:''));else lines.push('状态：'+s.phase);
 lines.push('当前终端：'+(s.shell.optOut?'已关闭':s.shell.matches?'已同步':'未同步；运行 proxy on'), 'GUI 网络：'+(s.transport==='native-vpn'?(s.vpn?.connected?'原生 VPN 已连接':'原生 VPN 未连接'):(s.systemProxy?.matches?'系统代理已同步':'系统代理未就绪')), '新 GUI 进程环境：'+(s.launchd.matches?'已同步':'未同步'));
 if(!brief)lines.push('后台管理：'+(s.manager.running?'运行中':'未运行')+'；事件模式：'+s.eventMode,'旧 GUI/常驻进程不会被修改环境；必要时重新启动该 App。');return lines.join('\n');}
async function feature(kind,args){const action=args[0]||'status';if(!['on','off','status'].includes(action))throw Error('Use on|off|status');
 if(action!=='status'){const settings=c.settings();settings[kind==='recovery'?'recoveryEnabled':'learningEnabled']=action==='on';c.write('settings.json',settings);}
 const state=c.read('runtime.json'),requestedEnabled=c.settings()[kind==='recovery'?'recoveryEnabled':'learningEnabled'],unavailable=kind==='learning'&&state?.capabilities?.learning===false;
 return {feature:kind,followingApp:state?.clientName||null,enabled:requestedEnabled&&!unavailable,requestedEnabled,reason:unavailable?'native-app-managed-configuration':null,worker:state?.workers?.[kind]||null,report:workerReport(state,kind)};}
async function main(argv){const args=[...argv],command=args.shift()||'on';
 if(['help','--help','-h'].includes(command))return 'proxy [on|off|status|doctor|check|recover|auto|monitor|config|audit|exec|setup|uninstall]\nBare proxy enables this terminal. proxy off affects this terminal only.\nproxy setup --fresh rebuilds legacy proxy configuration after backup (Verge/Rev); add --dry-run to preview.\nproxy setup --dry-run previews installation; proxy setup --rollback restores the last transaction.\nproxy check --gui probes a new native process using system proxy and launchd environment.';
 if(command==='setup'){if(args.some(x=>!['--rollback','--fresh','--dry-run'].includes(x))||args.includes('--rollback')&&args.length!==1)throw Error('Use setup [--fresh] [--dry-run] or setup --rollback');return args.includes('--rollback')?require('./proxy-install.cjs').rollback():require('./proxy-install.cjs').setup({dryRun:args.includes('--dry-run'),fresh:args.includes('--fresh')});}
 if(command==='check'&&args.includes('--gui'))return require('./proxy-gui.cjs').probe();
 if(command==='uninstall')return require('./proxy-install.cjs').uninstall();
 if(command==='status'||command==='doctor'){const s=await status();return args.includes('--json')?s:summary(s,args.includes('--brief'));}
 if(command==='env'){
  const state=args.includes('--cached')?c.read('runtime.json',{phase:'not-running'}):await c.discover();
  if(state.phase!=='ready'){if(args.includes('--quiet'))return c.shell(state);throw Error('No verified client listener is ready: '+state.phase)}
  return args.includes('--json')?c.variables(state):c.shell(state);
 }
 if(command==='on'||command==='off')throw Error('Current-shell changes require the installed zsh wrapper. Run: source ~/.config/zsh/proxy.zsh');
 if(command==='exec'){
  if(args[0]==='--')args.shift();if(!args.length)throw Error('proxy exec -- <command>');const state=await c.discover();if(state.phase!=='ready')throw Error('Proxy listener is not ready');
  const env={...c.cleanEnv(),...Object.fromEntries(Object.entries(c.variables(state)).filter(([,v])=>v!==null))};
  const child=cp.spawnSync(args[0],args.slice(1),{stdio:'inherit',env});if(child.error)throw child.error;process.exitCode=child.status??1;return;
 }
 if(command==='auto')return feature('recovery',args);
 if(command==='monitor')return feature('learning',args);
 if(command==='config'&&args[0]==='pair-clash-app'){const opts={};args.shift();while(args.length){const k=args.shift();if(k==='--allow-native-vpn'){opts.allowNativeVpn=true;continue}if(!['--controller','--secret-file'].includes(k)||!args.length)throw Error('Use config pair-clash-app --controller <local URL> --secret-file <private file> --allow-native-vpn');opts[k==='--controller'?'controller':'secretFile']=args.shift();}return require('./clash-app-client.cjs').register(opts);}
 if(command==='config')return r.main(args);
 if(['recover','plan','rollback','check'].includes(command)){
  const result=await require('./node-recovery.cjs').main([command,...args]);
  if(!['recovered','planned','rolled-back','public-endpoint-ok'].includes(result.status))process.exitCode=1;
  return args.includes('--json')?result:require('./node-recovery.cjs').summary(result);
 }
 if(command==='audit')return require('./traffic-audit.cjs').main(args);
 if(command==='export'&&args.shift()==='shadowrocket')return require('./shadowrocket.cjs').main(args);
 throw Error('Commands: setup, on, off, status, doctor, check, recover, plan, rollback, config, auto, monitor, env, exec, audit, export, uninstall');
}
if(require.main===module)main(process.argv.slice(2)).then(result=>{if(result!==undefined)console.log(typeof result==='string'?result:JSON.stringify(result,null,2))}).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={main,status,summary,feature};
