'use strict';
// Persist the native client's own system-proxy switch, never turn on TUN.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const YAML=require('yaml'),c=require('./proxy-context.cjs'),safety=require('./proxy-safety.cjs');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms));
async function quit(selection){
 if(path.basename(selection.root)==='com.follow.clash')return require('./flclash-client.cjs').quit();
 cp.spawnSync('/usr/bin/osascript',['-e','tell application "Clash Verge" to quit'],{encoding:'utf8',timeout:10000});
 for(let i=0;i<100;i++){const p=cp.spawnSync('/bin/ps',['-p',String(selection.pid),'-o','comm='],{encoding:'utf8'});if(!p.stdout.includes(selection.app+'/Contents/MacOS/'))return;await pause(100)}
 throw Error('Client did not quit; preferences retained');
}
async function enable(selection,transaction){
 const isFl=path.basename(selection.root)==='com.follow.clash';
 await quit(selection);
 if(isFl){
  const fl=require('./flclash-client.cjs'),before=fl.losslessJSON(fl.preferences(selection.root)),next=fl.losslessParse(before);
  next.networkProps.systemProxy=true;
  const after=fl.losslessJSON(next),j=safety.read(transaction);
  j.nativePreferences={root:selection.root,changes:[{section:'networkProps',key:'systemProxy',before:fl.losslessParse(before).networkProps.systemProxy,after:true}]};safety.save(transaction,j);fl.writePreferences(next);
 }else{
  const file=path.join(selection.root,'verge.yaml'),before=fs.readFileSync(file,'utf8'),doc=YAML.parseDocument(before);
  doc.set('enable_system_proxy',true);safety.include(transaction,file);safety.write(transaction,file,String(doc));
 }
 cp.spawnSync('/usr/bin/open',['-a',selection.app],{encoding:'utf8',timeout:5000});
 for(let i=0;i<75;i++){const state=await c.discover();if(state.phase==='ready'&&state.selection.root===selection.root&&state.systemProxy.matches)return state;await pause(200)}
 throw Error('Native system proxy did not become ready');
}
module.exports={quit,enable};
