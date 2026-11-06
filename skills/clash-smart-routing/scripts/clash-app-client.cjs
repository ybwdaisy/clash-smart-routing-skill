'use strict';
// App Store Clash (ProjectClash, com.hako.network). Never opens its protected
// App Group or edits subscription storage. Native UI owns configuration writes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process');
const ID='com.hako.network',APP='/Applications/Clash.app';
const root=()=>path.join(process.env.PROXY_HOME||path.join(os.homedir(),'.config/proxy'),'clients',ID);
const isClient=dir=>path.basename(dir)===ID&&fs.existsSync(path.join(dir,'native.json'));
function endpoint(value){const u=new URL(value);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!u.port)throw Error('Clash App controller must be an authenticated local HTTP endpoint');return u;}
function save(dir,name,value){const file=path.join(dir,name),text=JSON.stringify(value,null,2)+'\n';if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===text)return;require('./clash-router.cjs').writePrivate(file,text);}
function load(dir){
 const native=JSON.parse(fs.readFileSync(path.join(dir,'native.json'),'utf8'));endpoint(native.controller);
 if(native.bundleId!==ID||native.allowNativeVpn!==true||typeof native.secret!=='string'||native.secret.length<16)throw Error('Pair native Clash with explicit VPN permission and a private controller secret first');
 let observed={};try{observed=JSON.parse(fs.readFileSync(path.join(dir,'observed.json'),'utf8'))}catch{}
 return {client:'clash-app',clientName:'Clash',root:dir,native,config:{...observed,...readPorts(dir),'external-controller':new URL(native.controller).host,secret:native.secret},subscription:observed,
  subscriptionFile:path.join(dir,'observed.json'),stateDir:path.join(dir,'smart-routing-state'),sourceEvidenceKind:'controller-observation',capabilities:{learning:false,configReload:false,nativeVpn:true}};
}
function policy(rules,proxies){
 const match=rules.filter(r=>r.type==='Match');if(match.length!==1)throw Error('Cannot identify one native subscription fallback');
 const original=rules.filter(r=>!(r.type==='RuleSet'&&String(r.payload).startsWith('smart-routing-'))).map(r=>({type:r.type,payload:r.payload||'',proxy:r.proxy}));
 const nodes=Object.entries(proxies).filter(([,p])=>!Array.isArray(p.all)).map(([name,p])=>({name,type:String(p.type).toLowerCase()})).sort((a,b)=>a.name.localeCompare(b.name));
 const groups=Object.entries(proxies).filter(([name,p])=>Array.isArray(p.all)&&name!=='Smart Routing · Proxy'&&name!=='GLOBAL').map(([name,p])=>({name,type:({Selector:'select',URLTest:'url-test',Fallback:'fallback',LoadBalance:'load-balance',Relay:'relay'})[p.type]||p.type,proxies:[...p.all],url:p.testUrl||p.testURL})).sort((a,b)=>a.name.localeCompare(b.name));
 // This is an observation for recovery consistency, never a claim to have read
 // or backed up the native subscription file or its credentials.
 return {rules:['MATCH,'+match[0].proxy],proxies:nodes,'proxy-groups':groups,observedRules:original};
}
function controller(ctx,options={}){
 const u=endpoint(ctx.native.controller);let identified=false;
 async function raw(method,route,data){
  if(options.followActive??process.env.CLASH_NET_FOLLOW_ACTIVE==='1')(options.activeCheck||require('./clash-router.cjs').assertActive)(ctx.root);
  return new Promise((yes,no)=>{const body=data===undefined?undefined:JSON.stringify(data);const request=http.request({hostname:u.hostname.replace(/^\[|\]$/g,''),port:u.port,path:route,method,timeout:options.timeoutMs||8000,headers:{Authorization:'Bearer '+ctx.native.secret,...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{let text='';res.on('data',b=>{text+=b;if(text.length>12*1024*1024)request.destroy(Error('Native controller response too large'))});res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return no(Error('Clash App controller HTTP '+res.statusCode));try{yes(text?JSON.parse(text):null)}catch{no(Error('Invalid native controller response'))}})});request.on('error',no);request.on('timeout',()=>request.destroy(Error('Native controller timeout')));if(body)request.write(body);request.end()});
 }
 return async(method,route,data)=>{
  if(!identified){const caps=await raw('GET','/clash/v1/capabilities');if(caps.api!==1||caps.platform!=='macos')throw Error('Endpoint is not a supported macOS Clash App controller');identified=true;}
  if(method!=='GET'&&!((method==='PUT'||method==='DELETE')&&/^\/(?:proxies|group)\//.test(route)))throw Error('Clash App manages configuration in its UI; runtime reload/learning writes are unavailable');
  const result=await raw(method,route,data);
  if(method==='GET'&&route==='/configs'){const ports=Object.fromEntries(['mixed-port','port','socks-port','mode','tun'].filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]]));save(ctx.root,'ports.json',ports);Object.assign(ctx.config,ports);}
  if(method==='GET'&&route==='/proxies'){const rules=await raw('GET','/rules'),observed=policy(rules.rules||[],result.proxies||{});save(ctx.root,'observed.json',observed);Object.assign(ctx.config,observed,readPorts(ctx.root));ctx.subscription=observed;}
  return result;
 };
}
function readPorts(dir){try{return JSON.parse(fs.readFileSync(path.join(dir,'ports.json'),'utf8'))}catch{return {}}}
function vpnService(text){const rows=text.split('\n').map(row=>row.match(/\((Connected|Disconnected|Connecting|Disconnecting)\)\s+([A-Fa-f0-9-]{36})\s+VPN \(com\.hako\.network\)/)).filter(Boolean);if(rows.length!==1){const e=Error('Cannot uniquely identify the native Clash VPN service');e.code=rows.length?'AMBIGUOUS_VPN':'NO_NATIVE_VPN';throw e}return {connected:rows[0][1]==='Connected',status:rows[0][1],id:rows[0][2]};}
function vpnStatus(){const p=cp.spawnSync('/usr/sbin/scutil',['--nc','list'],{encoding:'utf8',timeout:3000});if(p.status!==0)throw Error('Cannot read native VPN state');return vpnService(p.stdout);}
async function disconnect(deps={}){const status=deps.status||vpnStatus,spawn=deps.spawn||cp.spawnSync;let state;try{state=status()}catch(e){if(e.code==='NO_NATIVE_VPN')return {absent:true};throw e}if(state.status==='Disconnected')return state;const p=spawn('/usr/sbin/scutil',['--nc','stop',state.id],{encoding:'utf8',timeout:5000});if(p.status!==0)throw Error('Cannot disconnect native Clash VPN');for(let i=0;i<50;i++){state=status();if(state.status==='Disconnected')return state;await new Promise(y=>setTimeout(y,200))}throw Error('Native Clash VPN did not disconnect');}
function register({controller:address,secretFile,allowNativeVpn=false,dir=root()}){if(!allowNativeVpn)throw Error('Native VPN mode needs explicit user authorization');const u=endpoint(address),secret=fs.readFileSync(secretFile,'utf8').trim();if(secret.length<16||/[\r\n]/.test(secret))throw Error('Invalid private controller secret');save(dir,'native.json',{version:1,bundleId:ID,app:APP,controller:u.origin,secret,allowNativeVpn:true});return {paired:true,clientName:'Clash',directory:dir,nativeVpn:true};}
function exportScript(dir=root(),previous='',settings={}){if(previous.includes('// clash-smart-routing managed'))throw Error('Compose the original user script, not a previously generated Smart Routing export');const r=require('./clash-router.cjs'),file=path.join(dir,'smart-routing.js');fs.mkdirSync(dir,{recursive:true,mode:0o700});r.writePrivate(file,r.render(previous,{...settings,monitorEnabled:false}));return {requiresNativeImport:true,file,clientName:'Clash',instructions:'Import as the selected profile script in Clash; preserve any existing script by composition. Reconnect using the App, then proxy config verify. Native subscriptions are not edited.'};}
async function main(command,ctx,args={}){if(args.activate||args['adopt-hierarchy']||args.core)throw Error('Native Clash activation and validation belong to its UI');if(command==='plan')return {clientName:'Clash',requiresNativeImport:true,file:path.join(ctx.root,'smart-routing.js'),nativeVpn:true,learning:false};if(command==='apply'){const previous=args['previous-script']?fs.readFileSync(args['previous-script'],'utf8'):'',settings=args['settings-file']?JSON.parse(fs.readFileSync(args['settings-file'],'utf8')):{};delete settings.preferredNode;return exportScript(ctx.root,previous,settings);}if(command==='rollback')throw Error('Restore the previous script selection in Clash UI; no native files are overwritten');throw Error('Unsupported native configuration command');}
module.exports={ID,APP,root,isClient,load,controller,policy,vpnService,vpnStatus,disconnect,register,exportScript,main};
