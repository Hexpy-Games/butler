---
name: wallpaper-authoring
description: "Write, check and apply a custom live wallpaper module (GLSL) for the Butler App."
user-invocable: true
applicability: Use when the model decides the user wants a wallpaper that no installed module offers (e.g. "make me a rainy-window wallpaper"), or wants a user wallpaper module fixed or tuned.
allowed-tools: list_wallpapers, save_wallpaper_module, set_wallpaper
dispatch: none
review: none
reporting: In a sentence or two, say which wallpaper was made and whether it is applied; never paste compile logs to the user.
---

## Instructions

A wallpaper module is a manifest (`wallpaper.json`), a GLSL fragment shader (`shader.frag`) and, optionally, an overlay shader (`overlay.frag`) that the App compiles and draws. You save them with `save_wallpaper_module`, which answers with the App's compile check; fix what it reports and save again, then apply the module with `set_wallpaper`.

### 1. Save call and manifest

`save_wallpaper_module` takes `{id, manifest, shader, overlay?, replace_revision?}`: `manifest` is the `wallpaper.json` object, `shader` the `shader.frag` text, `overlay` the `overlay.frag` text. It checks the module and writes the files at once into the user's module folder (`userModuleDirectory` from `list_wallpapers`). Replacing an installed user module needs `replace_revision`, that module's `revision` from `list_wallpapers`; without it the save is refused with `wallpaper_module_exists`. Replace only a module the user wants changed; otherwise pick a new id. Never write module files with other tools, and never change built-in modules.

- `manifest` at most 32 KB, `shader` and `overlay` at most 64 KB each once written.
- `id` matches `^[a-z0-9]+(\.[a-z0-9-]+)+$`, at most 64 characters, e.g. `user.rainy-window`, and `manifest.id` equals it. `butler.*` ids are reserved for built-ins.
- `name` `{en, ko}` (both non-empty), `version` semver, `engine: 1`, `motion` `"static"` or `"animated"`, `image` `"none"` (a live wallpaper), `"optional"` (a live wallpaper or an image filter) or `"required"` (an image filter; a live wallpaper only with a `defaultImage`).
- Optional `timePeriod` in seconds (0 < t ≤ 5000π, default 5000π): the engine wraps `u_time` modulo it, so the motion must loop seamlessly there. Use angular frequencies that are whole multiples of `2π / timePeriod`.
- `params`: at most 8; the first 4 are the ones the picker shows first. Each has `key` (`^[a-z][A-Za-z0-9]{0,23}$`), `label` `{en, ko}`, `default` and optional `defaultDark`. Types:
  - `number` `{min, max, step, control?: "shuffle"}` (a slider; `shuffle` shows a button that picks a random value on the step grid instead, e.g. a composition seed)
  - `boolean` (an on/off switch)
  - `enum` `{options}`: 1 to 8 unique values, each a string or `{value, label: {en, ko}}` (the picker shows the labels)
  - `color`: `"#RRGGBB"`
  - `palette` `{size: 2..6, default: ["#RRGGBB", ...], defaultDark?, presets?: {name: {light: [...], dark: [...]}}}`
- Optional drawing fields (see sections 2 and 3):
  - `overlay: true`: the module has an `overlay.frag` (then required; without `overlay: true` it is refused).
  - `pixelRatio`: `"default"` or `"device"`.
  - `imageDim`: `"auto"` (default), `"noDarkStep"` or `"none"`.
  - `defaultImage`: a JPEG, PNG or WebP file in the module folder (at most 1 MB), e.g. `"photo.jpg"`.
  - `sceneTone`: `{param, darkPhases}` for scenes that follow the time of day.

### 2. Shaders

`shader.frag` is a GLSL ES 3.00 body: no `#version`, no `precision`, no declarations of engine or parameter uniforms. Define `void main()` and write `fragColor`. The engine prepends:

```glsl
out vec4 fragColor;
uniform vec2  u_resolution;        // drawing-buffer px
uniform float u_pixelRatio;
uniform float u_time;              // seconds, wrapped every timePeriod; constant when static
uniform float u_dark;              // 0 light, 1 dark
uniform float u_dayPhase;          // local time of day 0..1 (0 = 00:00)
uniform float u_seed;              // stable 0..1 per wallpaper instance
uniform sampler2D u_noiseTexture;  // 256x256 RGBA tiling noise, REPEAT + LINEAR
uniform sampler2D u_image;         // the source image (or the defaultImage); neutral 1x1 otherwise
uniform float u_hasImage;          // 0/1
uniform float u_imageAspectRatio;  // 0 when there is no image
uniform vec4  u_contentRect;       // text area (x, y, w, h), drawing-buffer px, bottom-left origin; zeros when unknown
```

