# Native Windows Firefox typing evidence (#525)

Production UI preview from `b4b059460` / preview.10 `eed5aacf1`, Playwright
1.59.1, Windows headless, 1280×900. Temporary renderer fixture instrumentation
was removed after capture. No production or frozen DS change is represented.

`typing-summary.json` contains all 84 phase summaries (28 cases, 18,625 sampled
frames). `typing-frames.json.gz` retains all per-frame samples and observer,
commit and storage observations from those 28 cases. Rectangle array order is documented in its metadata; each drift reports
max-minus-min per axis, not an unexpected-layout failure. Firefox's unsupported
layout-shift API must not be interpreted as zero shifts. The retained images are
16 representative baseline frames from the 168 typing screenshots; no pixel
sampling or image comparison was used as a pass/fail gate.

`glass-aba-summary.json` contains a separate same-page baseline → filter disabled
→ baseline restored idle comparison. This identifies rendering-cost observations,
not a reproduced flicker or a proposed production appearance change.

| Screen | Firefox short / multiline | Chromium short / multiline |
| --- | --- | --- |
| Light conversation | [short](firefox-light-conversation-baseline-short.png) / [multiline](firefox-light-conversation-baseline-multiline.png) | [short](chromium-light-conversation-baseline-short.png) / [multiline](chromium-light-conversation-baseline-multiline.png) |
| Dark conversation | [short](firefox-dark-conversation-baseline-short.png) / [multiline](firefox-dark-conversation-baseline-multiline.png) | [short](chromium-dark-conversation-baseline-short.png) / [multiline](chromium-dark-conversation-baseline-multiline.png) |
| Light new-chat | [short](firefox-light-newchat-baseline-short.png) / [multiline](firefox-light-newchat-baseline-multiline.png) | [short](chromium-light-newchat-baseline-short.png) / [multiline](chromium-light-newchat-baseline-multiline.png) |
| Dark new-chat | [short](firefox-dark-newchat-baseline-short.png) / [multiline](firefox-dark-newchat-baseline-multiline.png) | [short](chromium-dark-newchat-baseline-short.png) / [multiline](chromium-dark-newchat-baseline-multiline.png) |
