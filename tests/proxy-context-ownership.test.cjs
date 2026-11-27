'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {flCoreOwns}=require('../skills/clash-smart-routing/scripts/proxy-context.cjs');
const app='/Applications/FlClash.app',uid=process.getuid();
const selection={client:'flclash',app,pid:123};
const gui=(owner=uid)=>`123 1 ${owner} ${app}/Contents/MacOS/FlClash`;
const core=(parent=123,exe='FlClashCore')=>`124 ${parent} 0 ${app}/Contents/MacOS/${exe}`;
const run=(...rows)=>()=>({status:0,stdout:rows.join('\n')});
test('privileged FlClash core must be a child of this user GUI',()=>{
 assert.equal(flCoreOwns(selection,run(gui(),core())),true);
 assert.equal(flCoreOwns(selection,run(gui(uid+1),core())),false);
 assert.equal(flCoreOwns(selection,run(gui(),core(999))),false);
 assert.equal(flCoreOwns(selection,run(gui(),core(123,'unrelated'))),false);
 assert.equal(flCoreOwns(selection,run(core())),false);
 assert.equal(flCoreOwns({...selection,pid:999},run(gui(),core())),false);
 assert.equal(flCoreOwns(selection,()=>({status:1,stdout:''})),false);
 assert.equal(flCoreOwns({...selection,client:'verge'},()=>{throw Error('must not query')}),false);
});
