import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL,fileURLToPath } from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(here,'../decision-desk/package.json'));
const {chromium}=require('@playwright/test');
const browser=await chromium.launch({channel:'msedge',headless:true})
 .catch(()=>chromium.launch({headless:true}));  // 本机没装 Edge 时退回自带 Chromium
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:2,reducedMotion:'reduce'});
 await page.goto(pathToFileURL(path.join(here,'index.html')).href);
 await page.evaluate(()=>document.fonts.ready);
 const problems=await page.evaluate(()=>{
  const names=['header','.main','.explain','.flow','.progress','footer'];
  const issues=[];
  for(const name of names){const el=document.querySelector(name);if(el.scrollHeight>el.clientHeight+1)issues.push(`${name}: vertical overflow`);}
  const blocks=names.filter(n=>n!=='.explain').map(n=>document.querySelector(n).getBoundingClientRect());
  for(let i=1;i<blocks.length;i++)if(blocks[i-1].bottom>blocks[i].top)issues.push('Sections overlap');
  if(!Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0))issues.push('Missing image');
  return issues;
 });
 if(problems.length)throw new Error(problems.join('; '));
 await page.screenshot({path:path.join(here,'看着办-项目卡.png')});
 console.log(JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('header,.main,.explain,.flow,.progress,footer')).map(e=>({element:e.className||e.tagName,rect:e.getBoundingClientRect().toJSON(),scroll:e.scrollHeight,client:e.clientHeight}))),null,2));
 let html=await readFile(path.join(here,'index.html'),'utf8');
 for(const asset of ['product-board.png','contact-qr.png']) {
  const img=await readFile(path.join(here,asset));
  html=html.replace(`src="${asset}"`,`src="data:image/png;base64,${img.toString('base64')}"`);
 }
 await writeFile(path.join(here,'看着办-项目卡.html'),html);
 await page.setViewportSize({width:1366,height:768});
 await page.screenshot({path:path.join(here,'preview-1366.png')});
 console.log('Exported PNG (3840×2160), self-contained HTML; verified at 1920 and 1366 widths.');
} finally {await browser.close();}