Parameters arrive as `p_<key>`: number and boolean → `float` (booleans 0/1), enum → `int` (option index), color → `vec3` (sRGB 0..1), palette → `vec3 p_<key>[size]`. Light mode reads `default`, dark mode `defaultDark` when given. Compile errors name `shader.frag` or `overlay.frag` lines.

**Overlay (two passes).** With `overlay: true`, `shader.frag` is drawn once into a cached texture, without `u_time` (it is redrawn only when its inputs change: size, theme, params, image, `u_contentRect`, day phase), and `overlay.frag` runs every frame on top. `overlay.frag` follows the same rules and gets the same prelude and parameters plus `uniform sampler2D u_base` (declared by the engine; do not declare it): the cached result, read with `texture(u_base, gl_FragCoord.xy / u_resolution)`. Put everything that does not move in `shader.frag` and only the moving part (shimmer, drifting light, grain, particles) in `overlay.frag`.

**pixelRatio.** `"default"`: animated modules draw at pixel ratio 1, static ones up to 2. `"device"`: the module draws at the display's pixel ratio, for fine detail such as dots or hairlines that blur at 1; it costs up to 4× the pixels, so use it only with a light per-frame pass (an overlay).

**Images.** `imageDim` says how the image source's `dim` applies: `"auto"` applies it and the dark theme adds one more step; `"noDarkStep"` applies it without the dark step (a photo that should look the same in both themes); `"none"` applies no dim (the module keeps text readable itself, behind `u_contentRect`). `defaultImage` is bound as `u_image` when the source has no image, so an image module with one also works as a live wallpaper (`list_wallpapers` marks it `photo: true`). `save_wallpaper_module` cannot add image files: a save keeps the image of the module it replaces when the manifest still names it, and a new image comes only with a module archive the user imports.

**sceneTone.** `{ "param": "realtime", "darkPhases": [[0, 0.24], [0.76, 1]] }`: `param` is the key of a boolean param (by convention `realtime`) that makes the scene follow the local time of day (`u_dayPhase`); `darkPhases` holds at most 4 `[start, end]` day-phase ranges (0 ≤ start < end ≤ 1) in which the scene is dark. While the switch is on, the App treats the scene as dark in those ranges, whatever the app theme. `list_wallpapers` shows the param as `realtimeParam`.

### 3. Performance budget

- At most 1 ms per frame at 1440×900 on an integrated GPU: roughly 300 ALU operations per pixel for the part that runs every frame.
- Cache static work: when most of the picture does not move, set `overlay: true`, compute it once in `shader.frag`, and keep `overlay.frag` light (one `u_base` read plus a few operations).
- At most one 3×3 cell search (Voronoi / Worley) per pixel. Read `u_noiseTexture` instead of computing noise; keep fbm to 4 octaves or fewer and loops short with constant bounds.
- Avoid small loops around branches: on macOS the App draws through Metal, where a short loop whose body holds an `if` (e.g. over 3 or 4 layers) can cost many times its operation count. Unroll it by hand, or write the body without branches (`step`, `mix`, `clamp`).
- Animated modules draw at 20 fps; static modules draw only when something changes, so prefer `"static"` when motion adds little.
- The App watches frame time: a module over budget is marked as an error and replaced by the default wallpaper.

### 4. Design

- Abstract patterns from nature and the micro world (light through leaves, ink spreading in water, frost, cells, ripples in sand), not literal scenes or illustrations, unless the user asks for a scene.
- Apple-wallpaper restraint: a few big forms, at most 4 hues, generous calm space. Detail and motion live on the edges of forms, not everywhere.
- Abstract modules show the same shapes in light and dark: change colors (`defaultDark`, `u_dark`), never invert or redesign.
- Scene wallpapers (landscapes, photos, real-time scenes) keep the same look in light and dark: do not recolor or darken the scene for the theme. Keep text readable only with a local treatment behind `u_contentRect` (a soft veil, lower contrast and detail), never a global dim.
- Keep a quiet zone behind text: lower contrast and detail inside `u_contentRect` (when it is not zero). Behind text, brightness varies by about 10% at most.
- Film grain is a param (e.g. `grain`, 0..1, labeled "Film grain"), not a fixed amount; behind text it stays at 2–4%.
- Motion is visible within 2–3 seconds but calm: slow drift and breathing, no flashing, no fast rotation.

