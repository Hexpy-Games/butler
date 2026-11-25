// Runs in an isolated renderer world. Return only compact layout facts.
export const checkScript = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
  const root = document.documentElement;
  const body = document.body;
  const media = body?.querySelector('img,svg,canvas,video,iframe,input,button');
  const blank = !body || (!body.innerText.trim() && !media);
  resolve({blank, overflow: Math.max(0, Math.ceil(Math.max(root.scrollWidth, body?.scrollWidth || 0) - root.clientWidth))});
})))`;
