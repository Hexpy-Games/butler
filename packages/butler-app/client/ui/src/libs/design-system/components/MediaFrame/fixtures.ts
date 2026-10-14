// Showcase pictures: flat placeholder illustrations of unrelated subjects (no photos, no brand marks).
const enc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const svg = (width: number, height: number, body: string) =>
  enc(`<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>${body}</svg>`);

export type FixturePicture = "paper" | "place" | "recipe" | "product" | "library" | "strip" | "column";

const PICTURES: Record<FixturePicture, () => string> = {
  // A paper's first page: title, authors, abstract lines and a figure.
  paper: () => svg(320, 400, "<rect width='320' height='400' fill='#f3f1ec'/><rect x='36' y='28' width='248' height='344' fill='#ffffff'/>"
    + "<rect x='60' y='56' width='200' height='12' rx='3' fill='#23262b'/><rect x='84' y='76' width='152' height='12' rx='3' fill='#23262b'/>"
    + "<rect x='100' y='100' width='120' height='6' rx='3' fill='#9aa0a8'/>"
    + [0, 1, 2, 3, 4].map((row) => `<rect x='60' y='${124 + row * 12}' width='${row === 4 ? 120 : 200}' height='5' rx='2.5' fill='#c9cdd2'/>`).join("")
    + "<rect x='60' y='196' width='200' height='96' rx='4' fill='#e7ecf3'/><path d='M72 276 L112 236 L148 256 L192 214 L248 244' fill='none' stroke='#3b6fd8' stroke-width='4'/>"
    + [0, 1, 2].map((row) => `<rect x='60' y='${308 + row * 12}' width='200' height='5' rx='2.5' fill='#c9cdd2'/>`).join("")),
  // A lake under hills and a low sun.
  place: () => svg(400, 320, "<rect width='400' height='320' fill='#cfe3ef'/><circle cx='300' cy='96' r='34' fill='#f6d27a'/>"
    + "<path d='M0 196 L92 120 L168 178 L248 108 L400 204 L400 320 L0 320 Z' fill='#6f8f74'/><path d='M0 222 L130 170 L250 214 L400 186 L400 320 L0 320 Z' fill='#4d6f58'/>"
    + "<rect y='240' width='400' height='80' fill='#7fa9c4'/><rect x='60' y='262' width='120' height='4' rx='2' fill='#b9d3e3'/><rect x='220' y='286' width='96' height='4' rx='2' fill='#b9d3e3'/>"),
  // A bowl of rice and vegetables from above.
  recipe: () => svg(360, 360, "<rect width='360' height='360' fill='#efe6da'/><circle cx='180' cy='184' r='132' fill='#d9cbb8'/><circle cx='180' cy='180' r='120' fill='#ffffff'/>"
    + "<circle cx='180' cy='180' r='96' fill='#e9a25b'/><circle cx='150' cy='150' r='22' fill='#f7f1e3'/><circle cx='154' cy='146' r='10' fill='#f2b632'/>"
    + "<circle cx='214' cy='204' r='12' fill='#5c9a4a'/><circle cx='196' cy='226' r='9' fill='#5c9a4a'/><circle cx='222' cy='160' r='8' fill='#c8432b'/><circle cx='140' cy='206' r='8' fill='#c8432b'/>"),
  // A kettle on a plain backdrop.
  product: () => svg(320, 400, "<rect width='320' height='400' fill='#e9e7e3'/><ellipse cx='160' cy='330' rx='96' ry='8' fill='#000000' opacity='0.08'/>"
    + "<path d='M92 170 Q92 140 120 136 L200 136 Q228 140 228 170 L236 316 Q236 326 226 326 L94 326 Q84 326 84 316 Z' fill='#3d4248'/>"
    + "<path d='M228 190 Q284 190 280 246 Q278 286 236 300' fill='none' stroke='#3d4248' stroke-width='12'/><path d='M92 186 L40 150 L46 142 L100 172 Z' fill='#3d4248'/>"
    + "<rect x='132' y='120' width='56' height='18' rx='6' fill='#25282c'/><rect x='104' y='176' width='18' height='120' rx='6' fill='#ffffff' opacity='0.12'/>"),
  // A code library's tile: braces and a few lines of code.
  library: () => svg(360, 360, "<rect width='360' height='360' fill='#1f2633'/><text x='56' y='196' font-family='IBM Plex Mono, monospace' font-size='120' fill='#7aa2f7'>{ }</text>"
    + [0, 1, 2].map((row) => `<rect x='64' y='${244 + row * 22}' width='${[176, 128, 208][row]}' height='10' rx='5' fill='${["#9ece6a", "#e0af68", "#565f89"][row]}'/>`).join("")),
  // A heading strip and a tall column: extreme shapes that sit inset on the matte.
  strip: () => svg(640, 72, "<rect width='640' height='72' fill='#ffffff'/><rect x='0' y='22' width='360' height='28' rx='6' fill='#23262b'/>"),
  column: () => svg(160, 420, "<rect width='160' height='420' fill='#ffffff'/>"
    + [0, 1, 2, 3, 4, 5, 6, 7].map((row) => `<rect x='16' y='${24 + row * 48}' width='${[112, 96, 120, 88, 104, 120, 72, 96][row]}' height='12' rx='6' fill='#9aa0a8'/>`).join("")),
};

/** A placeholder picture (data URL) for showcases. */
export function fixturePicture(kind: FixturePicture): string {
  return PICTURES[kind]();
}

/** A URL that never loads, for the failed state. */
export const BROKEN_PICTURE = "data:image/png;base64,broken";

/** A favicon for placeholder demos: a plain mark, no brand. */
export const FIXTURE_FAVICON = enc("<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='7' fill='#3b6fd8'/><circle cx='16' cy='16' r='7' fill='#ffffff'/></svg>");
