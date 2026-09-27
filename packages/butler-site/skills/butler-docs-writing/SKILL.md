---
name: butler-docs-writing
description: Write, edit or review the Korean Butler user manual (packages/butler-site/src/content/docs/ko). Keeps manual conventions and strips Korean AI-writing tells. Use for any change to docs prose, including new pages.
---

# Butler Docs Writing Skill

Use this skill for every change to the Korean manual under
`packages/butler-site/src/content/docs/ko/`, for humans and agents alike. It
is a manual style guide, not a generic humanizer: where generic "humanize
Korean" advice conflicts with the rules below, the rules below win.

The mechanical subset is enforced by `scripts/lint-prose.ts`, which runs in
`bun run site:check`. The rest is on you and on review.

## Hard rules (docs-specific; these override everything else)

1. **Bold UI labels are exact and required.** Every button, menu, tab,
   field, section and message the reader sees on screen is bold and matches
   `packages/butler-i18n/src/locales/ko.ts` character for character,
   including a message's final period. Grep before you write. Never
   paraphrase inside bold, never bold anything that is not on screen, never
   bold for emphasis. macOS UI follows macOS Korean wording. A bold message
   ending in `.` or `?` takes a space and a noun after it
   (`**…못했습니다.** 메시지가`), or Markdown leaves the asterisks visible.
2. **Never alter code, paths, commands, keys, env vars, component tags or
   props, link targets, frontmatter keys, or headings** (headings are link
   anchors, e.g. `#설치-점검-doctor`).
3. **합니다체, everywhere in body text.** Uniform endings are correct in a
   manual. Headings may be noun phrases or FAQ questions. List items and
   table cells may be noun phrases. The only exception is a verbatim quote
   of app text, marked with a lint disable and a reason.
4. **One list style per list.** Either every item is a `~합니다.` sentence or
   every item is a noun phrase with no final period. Keep definition lists on
   a page in one style. Steps are always sentences.
5. **Keep our conventions**: `- **Label** — definition.` (one em dash, term
   first), `<Steps>` with plain `1.` (never ①), `<Notice>` for caveats,
   `## 주의 사항` then `## 관련 문서` last, arrow paths
   (`**설정 → 모델**`). See `references/structures.md`.
6. **No opinions, no new facts, no removed facts.** Keep every step, number,
   limit, default, label and link. Do not add "빠르게", "안전하게",
   "편리하게".
7. **Terse and task-first.** Condition, then action: `~하면 ~합니다`,
   `~하려면 ~합니다`. Start with what the reader does, not what the page is.
8. **Terms**: 예약 작업 (never 자동화). Butler in prose; 버틀러 only where a
   bold label says so.

## Core rules (prose)

1. **Cut meta.** No page announcements (`~을 정리했습니다`,
   `이 문서에서는 ~을 알아봅니다`), no summaries, no chatbot leftovers. A
   scope note that tells readers they are on the wrong page stays.
2. **End on the verb.** No `~한 것입니다`, `~한 경우입니다`,
   `~하는 것이 좋습니다`, `~는 것이 정상입니다`. Use `~했다는 뜻입니다`,
   `~하면 ~합니다`, or the verb itself.
3. **Name what follows** instead of `다음과 같습니다`:
   `자주 보는 오류와 해결 방법입니다.`, `다음 인자를 받습니다.`
4. **Plain verbs.** 대치하다 → 바꾸다, 수행하다 → 하다/실행하다,
   활용하다 → 쓰다, 기재하다 → 적다.
5. **No translationese.** `~를 통해`, `~에 있어서`, `~에 의해`,
   `가지고 있다`, double passives, `~하기 위한`, a serial `그리고` before the
   last item, needless `의` (`지금의`).
6. **Short chains.** At most two `의`/`에 있는` hops around bold labels; use
   an arrow path instead (`**설정 → 모델 → 권한**의 **접근 권한**`).
7. **No filler modifiers**: marketing adjectives (다양한, 강력한, 원활한,
   손쉽게, 간편하게, 효과적으로), intensifiers (매우, 정말), stacked
   hedges.
