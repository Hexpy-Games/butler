// test-category: pure-logic
import { strict as assert } from "node:assert";
import { loadavg } from "node:os";
import { writeFile } from "node:fs/promises";
import { perceptionSource } from "../../packages/butler-app/client/electron/browser/page/snapshot.mjs";
import { waitBrowserLowLoad } from "../support/browser-low-load";
import { launchSmokeBrowser } from "../support/smoke-browser";
const output=process.env.BUTLER_BROWSER_PERF_OUTPUT; assert.ok(output);
await waitBrowserLowLoad();
const browser=await launchSmokeBrowser();
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.setContent('<style>body{margin:0;font:12px system-ui;color:black;background:white}.row{height:24px}</style><main></main>');
  await page.evaluate(()=>{
    const root=document.querySelector('main')!;
    for(let n=0;n<10000;n++) {const element=document.createElement(n<200?'button':'div');element.className='row';element.id=`node-${n}`;element.textContent=`Item ${n}`;root.appendChild(element);}
  });
  const source=await page.evaluate(perceptionSource({obs:'parity',epoch:1,prefix:'f0-',full_grid:true})) as Record<string,unknown>;
  const optimized=await page.evaluate(perceptionSource({obs:'parity',epoch:1,prefix:'f0-'})) as Record<string,unknown>;
  for(const key of ['nodes','text','hidden','totals']) assert.deepEqual(optimized[key],source[key],`full-grid parity ${key}`);
  const rows=[];
  for(let n=0;n<30;n++) {
    const loadAverage1m=await waitBrowserLowLoad();
    const value=await page.evaluate(perceptionSource({obs:`perf-${n}`,epoch:1,prefix:'f0-'})) as {nodes:Array<{targetId:string;name:string}>;totals:{below_fold:number};scriptMs:number;gridSampleMs:number;walkerMs:number;proseMs:number;collectMs:number;emitMs:number};
    const expected=await page.evaluate(()=>[...document.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().top<innerHeight).map(e=>({id:e.id,name:e.textContent})));
    assert.deepEqual(value.nodes.map(node=>({id:node.targetId,name:node.name})),expected,'complete current visible targets in DOM order');
    assert.equal(value.nodes.length+value.totals.below_fold,200,'all below-fold targets counted');
    assert.equal(await page.locator('main>*').count(),10000);
    rows.push({scriptMs:value.scriptMs,gridSampleMs:value.gridSampleMs,walkerMs:value.walkerMs,proseMs:value.proseMs,collectMs:value.collectMs,emitMs:value.emitMs,loadAverage1m,visible:value.nodes.length,belowFold:value.totals.below_fold});
    await page.evaluate(n=>{document.getElementById('node-0')!.textContent=`Latest ${n}`},n);
  }
  const sorted=rows.map(row=>row.scriptMs).sort((a,b)=>a-b); const p95=sorted[Math.ceil(sorted.length*.95)-1]!;
  const reportOnly=process.env.BUTLER_BROWSER_PERF_REPORT_ONLY==='1';
  await writeFile(output,JSON.stringify({p95,rows,budgetMs:25,overBudget:p95>25,reportOnly},null,2));console.log(JSON.stringify({p95,loadAverage1m:loadavg()[0],reportOnly}));
  if(!reportOnly) assert.ok(p95<=25,`10k walker+grid p95 ${p95} exceeds 25ms`);
} finally {await browser.close();}
