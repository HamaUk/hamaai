import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import axeSource from 'axe-core/axe.min.js?raw';
import { streamChat } from './services/chatApi';
import './builder.css';
import './launch.css';
import './workbench.css';
import './ide.css';
import './composer.css';
import './tools.css';
import './agent-tools.css';

const MODELS = [
  { label: 'DeepSeek V4 Flash', value: 'deepseek-ai/DeepSeek-V4-Flash-0731' },
  { label: 'GLM 5.2', value: 'zai-org/GLM-5.2' }
];
const STARTERS = [
  ['Portfolio', 'Create a refined one-page portfolio for a senior product designer with selected work, about, experience, and contact sections.'],
  ['SaaS dashboard', 'Build a clean SaaS analytics dashboard with revenue metrics, charts, recent activity, and a compact sidebar.'],
  ['Product launch', 'Design a bold one-page launch site for a limited sneaker drop with strong typography and a release countdown.']
];
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const titleFor = text => text.length > 34 ? `${text.slice(0, 34)}…` : text;
const projectStore = () => new Promise((resolve,reject)=>{const request=indexedDB.open('hama-coder',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
async function loadSavedProjects(){const db=await projectStore();return new Promise(resolve=>{const tx=db.transaction('workspace'),request=tx.objectStore('workspace').get('projects');request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>resolve([])})}
async function saveProjects(projects){const db=await projectStore();return new Promise(resolve=>{const tx=db.transaction('workspace','readwrite');tx.objectStore('workspace').put(projects,'projects');tx.oncomplete=resolve;tx.onerror=resolve})}

function Mark() { return <span className="studio-mark">⌁</span>; }
function UIIcon({ name, size = 14 }) {
  const paths = {
    chevron: <path d="m6 9 6 6 6-6"/>,
    spark: <path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z"/>,
    send: <><path d="m5 12 7-7 7 7"/><path d="M12 5v14"/></>,
    stop: <rect x="7" y="7" width="10" height="10" rx="2"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    model: <><rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 9h6v6H9zM12 2v3M12 19v3M2 12h3M19 12h3"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m3 17 5-4 4 3 3-2 6 5"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function sanitizeCss(css = '') {
  if (!css || typeof css !== 'string') return css;

  // 1. Remove runaway consecutive duplicate lines (model stutter loops)
  const rawLines = css.split('\n');
  const dedupeLines = [];
  let prevLine = null;
  let repeatCount = 0;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed && trimmed === prevLine) {
      repeatCount++;
      if (repeatCount > 2) continue;
    } else {
      prevLine = trimmed;
      repeatCount = 0;
    }
    dedupeLines.push(line);
  }

  // 2. Cap runaway numbered sequences (e.g. --color-chart-1...308 or --item-1...200)
  const filtered = [];
  let lastSeqPrefix = '';
  let seqCount = 0;
  for (const line of dedupeLines) {
    const match = line.match(/^\s*(--[a-zA-Z0-9_-]*[a-zA-Z_-]+)-?(\d+)\s*:/);
    if (match) {
      const prefix = match[1];
      if (prefix === lastSeqPrefix) {
        seqCount++;
        if (seqCount > 8) continue;
      } else {
        lastSeqPrefix = prefix;
        seqCount = 1;
      }
    } else {
      lastSeqPrefix = '';
      seqCount = 0;
    }
    filtered.push(line);
  }
  let result = filtered.join('\n');

  // 3. Auto-balance unclosed CSS braces
  const stripped = result
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '');
  let depth = 0;
  for (const char of stripped) {
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
  }
  if (depth > 0) {
    result += '\n' + '}\n'.repeat(depth).trimEnd();
  }
  return result;
}

function parseFiles(input = '') {
  const text = String(input).replace(/\r\n/g, '\n').replace(/\[\[HAMA_STAGE:[^\]]+\]\]/g,'').trim();
  const files = [];

  for (const match of text.matchAll(/<x-file[^>]*path=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/x-file>|$)/gi)) {
    const p = match[1];
    const lang = p.split('.').pop();
    let content = match[2].trim();
    if (lang === 'css' || /\.css$/i.test(p)) content = sanitizeCss(content);
    files.push({ path: p, language: lang, content });
  }

  // Supports complete and still-streaming fences, including ```html{path=index.html}.
  for (const match of text.matchAll(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g)) {
    const meta = (match[1] || '').trim();
    const language = meta.match(/^[\w.+-]+/)?.[0] || 'text';
    const path = meta.match(/path\s*=\s*["']?([^}\s"']+)/i)?.[1] || (language === 'html' ? 'index.html' : `generated.${language}`);
    let content = match[2].trim();
    if (content) {
      if (language === 'css' || /\.css$/i.test(path)) content = sanitizeCss(content);
      files.push({ path, language, content });
    }
  }

  // Some model responses omit markdown fences. Recover a raw HTML document.
  if (!files.length) {
    const htmlStart = text.search(/<!doctype html|<html[\s>]/i);
    if (htmlStart >= 0) files.push({ path: 'index.html', language: 'html', content: text.slice(htmlStart).replace(/```[\s\S]*$/, '').trim() });
  }

  if (!files.length && text.trim() && !/^Generation failed:/i.test(text.trim())) {
    files.push({ path: 'response.txt', language: 'text', content: text.trim() });
  }

  // Guarantee a runnable three-file web project even if a model inlines or omits a file.
  const htmlFile = files.find(file => /\.html?$/i.test(file.path));
  if (htmlFile) {
    if (!files.some(file => /\.css$/i.test(file.path))) {
      const inlineCss = [...htmlFile.content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1].trim()).join('\n\n');
      files.push({ path: 'styles.css', language: 'css', content: inlineCss ? sanitizeCss(inlineCss) : '/* Additional project styles are being generated. */\n* { box-sizing: border-box; }' });
      if (inlineCss) htmlFile.content = htmlFile.content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '<link rel="stylesheet" href="styles.css">');
    }
    if (!files.some(file => /\.(js|mjs)$/i.test(file.path))) {
      const inlineJs = [...htmlFile.content.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1].trim()).filter(Boolean).join('\n\n');
      files.push({ path: 'script.js', language: 'javascript', content: inlineJs || '// Interactive behaviour can be added here.\ndocument.documentElement.classList.add("js");' });
      if (inlineJs) htmlFile.content = htmlFile.content.replace(/<script(?![^>]*src)[^>]*>[\s\S]*?<\/script>/gi, '<script src="script.js"></script>');
    }
  }
  // Later blocks are authoritative. This lets the agent stream corrected replacements safely.
  const latest = new Map();
  files.forEach(file => {
    const cleanPath = file.path.replace(/^\/+/, '');
    const content = (file.language === 'css' || /\.css$/i.test(cleanPath)) ? sanitizeCss(file.content) : file.content;
    latest.set(cleanPath, { ...file, path: cleanPath, content });
  });
  return [...latest.values()];
}

function materializeFiles(messages = []) {
  const filesystem = new Map();
  const valid = messages.filter(message => message.role === 'assistant' && !message.aborted);
  const target = valid.length ? valid : messages.filter(message => message.role === 'assistant');
  target.forEach(message => {
    parseFiles(message.content || '').forEach(file => filesystem.set(file.path, file));
    for (const match of String(message.content || '').matchAll(/<hama-delete\s+path=["']([^"']+)["']\s*\/?\s*>/gi)) filesystem.delete(match[1].replace(/^\/+/, ''));
  });
  return [...filesystem.values()];
}

function validateProject(files, edits = {}) {
  const problems = [];
  const add = (severity, message, path = 'project', line = 1, source = 'validator') => problems.push({ id: `${source}:${path}:${line}:${message}`, severity, message, path, line, source });
  const byPath = path => files.find(file => file.path === path);
  ['index.html', 'styles.css', 'script.js'].forEach(path => { if (!byPath(path)) add('error', `Required file ${path} is missing.`, path); });
  const htmlFile = byPath('index.html') || files.find(file => /\.html?$/i.test(file.path));
  if (htmlFile) {
    const html = edits[htmlFile.path] ?? htmlFile.content;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!/^\s*<!doctype html>/i.test(html)) add('warning', 'Add an HTML5 doctype.', htmlFile.path);
    if (!doc.querySelector('meta[name="viewport"]')) add('error', 'Missing responsive viewport metadata.', htmlFile.path);
    if (!doc.documentElement.getAttribute('lang')) add('warning', 'The html element needs a language attribute.', htmlFile.path);
    const ids = new Set();
    doc.querySelectorAll('[id]').forEach(node => { const id = node.id; if (ids.has(id)) add('error', `Duplicate id “${id}”.`, htmlFile.path); ids.add(id); });
    doc.querySelectorAll('img').forEach(node => { if (!node.hasAttribute('alt')) add('error', 'Image is missing alt text.', htmlFile.path); });
    doc.querySelectorAll('button').forEach(node => { if (!node.textContent.trim() && !node.getAttribute('aria-label')) add('error', 'Icon button is missing an accessible name.', htmlFile.path); });
    doc.querySelectorAll('input, textarea, select').forEach(node => { if (!node.getAttribute('aria-label') && !node.id && !node.closest('label')) add('warning', 'Form control may be missing a label.', htmlFile.path); });
    doc.querySelectorAll('*').forEach(node => { if ([...node.attributes].some(attribute => /^on/i.test(attribute.name))) add('error', 'Inline event handlers are blocked by the preview sandbox; use addEventListener.', htmlFile.path); });
  }
  files.filter(file=>/\.html?$/i.test(file.path)).forEach(file=>{
    const html=edits[file.path]??file.content, doc=new DOMParser().parseFromString(html,'text/html');
    doc.querySelectorAll('a[href]').forEach(anchor=>{const href=anchor.getAttribute('href').split('#')[0].split('?')[0];if(href&&!/^(https?:|mailto:|tel:|\/)/i.test(href)){const base=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')+1):'';const target=(base+href.replace(/^\.\//,'')).replace(/[^/]+\/\.\.\//g,'');if(!files.some(item=>item.path===target))add('error',`Broken internal link to ${href}.`,file.path);}});
  });
  files.filter(file => /\.(js|mjs)$/i.test(file.path)).forEach(file => {
    const code = edits[file.path] ?? file.content;
    try { Function(code); } catch (error) { const line = Number(String(error.stack || '').match(/<anonymous>:(\d+):/)?.[1] || 1); add('error', `JavaScript syntax: ${error.message}`, file.path, line); }
    if (/\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(/.test(code)) add('error', 'Unsafe dynamic code execution is not allowed.', file.path);
  });
  files.filter(file => /\.css$/i.test(file.path)).forEach(file => {
    const css = (edits[file.path] ?? file.content).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, '');
    let depth = 0;
    for (const char of css) { if (char === '{') depth++; if (char === '}') depth--; if (depth < 0) break; }
    if (depth !== 0) add('error', 'CSS contains unbalanced braces.', file.path);
  });
  return problems.slice(0, 100);
}

function composePreview(files, edits, channel, pagePath = 'index.html', selectMode = false, auditLabel = '') {
  const htmlFile = files.find(file => file.path===pagePath) || files.find(file => /(^|\/)index\.html$/i.test(file.path)) || files.find(file => /\.html?$/i.test(file.path));
  if (!htmlFile) return '';
  let html = edits[htmlFile.path] ?? htmlFile.content;
  let css = files.filter(file => /\.css$/i.test(file.path)).map(file => edits[file.path] ?? file.content).join('\n\n');
  const js = files.filter(file => /\.(js|mjs)$/i.test(file.path)).map(file => edits[file.path] ?? file.content).join('\n\n').replace(/<\/script/gi, '<\\/script');
  files.filter(file=>String(edits[file.path]??file.content).startsWith('data:')).forEach(file=>{const data=edits[file.path]??file.content;html=html.split(file.path).join(data);css=css.split(file.path).join(data);});
  html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  html = html.replace(/<link[^>]+href=["'][^"']+\.css["'][^>]*>/gi, '');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-hama-preview'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const bridge = `<script nonce="hama-preview">(function(){
    const channel=${JSON.stringify(channel)}, selectMode=${JSON.stringify(selectMode)}, auditLabel=${JSON.stringify(auditLabel)}, currentPage=${JSON.stringify(htmlFile.path)};
    const send=(kind,data={})=>parent.postMessage({__hama:true,channel,kind,...data},'*');
    const selectorFor=node=>{if(node.id)return '#'+CSS.escape(node.id);const parts=[];while(node&&node.nodeType===1&&node!==document.body){let part=node.tagName.toLowerCase();if(node.classList.length)part+='.'+[...node.classList].slice(0,2).map(CSS.escape).join('.');const siblings=node.parentElement?[...node.parentElement.children].filter(item=>item.tagName===node.tagName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);node=node.parentElement}return 'body > '+parts.join(' > ')};
    ['error','warn'].forEach(level=>{const original=console[level];console[level]=function(...args){send('console',{severity:level==='error'?'error':'warning',message:args.map(value=>{try{return typeof value==='string'?value:JSON.stringify(value)}catch{return String(value)}}).join(' ')});return original.apply(console,args)}});
    addEventListener('error',event=>{if(event.target!==window){send('runtime',{severity:'error',message:'Resource failed to load',path:event.target?.src||event.target?.href||'preview'});return}send('runtime',{severity:'error',message:event.message||'Uncaught error',path:'script.js',line:event.lineno||1,column:event.colno||1})},true);
    addEventListener('unhandledrejection',event=>send('runtime',{severity:'error',message:'Unhandled promise rejection: '+(event.reason?.message||String(event.reason)),path:'script.js'}));
    addEventListener('click',event=>{const anchor=event.target.closest('a[href]');if(anchor){const href=anchor.getAttribute('href');if(href&&!/^(https?:|mailto:|tel:|#)/i.test(href)){event.preventDefault();let raw=href.split('#')[0];if(raw.startsWith('./'))raw=raw.slice(2);const base=currentPage.includes('/')?currentPage.slice(0,currentPage.lastIndexOf('/')+1):'';const parts=(raw.startsWith('/')?raw.slice(1):base+raw).split('/');const clean=[];parts.forEach(part=>part==='..'?clean.pop():part!=='.'&&clean.push(part));send('navigate',{path:clean.join('/')||'index.html'});return}}if(!selectMode)return;event.preventDefault();event.stopImmediatePropagation();const node=event.target, selector=selectorFor(node), style=getComputedStyle(node);let rules=[];try{[...document.styleSheets].forEach(sheet=>[...sheet.cssRules].forEach(rule=>{if(rule.selectorText&&node.matches(rule.selectorText))rules.push(rule.cssText)}))}catch{}send('selection',{selector,tag:node.tagName.toLowerCase(),id:node.id,classes:[...node.classList],text:(node.textContent||'').trim().slice(0,300),html:node.outerHTML.slice(0,2000),rules:rules.slice(-8),styles:{color:style.color,background:style.backgroundColor,fontSize:style.fontSize,padding:style.padding,borderRadius:style.borderRadius,width:style.width,height:style.height,textAlign:style.textAlign,display:style.display}})},true);
    const audit=()=>{const issues=[];if(document.documentElement.scrollWidth>innerWidth+2)issues.push({type:'overflow',message:'Horizontal overflow',selector:'html'});document.querySelectorAll('button,a,input,select,textarea').forEach(node=>{const r=node.getBoundingClientRect();if(r.width&&r.height&&(r.width<44||r.height<44))issues.push({type:'tap',message:'Tap target smaller than 44px',selector:selectorFor(node)})});document.querySelectorAll('body *').forEach(node=>{const r=node.getBoundingClientRect();if(r.right>innerWidth+4||r.left<-4)issues.push({type:'clipped',message:'Element extends outside viewport',selector:selectorFor(node)});const style=getComputedStyle(node);if((node.scrollWidth>node.clientWidth+2||node.scrollHeight>node.clientHeight+2)&&['hidden','clip'].includes(style.overflow))issues.push({type:'text',message:'Content may be cut off',selector:selectorFor(node)})});const interactive=[...document.querySelectorAll('button,a,input')].map(node=>({node,rect:node.getBoundingClientRect()})).filter(item=>item.rect.width&&item.rect.height);for(let i=0;i<interactive.length;i++)for(let j=i+1;j<interactive.length;j++){const a=interactive[i].rect,b=interactive[j].rect;if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)issues.push({type:'overlap',message:'Interactive elements overlap',selector:selectorFor(interactive[j].node)})}if(innerWidth<=400&&![...document.styleSheets].some(sheet=>{try{return[...sheet.cssRules].some(rule=>rule.type===CSSRule.MEDIA_RULE)}catch{return false}}))issues.push({type:'responsive',message:'No responsive media rules detected',selector:'styles.css'});send('audit',{label:auditLabel||innerWidth,width:innerWidth,issues:issues.slice(0,30)})};
    addEventListener('DOMContentLoaded',()=>{send('ready');setTimeout(audit,250)});setTimeout(()=>send('heartbeat'),1500)
  })();<\/script>`;
  const accessibility = `<script nonce="hama-preview">${axeSource.replace(/<\/script/gi, '<\\/script')}\naddEventListener('load',()=>setTimeout(()=>{if(window.axe)axe.run(document,{resultTypes:['violations']}).then(result=>parent.postMessage({__hama:true,channel:${JSON.stringify(channel)},kind:'axe',violations:result.violations.slice(0,20).map(item=>({id:item.id,impact:item.impact,help:item.help,nodes:item.nodes.length,target:item.nodes[0]?.target?.join(' ')}))},'*')).catch(()=>{})},350));<\/script>`;
  if (html.includes('<head')) html = html.replace(/<head([^>]*)>/i, `<head$1>${csp}${bridge}`); else html = `${csp}${bridge}${html}`;
  if (css) html = html.includes('</head>') ? html.replace('</head>', `<style>\n${css}\n</style></head>`) : `<style>${css}</style>${html}`;
  const scripts = `${js ? `<script nonce="hama-preview">\n${js}\n<\/script>` : ''}${accessibility}`;
  html = html.includes('</body>') ? html.replace('</body>', `${scripts}</body>`) : `${html}${scripts}`;
  return html;
}

function buildLineDiff(before = '', after = '') {
  const a=before.split('\n'), b=after.split('\n');
  if(a.length*b.length>160000) return [...a.map(text=>({type:'remove',text})),...b.map(text=>({type:'add',text}))];
  const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const out=[]; let i=0,j=0;
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){out.push({type:'same',text:a[i]});i++;j++;}
    else if(j<b.length&&(i===a.length||dp[i][j+1]>=dp[i+1][j])){out.push({type:'add',text:b[j++]});}
    else out.push({type:'remove',text:a[i++]});
  }
  return out;
}

function DiffReview({ pending, workspace, onAccept, onReject }) {
  const [path,setPath]=useState(pending?.files?.[0]?.path||'');
  useEffect(()=>setPath(pending?.files?.[0]?.path||''),[pending?.id]);
  if(!pending) return null;
  const file=pending.files.find(item=>item.path===path)||pending.files[0];
  if(!file) return null;
  const conflict=(workspace?.[file.path]||'')!==file.baseContent;
  const diff=buildLineDiff(file.baseContent,file.content);
  return <div className="change-review"><header><div><small>{pending.agentRepair?'QA REPAIR':'AI PROPOSAL'}</small><b>{pending.summary}</b></div><div style={{display:'flex',alignItems:'center',gap:'10px'}}><span>{pending.files.length} changed file{pending.files.length===1?'':'s'}</span><button onClick={()=>onReject()} title="Dismiss change review" aria-label="Dismiss review">×</button></div></header><div className="change-review-body"><aside>{pending.files.map(item=><button key={item.path} className={item.path===file.path?'active':''} onClick={()=>setPath(item.path)}><span>{item.path}</span><small>{buildLineDiff(item.baseContent,item.content).filter(line=>line.type==='add').length}+ / {buildLineDiff(item.baseContent,item.content).filter(line=>line.type==='remove').length}−</small></button>)}</aside><section>{conflict&&<div className="change-conflict">⚠ This file changed after the AI started. Review before accepting.</div>}<div className="diff-code">{diff.map((line,index)=><div key={index} className={line.type}><i>{line.type==='add'?'+':line.type==='remove'?'−':' '}</i><code>{line.text||' '}</code></div>)}</div><footer><button onClick={()=>onReject([file.path])}>Reject file</button><button onClick={()=>onAccept([file.path])} className="secondary">Accept file</button><span/><button onClick={()=>onReject()}>Reject all</button><button onClick={()=>onAccept()} className="primary">Accept all changes</button></footer></section></div></div>;
}

function VersionPanel({ versions=[], workspace, onRestore, onRename, onClose }) {
  const [selected,setSelected]=useState(versions.at(-1)?.id||'');
  const [previewing,setPreviewing]=useState(false);
  const version=versions.find(item=>item.id===selected)||versions.at(-1);
  const versionFiles=version?Object.entries(version.workspace||{}).map(([path,content])=>({path,content,language:path.split('.').pop()})):[];
  const changedPaths=version?[...new Set([...Object.keys(version.workspace||{}),...Object.keys(workspace||{})])].filter(path=>version.workspace?.[path]!==workspace?.[path]):[];
  const preview=version&&previewing?composePreview(versionFiles,{},`history-${version.id}`):'';
  return <div className="history-panel"><header><div><small>PROJECT TIMELINE</small><b>Version history</b></div><button onClick={onClose}>×</button></header><div className="history-body"><aside>{[...versions].reverse().map((item,index)=><button key={item.id} className={item.id===version?.id?'active':''} onClick={()=>{setSelected(item.id);setPreviewing(false)}}><i/><span><b>{item.label}</b><small>{new Date(item.createdAt).toLocaleString()} · V{versions.length-index}</small></span></button>)}</aside><section>{version?<><header><input value={version.label} onChange={e=>onRename(version.id,e.target.value)}/><span>{Object.keys(version.workspace||{}).length} files · {changedPaths.length} changed vs current</span><button onClick={()=>setPreviewing(!previewing)}>{previewing?'Compare files':'Preview snapshot'}</button></header>{previewing?<div className="history-preview"><iframe title="Version preview" sandbox="allow-scripts" srcDoc={preview}/></div>:<div className="history-files">{Object.keys(version.workspace||{}).map(path=>{const lines=buildLineDiff(version.workspace[path],workspace?.[path]||'');const adds=lines.filter(line=>line.type==='add').length, removes=lines.filter(line=>line.type==='remove').length;return <div key={path}><span>{path}</span>{version.workspace[path]!==workspace?.[path]&&<small>{adds}+ {removes}−</small>}<button disabled={version.workspace[path]===workspace?.[path]} onClick={()=>onRestore(version,path)}>Restore file</button></div>})}</div>}<footer><button onClick={()=>onRestore(version)}>Restore complete version</button></footer></>:<div className="history-empty">No checkpoints yet.</div>}</section></div></div>;
}

function VisualPanel({ selection, files, onApply, onClose }) {
  const [values,setValues]=useState(selection?.styles||{});
  const [text,setText]=useState(selection?.text||'');
  useEffect(()=>{setValues(selection?.styles||{});setText(selection?.text||'')},[selection?.selector]);
  if(!selection)return null;
  const fields=[['color','Text colour'],['background','Background'],['fontSize','Font size'],['padding','Spacing'],['borderRadius','Radius'],['width','Width'],['height','Height'],['textAlign','Alignment']];
  return <div className="element-panel"><header><div><small>SELECTED ELEMENT</small><b>{selection.tag}{selection.id?`#${selection.id}`:''}</b></div><button onClick={onClose}>×</button></header><code>{selection.selector}</code><label>TEXT<textarea value={text} onChange={e=>setText(e.target.value)}/></label><div className="element-fields">{fields.map(([key,label])=><label key={key}>{label}<input value={values[key]||''} onChange={e=>setValues(old=>({...old,[key]:e.target.value}))}/></label>)}</div><label>VISIBILITY<select value={values.visibility||'all'} onChange={e=>setValues(old=>({...old,visibility:e.target.value}))}><option value="all">All devices</option><option value="desktop">Desktop only</option><option value="mobile">Mobile only</option><option value="hidden">Hidden</option></select></label><footer><button onClick={onClose}>Cancel</button><button onClick={()=>onApply(text,values)}>Apply to code</button></footer></div>;
}

async function filesFromUpload(list) {
  const uploads=[...list], result={}, textExt=/^(html?|css|js|mjs|json|txt|md|svg)$/;
  const mimeFor=path=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2'}[path.split('.').pop().toLowerCase()]||'application/octet-stream');
  for(const file of uploads){
    if(file.name.toLowerCase().endsWith('.zip')){
      const zip=await JSZip.loadAsync(file), entries=Object.entries(zip.files).filter(([,entry])=>!entry.dir&&!entry.name.includes('__MACOSX'));
      const roots=new Set(entries.map(([path])=>path.split('/')[0])), stripRoot=roots.size===1&&entries.every(([path])=>path.includes('/'));
      for(const [original,entry] of entries){const path=stripRoot?original.split('/').slice(1).join('/'):original;const ext=path.split('.').pop().toLowerCase();result[path]=textExt.test(ext)?await entry.async('string'):`data:${mimeFor(path)};base64,${await entry.async('base64')}`;}
    }else{
      const path=(file.webkitRelativePath||file.name).replace(/^[^/]+\//,''); const ext=path.split('.').pop().toLowerCase();
      result[path]=textExt.test(ext)?await file.text():await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file)});
    }
  }
  return result;
}

async function filesFromDrop(dataTransfer){
  const collected=[];
  const walk=async(entry,prefix='')=>{if(entry.isFile){await new Promise(resolve=>entry.file(file=>{try{Object.defineProperty(file,'webkitRelativePath',{value:prefix+file.name})}catch{}collected.push(file);resolve()}))}else if(entry.isDirectory){const reader=entry.createReader();let batch;do{batch=await new Promise(resolve=>reader.readEntries(resolve));for(const child of batch)await walk(child,`${prefix}${entry.name}/`)}while(batch.length)}};
  const entries=[...(dataTransfer.items||[])].map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
  if(entries.length){for(const entry of entries)await walk(entry);return filesFromUpload(collected)}
  return filesFromUpload(dataTransfer.files||[]);
}

function ImportPanel({ onImport, onClose }) {
  const [url,setUrl]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[dragOver,setDragOver]=useState(false);
  const take=async list=>{setLoading(true);setError('');try{const patch=await filesFromUpload(list);onImport(patch,`Imported ${Object.keys(patch).length} files`);onClose()}catch(err){setError(err.message)}finally{setLoading(false)}};
  const github=async()=>{if(!url.trim())return;setLoading(true);setError('');try{const response=await fetch(`/api/import/github?url=${encodeURIComponent(url)}`);if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error||'GitHub import failed');const blob=await response.blob();const file=new File([blob],'github-project.zip',{type:'application/zip'});await take([file])}catch(err){setError(err.message);setLoading(false)}};
  return <div className="tool-modal" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section><header><div><small>EXISTING PROJECT</small><b>Import project</b></div><button onClick={onClose}>×</button></header><label className={`import-drop ${dragOver?'dragover':''}`} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={async e=>{e.preventDefault();setDragOver(false);if(e.dataTransfer.files?.length)take(e.dataTransfer.files);}}>Drop files here or choose a ZIP/folder<input type="file" multiple onChange={e=>take(e.target.files)}/><span>Choose files</span></label><label className="folder-input">Import a complete folder<input type="file" multiple webkitdirectory="" onChange={e=>take(e.target.files)}/></label><div className="github-import"><label>PUBLIC GITHUB REPOSITORY<input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://github.com/owner/repository"/></label><button onClick={github} disabled={loading||!url.trim()}>Import GitHub</button></div>{error&&<p className="error-text">{error}</p>}{loading&&<div className="tool-loading">Reading project files…</div>}</section></div>;
}

function AssetManager({ files, onPatch, onClose }) {
  const assets=files.filter(file=>/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(file.path));
  const upload=async list=>onPatch(await filesFromUpload(list),'Added assets');
  const rename=(file,name)=>{const clean=name.replace(/^\/+|\.\./g,'');if(!clean||clean===file.path)return;const patch={[clean]:file.content};files.filter(item=>/\.(html?|css|js)$/i.test(item.path)).forEach(item=>patch[item.path]=item.content.split(file.path).join(clean));patch[file.path]='__HAMA_DELETE__';onPatch(patch,`Renamed ${file.path}`)};
  const compress=file=>{if(!file.content.startsWith('data:image/')||file.path.endsWith('.svg'))return;const image=new Image();image.onload=()=>{const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const mime=/\.png$/i.test(file.path)?'image/png':/\.webp$/i.test(file.path)?'image/webp':'image/jpeg';onPatch({[file.path]:canvas.toDataURL(mime,.82)},`Compressed ${file.path}`)};image.src=file.content};
  return <div className="tool-modal" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="asset-manager"><header><div><small>PROJECT LIBRARY</small><b>Asset manager</b></div><button onClick={onClose}>×</button></header><label className="asset-upload">＋ Upload images, SVGs, logos or favicons<input type="file" accept="image/*,.svg,.ico" multiple onChange={e=>upload(e.target.files)}/></label><div className="asset-grid">{assets.length?assets.map(file=><article key={file.path}><div>{file.content.startsWith('data:')?<img src={file.content}/>:file.path.endsWith('.svg')?<div dangerouslySetInnerHTML={{__html:file.content}}/>:<span>IMG</span>}</div><input defaultValue={file.path} onBlur={e=>rename(file,e.target.value)}/><small>{Math.ceil(file.content.length/1024)} KB</small>{file.content.startsWith('data:image/')&&!file.path.endsWith('.svg')&&<button onClick={()=>compress(file)}>Compress</button>}</article>):<p>No local assets yet.</p>}</div></section></div>;
}

function ResponsivePanel({ results, previews, onClose }) {
  return <div className="responsive-panel"><header><div><small>RESPONSIVE QA</small><b>Three-viewport test</b></div><button onClick={onClose}>×</button></header><div className="responsive-grid">{previews.map(item=>{const result=results[String(item.width)];return <article key={item.width}><header><b>{item.label}</b><span>{item.width}px · {result?`${result.issues.length} issues`:'Testing…'}</span></header><div><iframe title={`${item.label} test`} sandbox="allow-scripts" srcDoc={item.src}/></div><ul>{result?.issues.slice(0,6).map((issue,index)=><li key={index}><b>{issue.message}</b><small>{issue.selector}</small></li>)}{result&&!result.issues.length&&<li className="pass">✓ No layout issues detected</li>}</ul></article>})}</div></div>;
}

function Sidebar({ projects, activeId, onNew, onOpen, open, onClose, connected, model }) {
  return <><button className={`studio-scrim ${open ? 'show' : ''}`} onClick={onClose} /><aside className={`studio-sidebar ${open ? 'open' : ''}`}>
    <div className="studio-brand">
      <Mark /><b>HAMA CODER</b>
      <button style={{marginLeft:'auto',background:'transparent',border:0,color:'#8c909e',fontSize:'20px',cursor:'pointer'}} onClick={onClose} aria-label="Close sidebar">×</button>
    </div>
    <button className="studio-new" onClick={onNew}>＋ <span>New build</span><kbd>⌘ K</kbd></button>
    <p className="studio-label">PROJECTS</p>
    <div className="studio-projects">{projects.length ? projects.map(project => <button key={project.id} className={project.id === activeId ? 'active' : ''} onClick={() => onOpen(project.id)}><i /> <span>{project.title}</span></button>) : <small>No builds yet</small>}</div>
    <div className="studio-grow" />
    <div className="studio-connection"><i className={connected ? 'on' : ''}/><span><b>{connected ? 'Connected' : 'Connecting'}</b><small>AI Engine · {MODELS.find(item => item.value === model)?.label || 'AI model'}</small></span></div>
    <div className="studio-user"><span>HC</span><div><b>Hama Developer</b><small>Local workspace</small></div></div>
  </aside></>;
}

function PromptBox({ onSend, busy = false, onStop, placeholder = 'Describe what you want to build…', compact = false, model, onModelChange, smart, onSmartChange, search, onSearchChange }) {
  const [value, setValue] = useState('');
  const [modelMenu, setModelMenu] = useState(false);
  const menuRef = useRef(null);
  const selected = MODELS.find(item => item.value === model) || MODELS[0];
  const submit = () => { if (!value.trim() || busy) return; onSend(value.trim()); setValue(''); };

  useEffect(() => {
    if (!modelMenu) return;
    const handleOutside = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setModelMenu(false); };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [modelMenu]);

  return <div className={`studio-prompt refined-composer ${compact ? 'compact' : ''}`}>
    <textarea value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setModelMenu(false); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} placeholder={placeholder}/>
    <div className="refined-toolbar">
      <div className="model-picker" ref={menuRef}><button type="button" className="model-trigger" onClick={() => setModelMenu(!modelMenu)} aria-expanded={modelMenu}><span className="model-glyph"><UIIcon name="model" size={13}/></span><span className="model-copy"><b>{selected.label}</b><small>Code generation model</small></span><UIIcon name="chevron" size={12}/></button>{modelMenu && <div className="model-menu">{MODELS.map(item => <button key={item.value} className={item.value === model ? 'selected' : ''} onClick={() => { onModelChange(item.value); setModelMenu(false); }}><span className="model-glyph"><UIIcon name="model" size={13}/></span><span><b>{item.label}</b><small>{item.value.includes('GLM') ? 'Creative & visual' : 'Fast & reliable'}</small></span>{item.value === model && <UIIcon name="check" size={13}/>}</button>)}</div>}</div>
      <button type="button" className={`think-control ${smart ? 'active' : ''}`} onClick={() => onSmartChange(!smart)}><span><UIIcon name="spark" size={13}/></span><b>{smart ? 'Agent Team' : 'Fast mode'}</b></button>
      <button type="button" className={`web-control ${search ? 'active' : ''}`} onClick={() => onSearchChange(!search)} title="Use DuckDuckGo research"><UIIcon name="globe" size={13}/><b>Web</b></button>
      <span className="toolbar-spacer"/>
      {busy ? <button className="composer-action stop" onClick={onStop} aria-label="Stop generation"><UIIcon name="stop" size={13}/></button> : <button className="composer-action" onClick={submit} disabled={!value.trim()} aria-label="Send prompt"><UIIcon name="send" size={15}/></button>}
    </div>
  </div>;
}

function Home({ projects, onSend, onOpen, model, onModelChange, smart, onSmartChange, search, onSearchChange, onImage, onImport }) {
  const scrollToTemplates = () => document.querySelector('.launch-templates')?.scrollIntoView({ behavior: 'smooth' });
  const scrollToHero = () => document.querySelector('.launch-hero')?.scrollIntoView({ behavior: 'smooth' });
  return <main className="launch-home"><div className="launch-aurora"/><header className="launch-nav"><div className="launch-brand" onClick={scrollToHero}><Mark/><span><b>HAMA</b><small>CODER</small></span></div><nav><button onClick={scrollToHero}>Product</button><button onClick={scrollToTemplates}>Templates</button><button onClick={scrollToTemplates}>Docs</button></nav><div className="launch-actions"><span><i/>AI Engine Online</span>{projects.length > 0 && <button onClick={() => onOpen(projects[0].id)}>Open workspace</button>}<b>HC</b></div></header><section className="launch-hero"><div className="launch-badge"><span>✦</span> AI product engineer <i>New</i></div><h1>From prompt to product<br/><em>in one workspace.</em></h1><p>Describe an idea. HAMA CODER designs the interface, writes every file,<br/>and gives you a responsive preview ready to download.</p><div className="launch-composer"><div className="composer-top"><span className="composer-spark">✦</span><textarea autoFocus placeholder="Build a polished portfolio for a creative developer…" id="launch-input" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const value=e.currentTarget.value.trim();if(value){onSend(value);e.currentTarget.value='';}}}}/></div><div className="launch-tools"><div className="model-switch">{MODELS.map(item=><button key={item.value} className={model===item.value?'active':''} onClick={()=>onModelChange(item.value)}><i/>{item.label}</button>)}</div><button className={`think-switch ${smart?'active':''}`} onClick={()=>onSmartChange(!smart)}><span>✦</span><b>{smart?'Agent Team':'Fast mode'}</b></button><button className={`launch-tool ${search?'active':''}`} onClick={()=>onSearchChange(!search)}><UIIcon name="globe" size={13}/> Web</button><button className="launch-tool" onClick={onImage}><UIIcon name="image" size={13}/> Image</button><button className="launch-tool" onClick={onImport}>＋ Import</button><span className="launch-hint">Enter to build</span><button className="launch-send" onClick={()=>{const input=document.getElementById('launch-input');const value=input?.value.trim();if(value){onSend(value);input.value='';}}}>Build <span>→</span></button></div></div><div className="launch-trust"><span>✓ Multi-file projects</span><span>✓ Live responsive preview</span><span>✓ Download as ZIP</span></div></section><section className="launch-templates"><header><div><small>START WITH A TEMPLATE</small><h2>Ship something remarkable.</h2></div><button onClick={scrollToTemplates}>View all templates →</button></header><div>{STARTERS.map(([title,prompt],index)=><button className={`template-card t${index+1}`} key={title} onClick={()=>onSend(prompt)}><div className="template-visual"><span>{index===0?'AR':index===1?'◫':'DROP'}</span><i>↗</i></div><footer><span><b>{title}</b><small>{index===0?'Personal brand':index===1?'Analytics product':'Campaign page'}</small></span><strong>Use template</strong></footer></button>)}</div></section><footer className="launch-footer"><span>HAMA CODER · Build thoughtfully.</span><span>DeepSeek V4 Flash & GLM 5.2</span></footer></main>;
}

function CodeView({ files, activePath, setActivePath, edits, setEdits, onEdit, busy = false, problems = [], saving = false }) {
  const file = files.find(item => item.path === activePath) || files[0];
  const gutterRef = useRef(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [showProblems, setShowProblems] = useState(false);
  if (!file) return <div className="studio-empty-code"><span>‹/›</span><b>Waiting for code</b><small>Files will stream into the editor in real time.</small></div>;
  const content = edits[file.path] ?? file.content;
  const lines = content.split('\n');
  const updateCursor = event => {
    const before = event.currentTarget.value.slice(0, event.currentTarget.selectionStart);
    const parts = before.split('\n');
    setCursor({ line: parts.length, column: parts.at(-1).length + 1 });
  };
  const openProblem = problem => { const target = files.find(item => item.path === problem.path); if (target) setActivePath(target.path); setShowProblems(false); };
  const fileIcon = path => path.endsWith('.html') ? '<>' : path.endsWith('.css') ? '#' : path.endsWith('.js') ? 'JS' : '•';
  const errorCount = problems.filter(problem => problem.severity === 'error').length;

  const handleKeyDown = event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = event.currentTarget.selectionStart;
      const end = event.currentTarget.selectionEnd;
      const val = event.currentTarget.value;
      const updated = val.substring(0, start) + '  ' + val.substring(end);
      setEdits(old => ({ ...old, [file.path]: updated }));
      onEdit?.(file.path, updated);
      setTimeout(() => {
        if (event.target) {
          event.target.selectionStart = event.target.selectionEnd = start + 2;
        }
      }, 0);
    }
  };

  return <div className="ide-shell"><aside className="ide-explorer"><header><span>EXPLORER</span><b>{files.length}</b></header><div className="ide-root"><span>⌄</span><b>HAMA-PROJECT</b></div><div className="ide-files">{files.map(item => <button key={item.path} className={item.path === file.path ? 'active' : ''} style={{'--depth': Math.max(0,item.path.split('/').length-1)}} onClick={() => setActivePath(item.path)}><i className={`type-${item.language}`}>{fileIcon(item.path)}</i><span>{item.path.split('/').pop()}</span>{busy && item.path === file.path && <em/>}</button>)}</div></aside><section className="ide-main"><header className="ide-tabs"><div className="active"><i>{fileIcon(file.path)}</i><span>{file.path.split('/').pop()}</span>{edits[file.path] !== undefined && <b>●</b>}</div><span className={`ide-live ${busy ? 'streaming' : ''}`}><i/>{busy ? 'Agent team working' : saving ? 'Saving changes…' : errorCount ? `${errorCount} error${errorCount>1?'s':''} detected` : 'Saved · validated'}</span></header><div className="ide-breadcrumb"><span>hama-project</span><i>›</i><b>{file.path}</b></div><div className="ide-editor"><div className="ide-gutter" ref={gutterRef}>{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea aria-label={`Edit ${file.path}`} spellCheck="false" value={content} onSelect={updateCursor} onClick={updateCursor} onKeyUp={updateCursor} onKeyDown={handleKeyDown} onScroll={event => { if(gutterRef.current) gutterRef.current.scrollTop=event.currentTarget.scrollTop; }} onChange={event => { const value=event.target.value; setEdits(old => ({ ...old, [file.path]: value })); onEdit?.(file.path,value); }}/>{showProblems && <div className="ide-problems"><header><div><b>Problems</b><span>{problems.length}</span></div><button onClick={()=>setShowProblems(false)}>×</button></header><div>{problems.length ? problems.map(problem => <button key={problem.id} onClick={()=>openProblem(problem)}><i className={problem.severity}>{problem.severity === 'error' ? '×' : '!'}</i><span><b>{problem.message}</b><small>{problem.path}:{problem.line || 1} · {problem.source}</small></span></button>) : <p>✓ No detected problems</p>}</div></div>}</div><footer className="ide-status"><div><span>main*</span><button className={errorCount ? 'has-errors' : ''} onClick={()=>setShowProblems(!showProblems)}>{errorCount ? `× ${errorCount} error${errorCount>1?'s':''}` : '✓'} {problems.length ? `${problems.length} problem${problems.length>1?'s':''}` : 'No problems'}</button></div><div><span>Ln {cursor.line}, Col {cursor.column}</span><span>Spaces: 2</span><span>UTF-8</span><span>{file.language.toUpperCase()}</span></div></footer></section></div>;
}

function Builder({ project, busy, onSend, onRepair, onStop, onMenu, onBack, model, onModelChange, smart, onSmartChange, search, onSearchChange, onImage, onEditFile, onPatchFiles, onAcceptPending, onRejectPending, onRestoreVersion, onRenameVersion, onSetRepairPolicy, onImport, onResetRepairRounds }) {
  const [mode, setMode] = useState('preview');
  const [device, setDevice] = useState('desktop');
  const [activePath, setActivePath] = useState('');
  const [edits, setEdits] = useState({});
  const [mobilePanel, setMobilePanel] = useState('preview');
  const [runtimeProblems, setRuntimeProblems] = useState([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [activePage,setActivePage]=useState('index.html');
  const [selectMode,setSelectMode]=useState(false);
  const [selection,setSelection]=useState(null);
  const [historyOpen,setHistoryOpen]=useState(false);
  const [assetsOpen,setAssetsOpen]=useState(false);
  const [importOpen,setImportOpen]=useState(false);
  const [responsiveOpen,setResponsiveOpen]=useState(false);
  const [auditResults,setAuditResults]=useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const channelRef = useRef(`hama-${uid()}`);
  const attemptedRepairs = useRef(new Set());
  const latest = [...(project?.messages || [])].reverse().find(message => message.role === 'assistant');
  const latestPrompt = [...(project?.messages || [])].reverse().find(message => message.role === 'user' && !message.hidden)?.content || 'Agent QA repair';
  const messageKey = (project?.messages || []).map(message => `${message.id}:${message.content?.length || 0}`).join('|');
  const workspaceKey = JSON.stringify(project?.workspace || {});
  const files = useMemo(() => {
    if (project?.workspace && Object.keys(project.workspace).length) return Object.entries(project.workspace).map(([path,content])=>({path,content,language:path.split('.').pop()}));
    return materializeFiles(project?.messages || []);
  }, [messageKey, workspaceKey]);
  useEffect(() => { if (files.length && !files.some(file => file.path === activePath)) setActivePath(files[0].path); }, [files, activePath]);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef(null);
  useEffect(() => { setEdits({}); setRuntimeProblems([]); setPreviewReady(false); }, [project?.id]);
  const handleFileEdit = (path,content) => {
    setSaving(true); onEditFile?.(path,content);
    clearTimeout(saveTimer.current); saveTimer.current=setTimeout(()=>{setSaving(false);setEdits(old=>{const next={...old};delete next[path];return next})},500);
  };
  const applyElementChanges=(text,values)=>{
    if(!selection)return; const htmlFile=files.find(file=>file.path===activePage); if(!htmlFile)return;
    const htmlContent=edits[htmlFile.path]??htmlFile.content; const doc=new DOMParser().parseFromString(htmlContent,'text/html'); let node; try{node=doc.querySelector(selection.selector)}catch{} if(!node)return;
    if(text!==selection.text)node.textContent=text;
    const doctype=/^\s*<!doctype/i.test(htmlContent)?'<!DOCTYPE html>\n':'';
    const cssFile=files.find(file=>/\.css$/i.test(file.path)); const declarations=[];
    ['color','background','fontSize','padding','borderRadius','width','height','textAlign'].forEach(key=>{if(values[key]&&values[key]!==selection.styles?.[key])declarations.push(`${key.replace(/[A-Z]/g,m=>`-${m.toLowerCase()}`)}: ${values[key]};`)});
    let visibility=''; if(values.visibility==='hidden')visibility='display:none!important;'; if(values.visibility==='desktop')visibility='display:none!important;';
    let rule=declarations.length||visibility?`\n\n/* Visual edit */\n${selection.selector} { ${declarations.join(' ')} ${visibility} }`:'';
    if(values.visibility==='mobile')rule+=`\n@media (min-width: 769px) { ${selection.selector} { display:none!important; } }`;
    if(values.visibility==='desktop')rule+=`\n@media (min-width: 769px) { ${selection.selector} { display:revert!important; } }`;
    const patch={[htmlFile.path]:doctype+doc.documentElement.outerHTML}; if(cssFile&&rule)patch[cssFile.path]=(edits[cssFile.path]??cssFile.content)+rule;
    onPatchFiles?.(patch,`Edited ${selection.selector}`); setSelection(null);
  };
  const staticProblems = useMemo(() => validateProject(files, edits), [files, edits]);
  const problems = useMemo(() => {
    const all = new Map();
    [...staticProblems, ...runtimeProblems].forEach(problem => all.set(problem.id, problem));
    return [...all.values()];
  }, [staticProblems, runtimeProblems]);
  const errors = useMemo(() => problems.filter(problem => problem.severity === 'error'), [problems]);
  const repairRoundsUsed = project?.repairRounds || 0;
  const repairLimitReached = repairRoundsUsed >= 2;
  const isAutoRepairing = busy && latest?.agentRepair;
  const pages=files.filter(file=>/\.html?$/i.test(file.path));
  useEffect(()=>{if(pages.length&&!pages.some(page=>page.path===activePage))setActivePage(pages[0].path)},[pages.map(page=>page.path).join('|'),activePage]);
  const preview = useMemo(() => composePreview(files, edits, channelRef.current, activePage, selectMode), [files, edits, activePage, selectMode]);
  const [stablePreview, setStablePreview] = useState(preview);
  const [zipping, setZipping] = useState(false);
  useEffect(() => { const timer = setTimeout(() => { setStablePreview(preview); setPreviewReady(false); }, 280); return () => clearTimeout(timer); }, [preview]);
  const refreshPreview = () => {
    setRuntimeProblems([]);
    setPreviewReady(false);
    setRefreshKey(k => k + 1);
    setStablePreview('');
    setTimeout(() => setStablePreview(preview), 60);
    setMode('preview');
  };
  const triggerManualRepair = () => {
    const currentErrors = problems.filter(problem => problem.severity === 'error');
    if (!currentErrors.length || busy || !onRepair) return;
    attemptedRepairs.current.clear();
    onResetRepairRounds?.();
    const snapshot = files.map(file => `\`\`\`${file.language}{path=${file.path}}\n${file.content}\n\`\`\``).join('\n');
    onRepair(`Automatic QA detected these concrete errors. Modify only the necessary virtual files, return each changed file in full, and preserve everything else.\n\n${currentErrors.slice(0,12).map(error=>`- ${error.path}:${error.line || 1} — ${error.message}`).join('\n')}\n\nCURRENT FILESYSTEM:\n${snapshot}`);
  };
  useEffect(() => {
    const receive = event => {
      const data = event.data;
      if (!data?.__hama || !String(data.channel||'').startsWith(channelRef.current)) return;
      const auditChannel=data.channel!==channelRef.current;
      if(auditChannel&&data.kind!=='audit')return;
      if (data.kind === 'ready' || data.kind === 'heartbeat') {
        setPreviewReady(true);
        if (data.kind === 'ready') setRuntimeProblems(old => old.filter(item => String(item.source||'').startsWith('axe')));
      }
      if (data.kind === 'selection') { setSelection(data); setSelectMode(false); }
      if (data.kind === 'navigate' && /\.html?$/i.test(data.path || '')) setActivePage(data.path);
      if (data.kind === 'audit') setAuditResults(old=>({...old,[String(data.label)]:data}));
      const incoming = [];
      if (data.kind === 'console' || data.kind === 'runtime') incoming.push({ id:`${data.kind}:${data.path || 'preview'}:${data.line || 1}:${data.message}`, severity:data.severity || 'error', message:data.message, path:data.path || 'preview', line:data.line || 1, source:data.kind });
      if (data.kind === 'axe') (data.violations || []).forEach(item => incoming.push({ id:`axe:${item.id}:${item.target}`, severity:['critical','serious'].includes(item.impact) ? 'error' : 'warning', message:`${item.help}${item.nodes > 1 ? ` (${item.nodes} elements)` : ''}`, path:'index.html', line:1, source:`accessibility · ${item.id}` }));
      if (incoming.length) setRuntimeProblems(old => { const merged = new Map(old.map(item => [item.id,item])); incoming.forEach(item => merged.set(item.id,item)); return [...merged.values()].slice(-100); });
    };
    addEventListener('message', receive);
    return () => removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (busy || latest?.aborted || project?.pending || !latest?.content || !errors.length || Object.keys(edits).length || (project?.repairRounds || 0) >= 2 || !onRepair) return;
    const key = `${latest.id}:${errors.map(error => error.id).sort().join('|')}`;
    if (attemptedRepairs.current.has(key)) return;
    const timer = setTimeout(() => {
      attemptedRepairs.current.add(key);
      const snapshot = files.map(file => `\`\`\`${file.language}{path=${file.path}}\n${file.content}\n\`\`\``).join('\n');
      onRepair(`Automatic QA detected these concrete errors. Modify only the necessary virtual files, return each changed file in full, and preserve everything else.\n\n${errors.slice(0,12).map(error=>`- ${error.path}:${error.line || 1} — ${error.message}`).join('\n')}\n\nCURRENT FILESYSTEM:\n${snapshot}`);
    }, 1800);
    return () => clearTimeout(timer);
  }, [busy, errors, latest?.id, latest?.aborted, project?.repairRounds, files, edits, onRepair]);
  const stageMap=new Map(); for(const match of String(latest?.content||'').matchAll(/\[\[HAMA_STAGE:([^:]+):([^:]+):([^\]]+)\]\]/g))stageMap.set(match[1],{id:match[1],status:match[2],label:match[3]});
  const agentStages=[...stageMap.values()];
  const versions = project?.messages.filter(message => message.role === 'assistant' && message.content).length || 0;
  const responsivePreviews=[['Mobile',375],['Tablet',768],['Desktop',1440]].map(([label,width])=>({label,width,src:responsiveOpen?composePreview(files,edits,`${channelRef.current}-audit-${width}`,activePage,false,String(width)):''}));
  const download = async () => {
    if (!files.length || zipping) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      files.forEach(file => { const content=edits[file.path] ?? file.content, path=file.path.replace(/^\/+/, ''); const match=String(content).match(/^data:[^;]+;base64,(.+)$/s); zip.file(path,match?match[1]:content,match?{base64:true}:undefined); });
      zip.file('README.md', `# ${project?.title || 'HAMA CODER build'}\n\nGenerated with HAMA CODER using ${MODELS.find(item => item.value === model)?.label || model}.\n\nOpen index.html in a browser to run this project.\n`);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(project?.title || 'hama-coder-build').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'hama-coder-build'}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } finally { setZipping(false); }
  };
  return <main className="workbench" onDragOver={event=>event.preventDefault()} onDrop={async event=>{event.preventDefault();if(event.dataTransfer.files?.length){const patch=await filesFromDrop(event.dataTransfer);onImport?.(patch,`Dropped ${Object.keys(patch).length} files`);}}}>
    <header className="workbench-nav"><button className="wb-menu-btn" onClick={onMenu} title="Open sidebar">☰</button><div className="wb-brand" onClick={onBack} title="Return to home"><Mark/><b>HAMA CODER</b><span>/</span><strong>{project?.title}</strong></div><div className="wb-mobile-tabs"><button className={mobilePanel==='thread'?'active':''} onClick={()=>setMobilePanel('thread')}>Thread</button><button className={mobilePanel==='preview'?'active':''} onClick={()=>setMobilePanel('preview')}>Preview</button></div><div className="wb-actions"><span className={`wb-status ${busy?'busy':''}`}><i/>{busy?'Agent team working':saving?'Saving':'All changes saved'}</span><button onClick={()=>setImportOpen(true)}>Import</button><button onClick={()=>setAssetsOpen(true)}>Assets</button><button onClick={()=>setHistoryOpen(true)}>History</button><button onClick={onImage}><UIIcon name="image" size={12}/> Image</button><button className="primary" onClick={download} disabled={!files.length||zipping}>{zipping?'Preparing…':'Export ZIP'} <span>↓</span></button></div></header>
    <div className="workbench-body"><aside className={`build-thread ${mobilePanel==='thread'?'mobile-show':''}`}><header><div><small>BUILD THREAD</small><b>Version {Math.max(versions,1)}</b></div><span className="thread-model"><i/>{MODELS.find(item=>item.value===model)?.label}</span></header><div className="thread-scroll"><article className="request-message"><span className="message-avatar">VN</span><div><small>You · just now</small><p>{latestPrompt}</p></div></article><article className="build-result"><div className="result-head"><span className={busy?'working':errors.length?'has-errors':''}>✦</span><div><b>{busy ? (isAutoRepairing ? 'Automatic QA repairing' : 'Agent team building') : latest?.aborted ? 'Generation stopped' : errors.length > 0 ? (repairLimitReached ? 'Repair limit reached (2/2)' : 'Issues detected') : 'Build validated'}</b><small>{busy ? (isAutoRepairing ? `Agent developer fixing errors · ${repairRoundsUsed}/2` : 'Architect → developer → independent reviewer') : latest?.aborted ? 'Build was stopped by user' : errors.length > 0 ? `${files.length} files · ${problems.length} detected problems · ${repairRoundsUsed}/2 repair rounds` : `${files.length} files · 0 errors · Build verified`}</small></div><i>{busy ? '•••' : latest?.aborted ? '■' : errors.length > 0 ? '!' : '✓'}</i></div>{errors.length > 0 && !busy && <div className="qa-repair-actions"><button className="qa-autofix-btn" onClick={triggerManualRepair} title="Send detected errors to AI to fix automatically"><UIIcon name="spark" size={13}/><b>Fix with AI ({errors.length} error{errors.length > 1 ? 's' : ''})</b></button>{repairLimitReached && <button className="qa-reset-btn" onClick={() => { onResetRepairRounds?.(); attemptedRepairs.current.clear(); }} title="Reset repair counter so auto-repair can run again">Reset limit</button>}</div>}<div className="result-files">{files.length?files.map(file=><button key={file.path} onClick={()=>{setActivePath(file.path);setMode('code');setMobilePanel('preview')}}><span>‹/›</span><div><b>{file.path.split('/').pop()}</b><small>{file.language.toUpperCase()}</small></div><i>→</i></button>):<div className="result-skeleton"><i/><i/><i/></div>}</div></article>{agentStages.length>0&&<article className="agent-progress"><header><span>AGENT TEAM</span><b>{agentStages.filter(stage=>stage.status==='done').length}/{agentStages.length}</b></header>{agentStages.map(stage=><div key={stage.id} className={stage.status}><i>{stage.status==='done'?'✓':'●'}</i><span>{stage.label}</span></div>)}{!busy&&<div className="done"><i>✓</i><span>Browser validation completed</span></div>}</article>}<div className="repair-policy"><span><b>QA repairs</b><small>{project?.repairPolicy==='auto'?'Apply after validation':'Show diff before applying'}</small></span><div><button className={project?.repairPolicy!=='auto'?'active':''} onClick={()=>onSetRepairPolicy?.('review')}>Review first</button><button className={project?.repairPolicy==='auto'?'active':''} onClick={()=>{onSetRepairPolicy?.('auto');if(errors.length>0&&!busy)triggerManualRepair();}}>Auto repair</button></div></div><div className="version-line"><span>V{Math.max(versions,1)}</span><i/><small>Current version</small></div></div><div className="thread-compose"><PromptBox compact busy={busy} onStop={onStop} onSend={onSend} placeholder="Describe a change…" model={model} onModelChange={onModelChange} smart={smart} onSmartChange={onSmartChange} search={search} onSearchChange={onSearchChange}/></div></aside>
      <section className={`preview-stage ${mobilePanel==='preview'?'mobile-show':''}`}><header className="preview-toolbar"><div className="browser-controls"><i/><i/><i/></div>{mode==='preview'?<><div className="preview-address"><span>⌁</span><b>Local preview</b><div className="preview-select-wrap"><select value={activePage} onChange={e=>setActivePage(e.target.value)}>{pages.map(page=><option key={page.path} value={page.path}>{page.path}</option>)}</select><svg className="preview-select-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg></div></div><button className="preview-btn refresh-btn" onClick={refreshPreview} title="Reload preview and reset console"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></button><button className={`preview-btn inspect-btn ${selectMode?'inspecting':''}`} onClick={()=>setSelectMode(!selectMode)} title="Select an element to edit"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg><span>Inspect</span></button><button className="preview-btn qa-btn" onClick={()=>{setAuditResults({});setResponsiveOpen(true)}} title="Test mobile, tablet and desktop viewports"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><span>QA</span></button><div className="device-switch"><button className={device==='desktop'?'active':''} onClick={()=>setDevice('desktop')} title="Desktop">▰</button><button className={device==='mobile'?'active':''} onClick={()=>setDevice('mobile')} title="Mobile">▯</button></div></>:<div style={{flex:1}}/>}{mode==='code'&&<span style={{fontSize:'12px',color:'#717684',fontWeight:500,letterSpacing:'-0.1px'}}>Editor Mode · Read & Write</span>}<div className="view-switch"><button className={mode==='preview'?'active':''} onClick={()=>setMode('preview')}>Preview</button><button className={mode==='code'?'active':''} onClick={()=>setMode('code')}>Code</button></div></header><div className={`preview-surface ${mode==='preview'?device:''}`}>{mode==='code'?<CodeView files={files} activePath={activePath} setActivePath={setActivePath} edits={edits} setEdits={setEdits} onEdit={handleFileEdit} busy={busy} problems={problems} saving={saving}/>:stablePreview?<iframe key={refreshKey} title="Generated preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={stablePreview}/>:<div className="preview-loading"><span className={busy?'spin':''}>✦</span><b>{busy?'Creating your interface':'Nothing to preview yet'}</b><small>{busy?'Files will appear here as they are generated.':'Start a new build from the home screen.'}</small></div>}</div>{mode==='preview'&&<footer className="preview-footer"><span><i className={previewReady?'online':''}/>{busy?'Receiving files':previewReady?`${problems.length} problems · sandbox active`:'Running safety checks'}</span><div>{errors.length>0&&!busy&&<button className="footer-fix-btn" onClick={triggerManualRepair} title="Ask AI to fix detected errors">✦ Fix {errors.length} error{errors.length>1?'s':''}</button>}<button onClick={refreshPreview} title="Reload preview and reset console">↻ Refresh</button><button onClick={download} disabled={!files.length}>↓ Download</button></div></footer>}</section>
    </div>
    <DiffReview pending={project?.pending} workspace={project?.workspace||{}} onAccept={onAcceptPending} onReject={onRejectPending}/>
    {historyOpen&&<VersionPanel versions={project?.versions||[]} workspace={project?.workspace||{}} onRestore={onRestoreVersion} onRename={onRenameVersion} onClose={()=>setHistoryOpen(false)}/>} 
    {selection&&<VisualPanel selection={selection} files={files} onApply={applyElementChanges} onClose={()=>setSelection(null)}/>} 
    {importOpen&&<ImportPanel onImport={onImport||onPatchFiles} onClose={()=>setImportOpen(false)}/>} 
    {assetsOpen&&<AssetManager files={files} onPatch={onPatchFiles} onClose={()=>setAssetsOpen(false)}/>} 
    {responsiveOpen&&<ResponsivePanel results={auditResults} previews={responsivePreviews} onClose={()=>setResponsiveOpen(false)}/>} 
  </main>;
}

function ImageStudio({ onClose, onSave }) {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('square');
  const [image, setImage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);
  const generate = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true); setError('');
    const sizes = { square:[1024,1024], landscape:[1280,768], portrait:[768,1280] };
    const [width,height] = sizes[ratio];
    try {
      const response = await fetch(`/api/image?prompt=${encodeURIComponent(prompt)}&width=${width}&height=${height}`);
      if (!response.ok) throw new Error((await response.json().catch(()=>null))?.error || 'Image generation failed');
      if (image) URL.revokeObjectURL(image);
      setImage(URL.createObjectURL(await response.blob()));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  const download = () => { const a=document.createElement('a');a.href=image;a.download='hama-coder-image.jpg';a.click(); };
  const saveToProject=async()=>{if(!image||!onSave)return;const blob=await fetch(image).then(response=>response.blob());const data=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)});onSave({[`assets/generated-${Date.now()}.jpg`]:data},'Added generated image');onClose();};
  return <div className="image-modal-backdrop" onMouseDown={onClose}><section className="image-studio" onMouseDown={event=>event.stopPropagation()}><header><div><span><UIIcon name="image" size={16}/></span><div><b>Image Studio</b><small>Free generation powered by Pollinations Flux</small></div></div><button onClick={onClose}>×</button></header><div className="image-studio-body"><div className="image-result">{image?<img src={image} alt={prompt}/>:<div className={loading?'loading':''}><UIIcon name="image" size={27}/><b>{loading?'Creating your image…':'Your image will appear here'}</b><small>Safe generation · no API key required</small></div>}</div><aside><label>IMAGE PROMPT<textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="A cinematic abstract landscape in cobalt blue…"/></label><label>ASPECT RATIO<div className="ratio-switch">{['square','landscape','portrait'].map(item=><button key={item} className={ratio===item?'active':''} onClick={()=>setRatio(item)}>{item}</button>)}</div></label>{error&&<p>{error}</p>}<div className="image-actions"><button onClick={generate} disabled={!prompt.trim()||loading}><UIIcon name="spark" size={13}/>{loading?'Generating…':'Generate image'}</button><button onClick={download} disabled={!image}>↓ Download</button>{onSave&&<button onClick={saveToProject} disabled={!image}>＋ Add to project</button>}</div></aside></div></section></div>;
}

