/** Self-contained page-world resource helpers, serialized alongside the snapshot walker. */
export function snapshotFonts(out) {
  function noteFont(cs) {
    const italic = /^(italic|oblique)/u.test(cs.fontStyle) ? "italic" : "normal";
    for (const family of cs.fontFamily.split(",")) {
      const name = family.trim().replace(/^["']|["']$/gu, "").toLowerCase();
      if (!name) continue;
      if (!out.families.has(name)) out.families.set(name, new Set());
      out.families.get(name).add(`${cs.fontWeight}|${italic}`);
    }
  }
  function noteText(text) {
    // CSS case transforms and Unicode composition can paint glyphs absent from the raw text.
    for (const char of text + text.toUpperCase() + text.toLowerCase() + text.normalize("NFC")) out.chars.add(char);
  }

  /** @font-face rules of the families the copy uses; sheets this world cannot read are fetched by main. */
  function fontFaces() {
    const faces = [], sheets = new Set(), seen = new Set();
    const walk = (rules, base) => {
      for (const rule of rules) {
        if (rule.type === 5) {
          const s = rule.style, family = s.getPropertyValue("font-family").trim().replace(/^["']|["']$/gu, "").toLowerCase();
          if (out.families.has(family)) faces.push({ family, src: s.getPropertyValue("src"), weight: s.getPropertyValue("font-weight"), style: s.getPropertyValue("font-style"),
            stretch: s.getPropertyValue("font-stretch"), range: s.getPropertyValue("unicode-range"), features: s.getPropertyValue("font-feature-settings"), base });
        } else if (rule.type === 3) visit(rule.styleSheet);
        else if (rule.cssRules) walk(rule.cssRules, base);
      }
    };
    function visit(sheet) {
      if (!sheet || seen.has(sheet)) return;
      seen.add(sheet);
      let rules;
      try { rules = sheet.cssRules; } catch { if (sheet.href) sheets.add(sheet.href); return; }
      walk(rules, sheet.href || sheet.ownerNode?.baseURI || location.href);
    }
    for (const root of out.roots) if (root.nodeType === 9) { for (const sheet of root.styleSheets) visit(sheet); for (const sheet of root.adoptedStyleSheets ?? []) visit(sheet); }
    return { faces, sheets: [...sheets] };
  }
  return { noteFont, noteText, fontFaces };
}

export async function inlineSnapshotBlobs(assets, parts, clear) {
  for (const [url, token] of [...assets]) {
    if (!url.startsWith("blob:")) continue;
    assets.delete(url);
    let data = clear;
    try {
      const blob = await (await fetch(url)).blob();
      if (blob.size <= 3 * 1024 * 1024) data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(clear); reader.readAsDataURL(blob); });
    } catch { /* revoked */ }
    for (const key of Object.keys(parts)) parts[key] = parts[key].split(token).join(data);
  }
}
