'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const c=require('./proxy-context.cjs'),manager=require('./proxy-manager.cjs'),r=require('./clash-router.cjs');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms));
const xml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function probe(){
 const state=await c.discover();if(state.phase!=='ready')throw Error('No verified proxy client is ready');
 const helper=manager.compileEvents();if(!helper.available)throw Error('Native probe needs the Swift helper');
 const label='io.github.clash-smart-routing.gui-probe-'+crypto.randomBytes(5).toString('hex'),dir=c.file('probes/'+label);
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const output=path.join(dir,'result.json'),plist=path.join(dir,'probe.plist');
 r.writePrivate(plist,'<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>'+label+'</string><key>ProgramArguments</key><array>'+[helper.binary,'--probe',output].map(x=>'<string>'+xml(x)+'</string>').join('')+'</array><key>RunAtLoad</key><true/></dict></plist>');
 try{
  const boot=cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist],{encoding:'utf8',timeout:5000});if(boot.status!==0)throw Error('Cannot launch native GUI-domain probe');
  for(let i=0;i<150;i++){if(fs.existsSync(output)){
   const result=JSON.parse(fs.readFileSync(output,'utf8')),expected=c.variables(state);
   const environmentMatches=c.KEYS.every(k=>(result.environment[k]||null)===expected[k]);
   const ok=result.httpStatus===200&&environmentMatches&&c.guiReady(state);
   if(!ok)process.exitCode=1;
   return {ok,transport:state.transport||'system-proxy',clientName:state.clientName,systemProxyMatches:state.systemProxy.matches,environmentMatches,httpStatus:result.httpStatus,elapsedMs:result.elapsedMs,error:result.error||null,scope:'New native URLSession process in GUI launchd domain; no account login tested'};
  }await pause(200)}throw Error('Native GUI probe timed out');
 }finally{cp.spawnSync('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+label],{encoding:'utf8',timeout:5000});fs.rmSync(dir,{recursive:true,force:true})}
}
module.exports={probe};
