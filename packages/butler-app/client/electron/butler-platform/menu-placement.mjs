import { Menu } from "electron";

/** Electron popup positions and View bounds are DIPs, not device pixels.
 * Only DOM client coordinates need page zoom; native context-menu params do not.
 */
export function menuPoint(contents, point, offset = { x: 0, y: 0 }, fromDom = false) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const zoom = fromDom ? contents.getZoomFactor() : 1;
  return { x: Math.round(offset.x + point.x * zoom), y: Math.round(offset.y + point.y * zoom) };
}

/** Reserve native menu chrome as well as text when flipping inside the host.
 * Measurements are independent of App zoom and only run on a menu request.
 */
export async function popupMenu(win, items, point, callback) {
  const menu = Menu.buildFromTemplate(items);
  if (!point) { menu.popup({ window: win, callback }); return; }
  const mac = process.platform === "darwin";
  const labels = menu.items.filter(item => item.visible).map(item => item.label);
  const width = await win.webContents.executeJavaScript(`(()=>{
    const context=document.createElement('canvas').getContext('2d');
    context.font=${JSON.stringify(mac ? "13px system-ui" : "14px system-ui")};
    return Math.max(...${JSON.stringify(labels)}.map(label=>context.measureText(label).width));
  })()`);
  const accelerator = menu.items.some(item => item.role || item.accelerator) ? 48 : 0;
  const size = { width: Math.ceil(width) + 34 + accelerator,
    height: 10 + menu.items.filter(item => item.visible).reduce((height, item) => height + (item.type === "separator" ? 12 : mac ? 24 : 32), 0) };
  const bounds = win.getContentBounds();
  const margin = 8;
  const place = (value, extent, limit) => Math.round(Math.max(margin,
    Math.min(value + extent > limit - margin ? value - extent : value, limit - extent - margin)));
  menu.popup({ window: win, x: place(point.x, size.width, bounds.width),
    y: place(point.y, size.height, bounds.height), callback });
}
