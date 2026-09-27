# Page structure and house conventions

These conventions are already in every page. Keep them; do not "humanize" them
away.

## Page skeleton

1. Frontmatter: `title`, `description`, `section`, `order`, `status`. Keep
   keys, values' meaning and any YAML comment (the skills page keeps its
   comment above `status: planned`).
2. One or two lead sentences: what the feature is, where it lives. No meta
   intro.
3. Task sections (`##`), each opening with the task (`## 모델 등록하기`) or
   the thing (`## 간격`).
4. `## 주의 사항` with `<Notice>` blocks, then `## 관련 문서` with
   `<CardGrid>`/`<DocCard>`. Always last, in that order.

Headings are anchors. Other pages link to them (`#설치-점검-doctor`,
`#기본-모델-고르기`), so never reword a heading.

## Lists

| Kind | Form | Example |
| --- | --- | --- |
| Definition (UI element, option, field) | `- **Label** — definition.` One em dash, term first. | `- **거절** — 요청을 실행하지 않습니다.` |
| Definition of code or keys | `` - `name` — 스킬 이름입니다. `` or `` - `butler-agent`: 실행 파일입니다. `` (keep the page's existing separator) | |
| Enumeration of values, files, requirements | noun phrases, no final period | `- macOS 12 이상` |
| Path list | `label: path`, noun phrases | `` - API 키: `~/.butler/auth/…` `` |
| Steps | `<Steps>` with `1.`, one action per step, sentences | `1. **저장**을 누릅니다.` |

Rules:

- One style per list: every item a `~합니다.` sentence, or every item a noun
  phrase without a period. The lint (`mixed-list`) enforces this.
- A label-only parent (`- **브랜치 상세**`) with a nested list is fine.
- If one item needs an extra sentence, move the sentence after the list
  rather than breaking the list's style.
- When the "term" would be a sentence (`**바로 다음 모델로 넘어갑니다** — …`),
  the content is a condition-to-behavior map: use a table.
- Numbering is always plain `1.`. No circled numerals (①), no `1)`.

## Em dash

The only allowed em dash is the list separator above: `- term — definition`,
once per item, with spaces. Never join clauses with it, never use it in
paragraphs, headings or table cells. Split the sentence or use a comma.

## Bold, quotes, code

- **Bold** = text on screen, exact. App strings come from
  `packages/butler-i18n/src/locales/ko.ts` (grep before writing). macOS
  strings follow macOS Korean UI (`**시스템 설정 → 개인정보 보호 및 보안**`).
  Messages are quoted with their final period, then a space and a noun:
  `**Butler Agent를 준비하지 못했습니다.** 메시지가 표시되면`. Never attach a
  particle to a closing `**` that follows punctuation (`**…다.**가`):
  Markdown will not close the bold and the page shows literal asterisks.
- Never bold for emphasis. Never paraphrase inside bold. If a message is long,
  quote all of it or describe it without bold.
- Straight quotes (`"…"`) are not a UI-label style. Use bold.
- `code` = anything typed or read literally: commands, paths, keys, env vars,
  error codes, JSON, English CLI output.
- Navigation paths use arrows inside one bold span: `**설정 → 모델**`,
  `**설정 → 일반 → 알림 권한**`. Prefer an arrow path to a chain of
  `의`/`에 있는`.

## Tables

Use for option/value/description grids and condition-to-behavior maps. Cells
are noun phrases or `~합니다.` sentences; a noun-phrase cell has no final
period.

## Components

`<Steps>`, `<Notice tone="info|warning" title="…">`, `<Tabs>`/`<TabPanel>`,
`<Kbd keys={[…]} label="…" />`, `<span data-mod-key>`, `<CardGrid>`,
`<DocCard>`. Never change tags or props. `title` props on `<Notice>` are
headings, not sentences.

## Sentences

- Condition first, action last: `~하면 ~합니다`, `~하려면 ~합니다`.
- One action per sentence in steps; at most two clauses elsewhere.
- Name the actor when it changes: the reader (implicit), Butler, the app,
  macOS.
- Say where before what: `**설정 → 모델**에서 **예비 모델 사용**을 켭니다.`
