#!/usr/bin/env node
'use strict';
// Export only. Never edit the input, activate a VPN, or upload device configuration.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const {engine} = require('./clash-router.cjs');
const BASE = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/';
const CNBASE = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP';
const KEYS = Object.keys(engine.sources).filter(k => !k.startsWith('cn-'));
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
    if (/^\+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(row)) return 'DOMAIN-SUFFIX,' + row.slice(2) + ',' + target;
    if (/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(row)) return 'DOMAIN,' + row + ',' + target;
    throw Error('Unsupported upstream domain syntax; no configuration exported');
  });
}
function merge(input, sources) {
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
  const priority = engine.guards.map(d=>'DOMAIN-SUFFIX,' + d + ',PROXY');
  const category = (key, target) => domainRules(sources[key] || '', target);
  for (const key of ['ai', 'apple-ai', 'github']) priority.push(...category(key, 'PROXY'));
  priority.push(...category('private', 'DIRECT'));
  priority.push(...['localhost','local','lan','internal'].map(d=>'DOMAIN-SUFFIX,'+d+',DIRECT'));
  priority.push(...engine.privateRanges.map(c=>(c.includes(':')?'IP-CIDR6,':'IP-CIDR,')+c+',DIRECT'));
  for (const key of ['baidu','icloud','apple-dev','apple-update']) priority.push(...category(key,'DIRECT'));
  const unique = [...new Set(priority)];
  const china = ['DOMAIN-SET,'+CNBASE+'_Domain.list,DIRECT', 'RULE-SET,'+CNBASE+'.list,DIRECT', 'GEOIP,CN,DIRECT'];
  const block = (name, rows) => [TAG+name+':begin', ...rows, TAG+name+':end'];
  const output = [...lines.slice(0,start+1), ...block('priority',unique), ...lines.slice(start+1,finals[0]),
    ...block('china',china), ...lines.slice(finals[0])].join(newline);
  if (stripManaged(output.split(/\r?\n/)).join(newline) !== lines.join(newline)) throw Error('Original configuration changed');
  return {output, priorityRules: unique.length, originalRulesPreserved: true, chinaFallbackBeforeOriginalFinal: true};
}
function argumentsOf(argv) {
  const args = {};
  while (argv.length) {
    const k=argv.shift(); if (!/^--(input|output|source-dir)$/.test(k)||!argv.length) throw Error('Usage: shadowrocket.cjs --output new.conf [--input original.conf] [--source-dir cached-text-categories]');
    if (args[k.slice(2)]) throw Error('Duplicate argument'); args[k.slice(2)]=argv.shift();
  }
  if (!args.output) throw Error('--output is required');
  return args;
}
function main(argv) {
  const args=argumentsOf(argv);
  const inputFile=path.resolve(args.input || path.join(__dirname,'../assets/shadowrocket.example.conf'));
  const outputFile=path.resolve(args.output), manifestFile=outputFile+'.manifest.json';
  if (outputFile === inputFile || fs.existsSync(outputFile) || fs.existsSync(manifestFile)) throw Error('Output must be new; source and existing files are never overwritten');
  const input=fs.readFileSync(inputFile,'utf8'), sources={}, manifest={format:1,generatedAt:new Date().toISOString(),inputSha256:sha(input),sources:{}};
  // Preflight the source before making network requests.
  merge(input,Object.fromEntries(KEYS.map(k=>[k,'validation.example'])));
  for (const key of KEYS) {
    const filename=engine.sources[key].replace(/\.mrs$/,'.list'), url=BASE+filename;
    let text;
    if (args['source-dir']) text=fs.readFileSync(path.join(args['source-dir'],path.basename(filename)),'utf8');
    else {
      const result=cp.spawnSync('curl',['-fsSL','--connect-timeout','10','--max-time','30','--retry','1',url],{encoding:'utf8',timeout:75000,maxBuffer:2*1024*1024});
      if (result.status!==0) throw Error('Cannot fetch '+key+'; no output written');
      text=result.stdout;
    }
    domainRules(text,'DIRECT'); sources[key]=text;
    manifest.sources[key]={url,sha256:sha(text)};
  }
  const result=merge(input,sources); manifest.outputSha256=sha(result.output);manifest.priorityRules=result.priorityRules;
  fs.mkdirSync(path.dirname(outputFile),{recursive:true,mode:0o700});
  fs.writeFileSync(outputFile,result.output,{flag:'wx',mode:0o600});
  try {fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});}
  catch(error){fs.rmSync(outputFile);throw error;}
  return {outputFile,sourceUnchanged:sha(fs.readFileSync(inputFile))===manifest.inputSha256,priorityRules:result.priorityRules,
    originalRulesPreserved:true,deviceImportAndRoutingVerificationRequired:true,categoryUpdates:'Priority categories refresh on export; remote China sets refresh through Shadowrocket.'};
}
if (require.main===module) {try {console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={merge,domainRules,stripManaged,main,KEYS};
