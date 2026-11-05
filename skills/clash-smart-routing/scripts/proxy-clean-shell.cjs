'use strict';
// Deliberately limited shell editing: no eval and no sourcing user code.
// Unsupported proxy-bearing constructs are reported before any mutation.
const c=require('./proxy-context.cjs');
const names=new Set(['proxy','clash-net','proxy_on','proxy_off','proxyon','proxyoff','setproxy','unsetproxy','_proxy_refresh','_proxy_preexec']);
const keys=new Set([...c.KEYS,'PROXY_SHELL_MODE','PROXY_CONTEXT','_PROXY_HTTP_PORT','_PROXY_LAST_ENV']);
function mask(text){let out='',quote='',comment=false,escape=false;for(let i=0;i<text.length;i++){const ch=text[i];if(comment){out+=ch==='\n'?'\n':' ';if(ch==='\n')comment=false;continue}if(escape){out+=' ';escape=false;continue}if(ch==='\\'&&quote!=="'"){out+=' ';escape=true;continue}if(quote){out+=ch==='\n'?'\n':' ';if(ch===quote)quote='';continue}if(ch==='"'||ch==="'"||ch==='`'){quote=ch;out+=' ';continue}if(ch==='#'&&(i===0||/[\s;]/.test(text[i-1]))){comment=true;out+=' ';continue}out+=ch}return out}
function words(text){const rows=[];let quote='',escape=false,start=-1;for(let i=0;i<=text.length;i++){const ch=text[i]||' ';if(start<0){if(/\s/.test(ch))continue;if(ch==='#')break;start=i}if(escape){escape=false;continue}if(ch==='\\'&&quote!=="'"){escape=true;continue}if(quote){if(ch===quote)quote='';continue}if(ch==='"'||ch==="'"){quote=ch;continue}if(/\s/.test(ch)){rows.push({start,end:i,raw:text.slice(start,i)});start=-1}}return {rows,valid:!quote&&!escape}}
function literal(raw,home){let x=raw.trim();if((x[0]==='"'&&x.at(-1)==='"')||(x[0]==="'"&&x.at(-1)==="'"))x=x.slice(1,-1);x=x.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/,home);return /[$`\n\\]/.test(x)?null:x}
function related(text){const visible=mask(text);return /\b(?:http_proxy|https_proxy|all_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\b/.test(visible)||/\b(?:proxy|clash-net|setproxy|unsetproxy|proxy_on|proxy_off)\b/.test(visible)}
function clean(text,{home,loader,sourceFiles=[]}={}){
 let value=text.replace(/# >>> proxy managed >>>[\s\S]*?# <<< proxy managed <<</g,''),removed=0,issues=[];
 // Parse complete top-level function bodies before line edits. Quoted braces and
 // comments do not count; unsupported residual functions are left for review.
 let view=mask(value),depth=0,cursor=0,ranges=[];
 const pattern=/^(?:[ \t]*)(?:function[ \t]+)?([\w.-]+)[ \t]*(?:\([ \t]*\))?[ \t\r\n]*\{/gm;let match;
 while((match=pattern.exec(view))){for(;cursor<match.index;cursor++){if(view[cursor]==='{')depth++;if(view[cursor]==='}')depth--}if(depth!==0)continue;const begin=view.indexOf('{',match.index);let level=1,end=begin+1;for(;end<view.length&&level;end++){if(view[end]==='{')level++;if(view[end]==='}')level--}if(level){issues.push('unbalanced-function');break}const raw=value.slice(match.index,end);if(names.has(match[1])&&/<<|\\\n/.test(mask(raw)))issues.push('complex-proxy-function:'+match[1]);else if(names.has(match[1])){if(view[end]===';')end++;ranges.push([match.index,end]);removed++}else if(related(raw))issues.push('proxy-in-unclassified-function:'+match[1]);pattern.lastIndex=end;cursor=end;}
 for(const [a,b]of ranges.reverse())value=value.slice(0,a)+value.slice(b);
 const output=[];
 for(const [index,line]of value.split('\n').entries()){
  let current=line;if(/^\s*plugins=\([^\n]*\)\s*$/.test(line)){current=line.replace(/(?<=[(\s])(?:proxy|clash-net)(?=[)\s])/g,'');if(current!==line)removed++;}
  const trim=current.trim();if(current!==line){output.push(current);continue}if(!trim||trim.startsWith('#')){output.push(line);continue}
  const scanned=words(line),tokens=scanned.rows;
  const command=tokens[0]?.raw;
  // Known loader/source lines may use the usual readability guard.
  const source=tokens.findIndex(x=>x.raw==='source'||x.raw==='.');
  if(source>=0&&tokens[source+1]){const f=literal(tokens[source+1].raw,home||'');if(f===loader||sourceFiles.includes(f)){const head=tokens.slice(0,source).map(x=>x.raw);const readable=head.length===5&&['[[','['].includes(head[0])&&['-r','-f'].includes(head[1])&&literal(head[2],home||'')===f&&[']]',']'].includes(head[3])&&head[4]==='&&';if((source===0||readable)&&tokens.length===source+2){removed++;continue}issues.push('mixed-source-line:'+(index+1));}}
  if(names.has(command)&&tokens.slice(1).every(x=>/^(?:on|off|--quiet|status|test|\|\||true)$/.test(x.raw))){removed++;continue}
  if(command==='add-zsh-hook'&&tokens.some(x=>names.has(x.raw))){removed++;continue}
  if(command==='autoload'&&tokens.some(x=>names.has(x.raw))){const rest=tokens.filter(x=>!names.has(x.raw));if(rest.some(x=>!['autoload','-U','-Uz','-z'].includes(x.raw)))output.push(rest.map(x=>x.raw).join(' '));removed++;continue}
  if((command==='alias'||command==='unalias')&&scanned.valid&&!/[;&|]/.test(mask(line))){const keep=tokens.slice(1).filter(x=>!names.has(x.raw.split('=')[0]));if(keep.length!==tokens.length-1){if(keep.length)output.push(command+' '+keep.map(x=>x.raw).join(' '));removed++;continue}}
  if((command==='launchctl'||command==='/bin/launchctl')&&['setenv','unsetenv'].includes(tokens[1]?.raw)&&keys.has(tokens[2]?.raw)&&scanned.valid&&!/[;&|]/.test(mask(line))){removed++;continue}
  if(scanned.valid&&!/[;&|<>]/.test(mask(line))&&['export','unset','typeset','local'].includes(command)||scanned.valid&&!/[;&|<>]/.test(mask(line))&&tokens.length&&tokens.every(x=>/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.raw))){
   const builtin=['export','unset','typeset','local'].includes(command),start=builtin?1:0,drop=tokens.slice(start).filter(x=>keys.has(x.raw.split('=')[0]));
   if(drop.length){const keep=tokens.filter(x=>!drop.includes(x));if(keep.length>start){let copy=line;for(const x of [...drop].reverse())copy=copy.slice(0,x.start)+copy.slice(x.end);output.push(copy)}removed+=drop.length;continue}
  }
  if(related(line)&&!issues.some(x=>x.startsWith('proxy-in-unclassified-function:')))issues.push('unsupported-shell-line:'+(index+1));
  output.push(line);
 }
 return {text:output.join('\n'),removed,issues:[...new Set(issues)]};
}
module.exports={clean,mask,words,literal,related};
