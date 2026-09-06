import pw from '/Users/sakimi/Desktop/build-with-care/decision-desk/node_modules/playwright-core/index.js'
const { chromium } = pw
const BASE='http://127.0.0.1:4488'
const OUT='/Users/sakimi/Desktop/build-with-care/promo/videos/kanzheban-promo/capture/screenshots'
const b=await chromium.launch({executablePath:chromium.executablePath(),args:['--force-color-profile=srgb']})
const c=await b.newContext({viewport:{width:1920,height:1400},deviceScaleFactor:3,locale:'zh-CN'})
await c.addInitScript(()=>{try{localStorage.setItem('kanzheban.landing-entered','yes')}catch{}})
const p=await c.newPage(); const w=ms=>new Promise(r=>setTimeout(r,ms))
await p.goto(`${BASE}/`,{waitUntil:'networkidle'}); await w(1600)
await p.getByText('帮我构建一个网页版超级马里奥',{exact:false}).first().click(); await w(1800)
await p.locator('.board-lane.lane-validation .decision-card').first().screenshot({path:`${OUT}/crop-redcard.png`}); console.log('redcard')
// the verified lane, expanded — the green evidence cards
await p.locator('.board-lane.lane-verified .lane-toggle').click(); await w(1100)
await p.locator('.board-lane.lane-verified').screenshot({path:`${OUT}/crop-verified.png`}); console.log('verified')
// artifacts view: the running artifact + the evidence checklist
await p.getByText('成果与验证',{exact:true}).click(); await w(2600)
await p.locator('.artifacts, main').first().screenshot({path:`${OUT}/crop-artifacts.png`}).catch(()=>{})
console.log('artifacts')
// timeline strip
await p.getByText('过程时间线',{exact:true}).click(); await w(1600)
await p.locator('.unit-rail').last().screenshot({path:`${OUT}/crop-units.png`}); console.log('units')
await b.close()
