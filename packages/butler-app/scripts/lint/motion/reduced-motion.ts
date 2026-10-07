function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

function keyframeBodies(css: string): string[] {
  const bodies: string[] = [];
  for (const match of css.matchAll(/@keyframes\s+[\w-]+\s*\{/gu)) {
    let depth = 0;
    const start = (match.index ?? 0) + match[0].length - 1;
    for (let index = start; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      if (depth === 0) {
        bodies.push(css.slice(start, index + 1));
        break;
      }
    }
  }
  return bodies;
}

function stripVars(value: string): string {
  let output = value;
  // Innermost var() first so nested fallbacks disappear too.
  while (/var\([^()]*\)/u.test(output)) output = output.replace(/var\([^()]*\)/gu, " ");
  return output;
}

/** A transform that only moves through --motion-distance-* / --motion-scale-* tokens (or centers). */
export function tokenOnlyTransform(value: string): boolean {
  const numbers = [...stripVars(value).matchAll(/-?\d*\.?\d+(?:px|%|deg|turn)?/gu)].map((match) => match[0]);
  return numbers.every((number) => ["0", "0px", "0%", "1", "-50%", "50%", "-1"].includes(number));
}

const TRANSFORM_DECLARATION = /(?:^|[;{\s])(transform|translate|scale|rotate)\s*:\s*([^;}]+)/gu;

export function motionAudit(css: string): { moves: boolean; tokenOnly: boolean; reducedRule: boolean } {
  const clean = stripComments(css);
  const keyframes = keyframeBodies(clean);
  const transitionsTransform = /transition(?:-property)?\s*:[^;]*\b(?:transform|translate|scale|rotate)\b/u.test(clean);
  const keyframeTransforms = keyframes.flatMap((body) => [...body.matchAll(TRANSFORM_DECLARATION)].map((match) => match[2]));
  const allTransforms = [...clean.matchAll(TRANSFORM_DECLARATION)].map((match) => match[2]);
  return {
    moves: keyframes.length > 0 || transitionsTransform,
    tokenOnly: keyframeTransforms.every(tokenOnlyTransform) && (!transitionsTransform || allTransforms.every(tokenOnlyTransform)),
    reducedRule: /@media[^{]*prefers-reduced-motion/u.test(clean),
  };
}
