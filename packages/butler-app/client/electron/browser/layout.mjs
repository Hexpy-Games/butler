/** Optional content crop hints; never change an explicitly requested capture. */
export function contentRegions(regions, geometry) {
  if (!geometry) return [];
  const { width, height, cssWidth, cssHeight } = geometry;
  let left = 0, top = 0, right = cssWidth, bottom = cssHeight;
  for (const { frame, kind, rect: r, contains_fields: fields } of regions) {
    if (frame !== "f0" || fields || !/^(header|nav|banner|navigation)$/u.test(kind)) continue;
    if (r.height >= cssHeight * .7 && r.width <= cssWidth * .2) {
      if (r.x <= 1) left = Math.max(left, r.x + r.width);
      if (r.x + r.width >= cssWidth - 1) right = Math.min(right, r.x);
    }
    if (r.width >= cssWidth * .7 && r.height <= cssHeight * .2) {
      if (r.y <= 1) top = Math.max(top, r.y + r.height);
      if (r.y + r.height >= cssHeight - 1) bottom = Math.min(bottom, r.y);
    }
  }
  const canvases = canvasRegions(regions, geometry);
  if (left === 0 && top === 0 && right === cssWidth && bottom === cssHeight) return canvases;
  const x = Math.ceil(left * width / cssWidth), y = Math.ceil(top * height / cssHeight);
  const farX = Math.floor(right * width / cssWidth), farY = Math.floor(bottom * height / cssHeight);
  if (farX <= x || farY <= y) return canvases;
  return [{ name: "viewport_without_edge_navigation", region: [x, y, farX - x, farY - y],
    verification: "Candidate excludes semantic edge navigation only. Check the screenshot: retain all requested content before choosing it." }, ...canvases];
}

function canvasRegions(regions, { width, height, cssWidth, cssHeight }) {
  return regions.filter(region => region.kind === "canvas").map(({ name, rect: r }) => {
    const x = Math.max(0, Math.ceil(r.x * width / cssWidth));
    const y = Math.max(0, Math.ceil(r.y * height / cssHeight));
    const farX = Math.min(width, Math.floor((r.x + r.width) * width / cssWidth));
    const farY = Math.min(height, Math.floor((r.y + r.height) * height / cssHeight));
    return { name, region: [x, y, farX - x, farY - y], bounds: { left: x, top: y, right: farX, bottom: farY },
      verification: "Visible canvas bounds in screenshot coordinates. Verify the drawing in fresh pixels before choosing this crop." };
  }).filter(({ region: [,,w,h] }) => w > 0 && h > 0);
}
