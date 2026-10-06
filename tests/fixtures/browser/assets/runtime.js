// Fixture-owned clock and RNG; timeouts retain real elapsed time for F05/F17.
const NativeDate = Date;
class FrozenDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [1791288000000])); }
  static now() { return 1791288000000; }
}
globalThis.Date = FrozenDate;
let seed = 737;
Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
const fixture = location.pathname.split('/')[1];
const pending = new Set();
globalThis.record = (target, type, value) => {
  const promise = fetch('/events', {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({fixture,target,type,value,origin:location.origin}),keepalive:true});
  pending.add(promise); promise.finally(() => pending.delete(promise)); return promise;
};
globalThis.flushEvents = async () => { await Promise.all([...pending]); };
for (const type of ['click','input','change','keydown','pointerdown','drop','submit']) {
  document.addEventListener(type, event => {
    const target = event.composedPath().find(node => node.id);
    record(target?.id ?? event.target.tagName ?? "document", type, event.type === 'keydown' ? event.key : target?.value);
  }, true);
}
// Closed-root retargeting hides the real node from document.composedPath.
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(options) {
  const root = attach.call(this, options);
  if (options.mode === 'closed') root.addEventListener('click', e => record(e.target.id, 'click'));
  return root;
};