export default function App() {
  const [projects, setProjects] = useState(() => { try { return JSON.parse(localStorage.getItem('hama-studio-v4') || localStorage.getItem('echo-studio-v3')) || []; } catch { return []; } });
  const [activeId, setActiveId] = useState(null), [view, setView] = useState('home'), [busy, setBusy] = useState(false), [mobileOpen, setMobileOpen] = useState(false), [connected, setConnected] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem('hama-model') || localStorage.getItem('echo-model') || MODELS[0].value);
  const [smart, setSmart] = useState(() => (localStorage.getItem('hama-smart') ?? localStorage.getItem('echo-smart')) !== 'false');
  const [search, setSearch] = useState(() => localStorage.getItem('hama-web-search') === 'true');
  const [imageOpen, setImageOpen] = useState(false);
  const [globalImportOpen,setGlobalImportOpen]=useState(false);
  const abortRef = useRef(null);
  const storageReady=useRef(false);
  const active = useMemo(() => projects.find(project => project.id === activeId), [projects, activeId]);
  useEffect(()=>{loadSavedProjects().then(saved=>{if(saved.length)setProjects(saved);storageReady.current=true})},[]);
  useEffect(() => { if(!storageReady.current)return; saveProjects(projects); try{const json=JSON.stringify(projects);if(json.length<3500000)localStorage.setItem('hama-studio-v4',json)}catch{} }, [projects]);
  useEffect(() => localStorage.setItem('hama-model', model), [model]);
  useEffect(() => localStorage.setItem('hama-smart', String(smart)), [smart]);
  useEffect(() => localStorage.setItem('hama-web-search', String(search)), [search]);
  useEffect(() => { fetch('/api/status').then(response => response.json()).then(data => setConnected(data.connected)).catch(() => setConnected(false)); }, []);
  useEffect(() => { const fn = e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newBuild(); } }; addEventListener('keydown', fn); return () => removeEventListener('keydown', fn); });
  const stopGeneration = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setBusy(false);
    if (activeId) {
      setProjects(items => items.map(project => {
        if (project.id !== activeId) return project;
        return {
          ...project,
          repairRounds: 99,
          messages: project.messages.map((message, idx, arr) => {
            if (idx === arr.length - 1 && message.role === 'assistant') {
              return {
                ...message,
                aborted: true,
                content: (message.content || '').trim() ? message.content + '\n\n*(Generation stopped by user)*' : '*(Generation stopped by user)*'
              };
            }
            return message;
          })
        };
      }));
    }
  };
  const newBuild = () => { stopGeneration(); setActiveId(null); setView('home'); setMobileOpen(false); };
  const open = id => { setActiveId(id); setView('builder'); setMobileOpen(false); };
  const workspaceFrom = project => project?.workspace || Object.fromEntries(materializeFiles(project?.messages || []).map(file => [file.path, file.content]));
  const checkpoint = (project, label, workspace = workspaceFrom(project)) => ({ id:uid(), label, createdAt:Date.now(), workspace:{...workspace} });
  const updateProject = (id, updater) => setProjects(items => items.map(project => project.id === id ? updater(project) : project));
  const editWorkspaceFile = (path, content, label = 'Manual edit') => {
    if (!activeId) return;
    updateProject(activeId, project => {
      const current = workspaceFrom(project);
      const shouldCheckpoint = project.lastManualPath !== path || Date.now() - (project.lastManualAt || 0) > 30000;
      return {...project, workspace:{...current,[path]:content}, lastManualPath:path,lastManualAt:Date.now(), versions:shouldCheckpoint?[...(project.versions||[]),checkpoint(project,label,current)].slice(-30):(project.versions||[])};
    });
  };
  const applyWorkspacePatch = (patch, label = 'Visual edit') => {
    if (!activeId) return;
    updateProject(activeId, project => {
      const current=workspaceFrom(project), next={...current}; Object.entries(patch).forEach(([path,content])=>content==='__HAMA_DELETE__'?delete next[path]:next[path]=content); return {...project,workspace:next,versions:[...(project.versions||[]),checkpoint(project,label,current)].slice(-30)};
    });
  };
  const acceptPending = paths => updateProject(activeId, project => {
    if (!project.pending) return project;
    const selected = paths || project.pending.files.map(file=>file.path);
    const current=workspaceFrom(project), next={...current};
    project.pending.files.forEach(file=>{if(selected.includes(file.path)) next[file.path]=file.content;});
    const left=project.pending.files.filter(file=>!selected.includes(file.path));
    return {...project,workspace:next,pending:left.length?{...project.pending,files:left}:null,versions:[...(project.versions||[]),checkpoint(project,project.pending.agentRepair?'Before automatic repair':'Before AI changes',current)].slice(-30)};
  });
  const rejectPending = paths => updateProject(activeId, project => {
    if (!project.pending) return project;
    if (!paths) return {...project,pending:null,repairRounds:project.pending.agentRepair?2:project.repairRounds};
    const left=project.pending.files.filter(file=>!paths.includes(file.path));
    return {...project,pending:left.length?{...project.pending,files:left}:null,repairRounds:!left.length&&project.pending.agentRepair?2:project.repairRounds};
  });
  const restoreVersion = (version, path) => updateProject(activeId, project => {
    const current=workspaceFrom(project), next=path?{...current,[path]:version.workspace[path]}:{...version.workspace};
    return {...project,workspace:next,pending:null,versions:[...(project.versions||[]),checkpoint(project,`Before restoring ${version.label}`,current)].slice(-30)};
  });
  const renameVersion = (versionId,label) => updateProject(activeId, project => ({...project,versions:(project.versions||[]).map(version=>version.id===versionId?{...version,label}:version)}));
  const importAsProject=(workspace,label='Imported project')=>{const id=uid();setProjects(items=>[{id,title:label,messages:[],createdAt:Date.now(),repairRounds:0,repairPolicy:'auto',workspace,versions:[{id:uid(),label:'Imported files',createdAt:Date.now(),workspace:{}}]},...items]);setActiveId(id);setView('builder');setGlobalImportOpen(false)};
  async function send(text, options = {}) {
    if (busy) return;
    const agentRepair = options.agentRepair === true;
    let id = activeId;
    const currentProject = active;
    const baseWorkspace = workspaceFrom(currentProject);
    const user = { id: uid(), role:'user', content:text, hidden: options.hidden === true, agentRepair };
    const assistant = { id:uid(), role:'assistant', content:'', agentRepair };
    const previous = currentProject?.messages || [];
    const filesystemContext = Object.keys(baseWorkspace).length ? {id:uid(),role:'assistant',hidden:true,content:Object.entries(baseWorkspace).map(([path,content])=>`\`\`\`${path.split('.').pop()}{path=${path}}\n${content}\n\`\`\``).join('\n')} : null;
    const requestMessages = [...previous.slice(-6), ...(filesystemContext?[filesystemContext]:[]), user];
    if (!id) {
      id=uid();
      setProjects(items => [{id,title:titleFor(text),messages:[user,assistant],createdAt:Date.now(),repairRounds:0,workspace:{},versions:[],repairPolicy:'auto'},...items]);
      setActiveId(id);
    } else {
      setProjects(items => items.map(project => project.id===id ? {...project,repairRounds:agentRepair ? (project.repairRounds || 0) + 1 : 0,messages:[...project.messages,user,assistant]} : project));
    }
    setView('builder'); setBusy(true);
    const controller = new AbortController(); abortRef.current=controller;
    let generated='';
    try {
      for await (const token of streamChat({messages:requestMessages,model,mode:agentRepair ? 'fast' : smart ? 'smart' : 'fast',search:agentRepair ? false : search,signal:controller.signal})) {
        generated += token;
        setProjects(items => items.map(project => project.id===id ? {...project,messages:project.messages.map(message => message.id===assistant.id ? {...message,content:message.content+token}:message)}:project));
      }
      const returned=parseFiles(generated).filter(file=>file.path!=='response.txt');
      if(returned.length) setProjects(items=>items.map(project=>{
        if(project.id!==id) return project;
        const current=workspaceFrom(project);
        if(!Object.keys(current).length) { const initialFiles=Object.fromEntries(returned.map(file=>[file.path,file.content])); return {...project,workspace:initialFiles,versions:[checkpoint(project,'Initial generation',initialFiles)]}; }
        const changed=returned.filter(file=>current[file.path]!==file.content);
        if(!changed.length) return project;
        const proposal={id:uid(),createdAt:Date.now(),files:changed.map(file=>({...file,baseContent:current[file.path]||''})),agentRepair,summary:agentRepair?'Automatic QA repair':'AI change proposal'};
        if(agentRepair && project.repairPolicy==='auto') {
          const next={...current}; changed.forEach(file=>next[file.path]=file.content);
          return {...project,workspace:next,versions:[...(project.versions||[]),checkpoint(project,'Before automatic repair',current)].slice(-30)};
        }
        return {...project,pending:proposal};
      }));
    } catch(error) {
      if(error.name==='AbortError' || controller.signal.aborted) {
        setProjects(items => items.map(project => project.id === id ? {
          ...project,
          repairRounds: 99,
          messages: project.messages.map(message => message.id === assistant.id ? {
            ...message,
            aborted: true,
            content: (message.content || '').trim() ? message.content + '\n\n*(Generation stopped by user)*' : '*(Generation stopped by user)*'
          } : message)
        } : project));
      } else {
        setProjects(items => items.map(project => project.id === id ? {
          ...project,
          messages: project.messages.map(message => message.id === assistant.id ? {
            ...message,
            content: `Generation failed: ${error.message}`
          } : message)
        } : project));
      }
    } finally { setBusy(false); abortRef.current=null; }
  }

  const resetRepairRounds = () => {
    if (activeId) {
      setProjects(items => items.map(p => p.id === activeId ? { ...p, repairRounds: 0 } : p));
    }
  };

  return <div className={`studio-app ${view==='home'?'home-view':'builder-view'}`}><Sidebar projects={projects} activeId={activeId} onNew={newBuild} onOpen={open} open={mobileOpen} onClose={()=>setMobileOpen(false)} connected={connected} model={model}/>{view==='home'?<Home projects={projects} onSend={send} onOpen={open} model={model} onModelChange={setModel} smart={smart} onSmartChange={setSmart} search={search} onSearchChange={setSearch} onImage={()=>setImageOpen(true)} onImport={()=>setGlobalImportOpen(true)}/>:<Builder project={active} busy={busy} onSend={send} onRepair={text=>send(text,{agentRepair:true,hidden:true})} onStop={stopGeneration} onMenu={()=>setMobileOpen(true)} onBack={()=>setView('home')} model={model} onModelChange={setModel} smart={smart} onSmartChange={setSmart} search={search} onSearchChange={setSearch} onImage={()=>setImageOpen(true)} onEditFile={editWorkspaceFile} onPatchFiles={applyWorkspacePatch} onImport={applyWorkspacePatch} onAcceptPending={acceptPending} onRejectPending={rejectPending} onRestoreVersion={restoreVersion} onRenameVersion={renameVersion} onSetRepairPolicy={policy=>updateProject(activeId,project=>({...project,repairPolicy:policy}))} onResetRepairRounds={resetRepairRounds}/>} {imageOpen&&<ImageStudio onClose={()=>setImageOpen(false)} onSave={activeId?applyWorkspacePatch:null}/>} {globalImportOpen&&<ImportPanel onImport={importAsProject} onClose={()=>setGlobalImportOpen(false)}/>}</div>;
}
