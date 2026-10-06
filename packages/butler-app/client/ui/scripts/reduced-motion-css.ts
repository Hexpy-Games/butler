import type { Plugin } from "postcss";

/**
 * The OS rules are the CSS source of truth. Reuse their bodies in the DS
 * reduced-motion scope, including CSS modules loaded later. No runtime CSS
 * scans or component-specific override rules. @scope preserves specificity.
 */
export function reducedMotionCss(): Plugin {
  return {
    postcssPlugin: "butler-reduced-motion-scope",
    Once(root, { AtRule }) {
      root.walkAtRules("media", (media) => {
        if (media.params === "(prefers-reduced-motion: no-preference)") {
          const scope = new AtRule({ name: "scope", params: '(#root:not([data-motion="reduced"]), body:not(:has(#root)):not([data-motion="reduced"]))' });
          for (const node of [...(media.nodes ?? [])]) scope.append(node);
          media.append(scope);
          return;
        }
        if (media.params !== "(prefers-reduced-motion: reduce)") return;
        const scope = new AtRule({ name: "scope", params: '([data-motion="reduced"])' });
        for (const node of media.nodes ?? []) scope.append(node.clone());
        // Token media rules use :root. Inside an explicit scope they belong to
        // that scope, while the OS counterpart remains at the document root.
        scope.walkRules(":root", (rule) => { rule.selector = ":scope"; });
        media.after(scope);
      });
    },
  };
}
