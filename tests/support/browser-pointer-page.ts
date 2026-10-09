/** Offline search/workspace page with the controls found on real sites. */
export const pointerPage = `<!doctype html><meta charset="utf-8"><title>Atlas search workspace</title>
<style>
body{margin:0;background:#fff;color:#202124;font:16px system-ui}header{padding:20px 36px;border-bottom:1px solid #ddd}
main{max-width:660px;padding:24px 36px}article{margin-bottom:24px}a{color:#174ea6}h2{font-size:20px;margin:6px 0}
p{margin:8px 0;line-height:1.5}input{width:320px}li{padding:10px;border:1px solid #ddd;cursor:grab}
</style><header><strong>Atlas</strong> · Search results · Projects · News</header><main>
<article><small>developer.example › browser › input</small><h2 id="pick">Browser input and selection guide</h2>
<a id="link" href="#visited">Read the browser guide</a><p id="text">Native mouse input must preserve every pressed button while moving across page content.</p></article>
<label>Result density <input id="range" type="range" min="0" max="100" value="20"></label>
<ul id="list"><li id="first" draggable="true">Browser integration</li><li id="second" draggable="true">Selection workspace</li><li>Saved results</li></ul>
<button id="double">Open details with a double click</button><section style="height:1500px"><h2 id="visited">More results</h2>
${Array.from({ length: 12 }, (_, i) => `<article><small>docs.example › result-${i}</small><h2>Input research result ${i + 1}</h2><p>Search pages contain nested headings, links and long scrollable content.</p></article>`).join("")}</section></main>
<script>
if(location.search)document.title='Atlas secondary workspace';
window.proof={clicks:0,right:0,double:0,drags:0};
link.addEventListener('click',e=>{e.preventDefault();proof.clicks++;history.replaceState(null,'','#visited')});
document.addEventListener('contextmenu',e=>{e.preventDefault();proof.right++});
double.addEventListener('dblclick',()=>proof.double++);
let held;first.addEventListener('dragstart',e=>{held=first;proof.drags++;e.dataTransfer.setData('text/plain','first')});
second.addEventListener('dragover',e=>e.preventDefault());
second.addEventListener('drop',e=>{e.preventDefault();second.after(held)});
for(const type of ['mousedown','mousemove','mouseup','wheel'])document.addEventListener(type,e=>{
  (proof.events??=[]).push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,detail:e.detail,deltaY:e.deltaY});
});
</script>`;