8. **Punctuation**: no em dash except the list separator, no emoji, no quotes
   for UI strings (bold them), no bold for emphasis.
9. **One idea per sentence.** Split a sentence with three or more `-고`/`-며`
   clauses. Move an extra sentence out of a noun-phrase list item instead of
   breaking the list's style.
10. **Edit, don't rewrite.** Fix what is wrong and leave sentences that
    already work. Small, reviewable diffs.

## Workflow

1. Read the page. Grep `ko.ts` for every label you touch.
2. Edit by the rules above; check `references/korean-ai-tells.md` for the
   pattern you are unsure about.
3. Run the lint: `bun run --cwd packages/butler-site lint:prose` (also part
   of `bun run site:check`).
4. Self-score (below). Revise until it passes.
5. `bun run site:build` to catch MDX breakage; look at the page at 375px.

## Lint

`packages/butler-site/scripts/lint-prose.ts` scans ko MDX prose and skips
frontmatter, fenced and inline code, JSX/MDX tags and props, `{…}`
expressions and URLs. Bold labels and quoted strings are opaque words.

| Rule id | Blocks |
| --- | --- |
| `sentence-ending` | body sentences not in 합니다체; paragraphs ending in a fragment; noun phrases with a final period in list items or cells |
| `banned-phrase` | phrases in `scripts/prose-lint-phrases.json` (`references/banned-phrases.md` mirrors it; a test keeps them in sync) |
| `em-dash` | `—` anywhere except one `term — definition` dash at the start of a list item |
| `emoji` | emoji in prose |
| `mixed-list` | a list mixing sentence items and noun-phrase items |
| `bold-flanking` | bold Markdown cannot close: `**…다.**가` renders literal asterisks; write `**…다.** 메시지가` |

Escape hatch, only for a justified exception such as a verbatim app quote. A
reason after `--` is required, and a directive that suppresses nothing fails:

```mdx
{/* prose-lint-disable-next-line <rule-id> -- <why this line is an exception> */}
Paragraph the directive applies to.

- List item the directive applies to. {/* prose-lint-disable-line <rule-id> -- <why> */}
```

`disable-next-line` targets the next non-blank line. Inside a list use
`disable-line`: a comment on its own line splits an MDX list. Disable one
phrase with `banned-phrase/<id>`. Current uses: one, the verbatim safety
notice in `getting-started/first-run.mdx`.

## Quick checks

- [ ] Every bold string is on screen and matches `ko.ts` exactly?
- [ ] No particle glued to a bold message that ends in punctuation (`**…다.**가`)?
- [ ] Code, paths, props, links, headings untouched?
- [ ] Every body sentence ends in `~습니다/~ㅂ니다`?
- [ ] Each list one style; noun phrases without periods?
- [ ] First sentence is about the product, not the page?
- [ ] No `것입니다`, `경우입니다`, `다음과 같습니다`, `~를 통해`?
- [ ] No em dash outside the list separator, no emoji, no emphasis bold?
- [ ] Same facts, steps, numbers and links as before the edit?
- [ ] `lint:prose` passes, and every disable has a reason?

## Self-score

Rate 1–10 each. Revise below 40/50. Accuracy below 10 blocks the change.

| Dimension | Question |
| --- | --- |
| Accuracy | Labels exact, facts and steps unchanged, nothing added? |
| Directness | Does each section start with the task or the thing? |
| Consistency | 합니다체, one list style, house conventions? |
| Density | Any sentence, modifier or signpost you could delete? |
| Naturalness | Would a Korean technical writer have written it (no translationese, no formal-noun endings)? |

## References

- `references/banned-phrases.md`: lint phrase ids with before/after.
- `references/korean-ai-tells.md`: Korean AI-tell patterns by category, with
  what applies to manuals and what does not.
- `references/structures.md`: page skeleton, list/dash/bold/table
  conventions.
- `references/examples.md`: before/after pairs from our own pages.
- `references/NOTICE`: sources and licenses.