### 5. Workflow

1. Call `list_wallpapers`: note the current wallpaper and the existing ids, and pick a new id (or the id and `revision` of the user module to fix or tune).
2. Call `save_wallpaper_module` with `{id, manifest, shader}` (and `overlay` when the manifest sets `overlay: true`).
   - A refused save (`ok: false`) names the field and the rule it breaks: correct that and save again.
   - `status.state` `"error"`: `status.message` is the App's GLSL compile log (or the frame budget it missed). Fix the shader from the log and save again; after three failed attempts, simplify the shader instead of patching it.
   - `status.state` `"unknown"`: the App did not check the files in time, usually because its window is closed. Tell the user the wallpaper is saved but not yet checked; you may still apply it.
   - `status.state` `"ok"`: it compiled and fits the budget.
3. Apply it with `set_wallpaper`, source `{kind: "live", module: "<id>", params?}`, in the scope the user asked for. A module whose status is error is refused with its message.
4. To tune it, save it again with the changes, or change `params` through `set_wallpaper`.

### Example

`save_wallpaper_module` arguments, `manifest`:

```json
{
  "id": "user.dusk-pools",
  "name": { "en": "Dusk Pools", "ko": "황혼 웅덩이" },
  "version": "1.0.0",
  "engine": 1,
  "motion": "animated",
  "image": "none",
  "timePeriod": 62.83185307179586,
  "params": [
    { "key": "base", "label": { "en": "Base", "ko": "바탕" }, "type": "color", "default": "#efe9e1", "defaultDark": "#1c1b1f" },
    { "key": "glow", "label": { "en": "Glow", "ko": "빛" }, "type": "color", "default": "#f3c89b", "defaultDark": "#6b4a3a" },
    { "key": "strength", "label": { "en": "Strength", "ko": "강도" }, "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.6 },
    { "key": "grain", "label": { "en": "Film grain", "ko": "필름 그레인" }, "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.5 }
  ]
}
```

`id` is `"user.dusk-pools"`, and `shader`:

```glsl
// Two soft pools of light drifting slowly; the text area stays quiet.
// Frequencies are multiples of 0.1 rad/s, so the loop is seamless at 20π s.
float quietZone(vec2 p){
  if(u_contentRect.z<=0.) return 1.;
  vec2 halfSize=u_contentRect.zw*.5;
  vec2 d=max(abs(p-(u_contentRect.xy+halfSize))-halfSize,0.);
  return smoothstep(0.,160.*u_pixelRatio,length(d));
}

void main(){
  float aspect=u_resolution.x/u_resolution.y;
  vec2 p=gl_FragCoord.xy/u_resolution.y;
  vec2 a=vec2(.3*aspect,.35)+.06*vec2(sin(u_time*.3),cos(u_time*.2));
  vec2 b=vec2(.72*aspect,.68)+.06*vec2(cos(u_time*.4),sin(u_time*.3));
  float light=exp(-2.5*length(p-a))+.7*exp(-3.*length(p-b));
  light*=p_strength*mix(.4,1.,quietZone(gl_FragCoord.xy));
  float grain=(texture(u_noiseTexture,gl_FragCoord.xy/256.).r-.5)*.06*p_grain;
  fragColor=vec4(mix(p_base,p_glow,clamp(light,0.,1.))+grain,1.);
}
```

A mostly still scene with a small moving part splits into two passes: `manifest` adds `"overlay": true`, `shader` draws the still picture (no `u_time`), and `overlay` adds the motion:

```glsl
// overlay.frag: the cached scene plus a slow shimmer; a few operations per pixel.
void main(){
  vec2 uv=gl_FragCoord.xy/u_resolution;
  vec3 base=texture(u_base,uv).rgb;
  float shimmer=texture(u_noiseTexture,uv*3.+vec2(u_time*.01,0.)).g-.5;
  fragColor=vec4(base+shimmer*.03,1.);
}
```
