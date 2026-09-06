import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'decision-desk/package.json'));
const { chromium } = require('@playwright/test');
const data = await mkdtemp(path.join(tmpdir(), 'kanzheban-card-'));
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production'], {cwd:path.join(root,'decision-desk'), env:{...process.env, PORT:'4336', DATA_DIR:data, FRONTEND_DIST:path.join(root,'frontend/dist')}, windowsHide:true, stdio:'pipe'});
child.stderr.on('data', b=>process.stderr.write(b));
const base='http://127.0.0.1:4336';
let browser;
try {
  for(let n=0;n<60;n++) {try {await fetch(base+'/api/bootstrap');break;} catch {await new Promise(r=>setTimeout(r,500));}}
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2,reducedMotion:'reduce'});
  const page=await context.newPage();
  await page.addInitScript(()=>localStorage.setItem('kanzheban.landing-entered','yes'));
  await page.goto(base);
  const run=await page.evaluate(async()=>{
    const send=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
    await fetch('/api/bootstrap');
    const run=await send('/api/runs',{prompt:'做一个校园活动报名页，无需登录，报名信息仅保存在页面内存，刷新后清空，限20人。',mode:'demo'});
    await send(`/api/runs/${run.id}/start`,{constraints:['无需登录','报名信息仅保存在页面内存，禁止 localStorage 持久化，刷新后清空','限20人']});
    return run;
  });
  let state;
  for(let n=0;n<60;n++) {state=await page.evaluate(id=>fetch(`/api/runs/${id}`).then(r=>r.json()),run.id);if(state.status==='waiting'||state.status==='error')break;await new Promise(r=>setTimeout(r,500));}
  console.log(JSON.stringify({status:state.status,decisions:state.decisions.map(d=>({id:d.id,summary:d.summary,kind:d.kind})),data}));
  await page.reload();
  await page.getByRole('button',{name:/做一个校园活动报名页/}).first().click();
  await page.waitForTimeout(600);
  console.log((await page.locator('body').innerText()).slice(0,6500));
  const close = page.getByRole('button',{name:'关闭这条提醒'});
  if(await close.count()) await close.click();
  await page.screenshot({path:path.join(here,'product-full.png'),fullPage:true});
  await page.screenshot({path:path.join(here,'product-board.png'),clip:{x:0,y:0,width:1440,height:620}});
  await writeFile(path.join(here,'capture-state.json'),JSON.stringify(state,null,2));
} finally {await browser?.close();child.kill();}


