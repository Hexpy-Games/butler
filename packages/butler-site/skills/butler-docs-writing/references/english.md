# English manual: translation guide

For every page under `packages/butler-site/src/content/docs/en/`. Each
English page is a translation of the Korean page with the same slug
(`ko/<slug>.mdx` → `en/<slug>.mdx`). The Korean page is the source of truth
for facts and structure; `packages/butler-i18n/src/locales/en.ts` is the
source of truth for every word the app shows.

Reference translation: `en/getting-started/install.mdx` against
`ko/getting-started/install.mdx`. Read the two side by side before you start.

## Hard rules

1. **Bold UI labels are exact.** Every button, menu, tab, field, section and
   message the reader sees on screen is bold, as on the Korean page, and
   matches `en.ts` character for character, including capitalization and a
   message's final period. Never translate a Korean label yourself. Find the
   Korean string's key in `ko.ts` and take the same key from `en.ts`, or run
   `bun run --cwd packages/butler-site labels <Korean label>`.
   `english-ui-labels.md` lists every bold label in the Korean pages with its
   English string. macOS labels follow Apple's English wording
   (**System Settings → Privacy & Security**, **Open Anyway**).
2. **Same structure as the Korean page.** Same sections in the same order,
   same heading levels, same components (`<Steps>`, `<Notice>`, `<Tabs>`,
   `<TabPanel>`, `<CardGrid>`, `<DocCard>`, `<Kbd>`) with the same props,
   same lists and tables, same number of code blocks, same links. Do not
   merge, split, add or drop sections. Component prop text that the reader
   sees (`title`, `label`, `description`) is translated; `value`, `tone`,
   `slug`, `keys` and `href` are not.
3. **Links point to English slugs.** `/help/<slug>/` becomes
   `/en/help/<slug>/`. A `#anchor` is the English heading's id on the target
   page: lowercase, punctuation dropped, spaces to hyphens
   (`## First-run setup` → `#first-run-setup`). `<DocCard slug="…">` keeps the
   slug; the card resolves in the page's language. External URLs stay as they
   are.
4. **Code, paths, commands, keys and env vars are unchanged.** Translate only
   the comments inside a code block.
5. **Same facts.** Keep every step, number, limit, default, version and
   caveat. Add nothing. If the Korean page looks wrong against the app or the
   code, fix the Korean page in the same change and say so; do not let the two
   languages disagree.
6. **Never "Steward", never "automation".** The product is Butler. The
   feature is **Schedules**; one of them is a schedule. This holds for every
   form: automation, automations, automated task.
7. **Frontmatter**: translate `title` and `description`; copy `section` and
   `order`; set `status: published` when the page is done. A page whose Korean
   source is `planned` stays `planned`.

## Voice

- **Second person, present tense.** "You can change it later in
  **Settings → Personalization**." Butler is "Butler", never "we" or "I".
- **Steps are imperative**, one action each: "Open the DMG and drag
  `Butler.app` into the Applications folder." Not "You should open…", not
  "The DMG is opened…".
- **Condition first, then action.** "If the app does not open, choose
  **Open Anyway**." This is the Korean `~하면 ~합니다`.
- **Plain words.** use (not utilize or leverage), to (not in order to), let
  (not enable or allow you to), start (not initiate), need (not require), so
  (not therefore), about (not regarding).
- **No hype, no opinions.** No "powerful", "seamless", "robust", "easy",
  "simply". Do not tell the reader something is quick, safe or convenient
  unless the Korean page states it as a fact.
- **No "not X but Y".** Say Y. "A project is a folder with a dashboard", not
  "A project is not just a folder but a dashboard".
- **No meta.** Do not announce the page ("This page explains…", "In this
  guide…", "Let's…"), do not summarize it at the end, and do not address the
  reader with "please" or "feel free".
- **Translate meaning, not words.** Korean sentence endings (`~합니다`,
  `~할 수 있습니다`) do not need a matching English verb each time. Drop
  "can" when the sentence is an instruction: `설정에서 바꿀 수 있습니다` →
  "Change it in Settings." Split a Korean sentence that carries two actions.
- **Sentence case** for headings and for prose. Capitals only for proper
  names, UI labels as `en.ts` writes them, and the product words below.
- **Punctuation.** No emoji. No exclamation marks. The em dash appears only
  as the list separator the Korean pages use: `- **Label** — definition.`
  Everywhere else use a period or a comma. Use straight quotes, and bold (not
  quotes) for UI text. No serial comma is required; follow `en.ts` inside
  labels.

## Words the manual uses

Prose terms. When the word is a label on screen, the bold form in
`english-ui-labels.md` wins, even where `en.ts` is not consistent with the
prose term (for example, the sidebar button is **New chat** while prose says
"conversation").

| Korean | English | Note |
| --- | --- | --- |
| 버틀러, Butler | Butler | Never "the Butler", never "Steward" |
| 앱 | the app | Lowercase. "Butler app" where the Korean says Butler 앱 |
| Agent, Butler Agent | the Agent, Butler Agent | Capitalized, as the Korean pages write it |
| Worker | Worker | Capitalized. Tab label: **Workers** |
| 대화 | conversation | Labels vary: **New chat**, **Chats** (sidebar), **New conversation** (space), **Target chat**. Use the exact label in bold and "conversation" in prose |
| 컴포저 | composer | The message box. Label: **Message composer** |
| 사이드바 | sidebar | **Sidebar**, **Show sidebar**, **Hide sidebar** |
| 스페이스 | space | Label: **Space**. Lowercase in prose |
| 즐겨찾기 | favorites | **Favorites**; **Pin** (즐겨찾기에 추가), **Unpin** (즐겨찾기 해제) |
| 아카이브 | archive | **Archive** in a space, **Archives** in Settings, **Archive** (보관하기), **Unarchive** (아카이브 취소) |
| 프로젝트 | project | **Projects**, **New project**, **Project dashboard**, **Project chats** |
| 예약 작업 | schedule, schedules | **Schedules** (section, tab), **Schedule** (palette kind), **New schedule**, **Runs** (실행 기록), **Run now**. Never "automation" or "scheduled task" |
| 명령 팔레트 | command palette | Label: **Command palette** |
| 오른쪽 패널 | right panel | **Show right panel**, **Hide right panel**. Tabs: **Summary**, **Activity**, **Context**, **Artifacts**, **Schedules**, **Workers** |
| 아티팩트 | artifact | **Artifacts** |
| 권한 | permission | **Permission** (composer), **Permissions** (Settings), **Access** (접근 권한) |
| 먼저 확인 | **Ask first** | Permission mode |
| 읽기 전용 | **Read only** | Permission mode. No hyphen |
| 전체 권한 | **Full access** | Permission mode |
| 모델 | model | **Model**, **Models** |
| 기본 모델 | default model | |
| 클라우드 모델 | cloud model | Page title: Cloud models |
| Custom 모델 | Custom model | **Custom**, capitalized |
| 예비 모델 | backup model | **Backup models**, **Use backup models**, **Add backup model**. Not "fallback" or "secondary" |
| 이 컴퓨터의 모델 | **Models on this computer** | |
| 추론 | reasoning | **Reasoning**, **Reasoning effort** |
| 컨텍스트 | context | **Context**, **Context window** |
| 맥락 | context | Right panel tab: **Context** |
| 계획 모드 | plan mode | **Use plan mode by default** |
| 작업 위치, 작업공간 | workspace | **Workspace**; **Worktree**, **Local** |
| 스킬 | skill | **Skills** |
| MCP 서버 | MCP server | **MCP servers**, **Add MCP server** |
| 개인화 | personalization | **Personalization**; **Profile**, **Response style**, **Persona**, **Learning** |
| 인터페이스 언어 | interface language | **Interface language** |
| 답변 언어 | response language | **Response language** |
| 첫 실행 | first run | "first-run setup" as a modifier |
| 원격 접근, 원격 접속 | remote access | **Remote access** |
| 다른 컴퓨터에서 접속 허용 | **Allow access from other computers** | |
| 연결 코드 | connection code | As in **Settings → Security** ("…enter the connection code to connect."). Not "pairing code" |
| 기기 연결 | **Pair device** | **Paired devices** (연결된 기기), **Disconnect** (연결 끊기) |
| 접속 주소 | **Addresses** | **Copy address** |
| 허용 호스트 | allowed hosts | **Allowed hosts**, **Host names** |
| 데이터 폴더 | data folder | `~/.butler` |
| 백그라운드 서비스 | background service | |
| 개발자 모드 | developer mode | **Developer mode** |
| 진단 | diagnostics | **Diagnostics** |
| 기억 정리 | memory cleanup | **Memory cleanup**; system events say **Conversation memory consolidation** |
| 설정 | Settings | Capitalized when it names the screen: "Open **Settings → Models**" |
| 설정 섹션 | | **General**, **Models**, **Appearance**, **Server**, **Updates**, **MCP**, **Skills**, **Usage**, **Logs**, **Personalization**, **Privacy**, **Security**, **System events**, **Archives**, **About** |
| 프리뷰 | preview | "preview build", "preview release"; **Receive preview versions** |
| 관련 문서 | Related pages | Last heading of a page |
| 주의 사항 | Notes | Heading before Related pages |
| 응용 프로그램 폴더 | the Applications folder | macOS |

`english-ui-labels.md` has the full list. Where one Korean word maps to
several English labels (대화, 완료, 진행 중, 확인), it lists each with its
`en.ts` key so you can pick the one for the control in question.

If `en.ts` itself looks wrong or inconsistent, write what the app shows and
report it. Do not "fix" a label in the manual.

## Sentence patterns

| Korean | English |
| --- | --- |
| `**저장**을 누릅니다.` | Click **Save**. |
| `**설정 → 모델**을 엽니다.` | Open **Settings → Models**. |
| `~하려면 ~합니다.` | To …, … (imperative). |
| `~하면 ~합니다.` | If …, … / When …, … |
| `~할 수 있습니다.` | You can … Or the imperative when it is a step. |
| `**…못했습니다.** 메시지가 표시되면` | If **Couldn't …** appears, … (message in bold with its final period, as in `en.ts`) |
| `- **Label** — 설명입니다.` | `- **Label** — Sentence.` Keep the list's style: all sentences or all noun phrases |
| `자세한 내용은 [X](…)를 참고합니다.` | See [X](…). |

Use "click" for buttons and links, "choose" for menu items and options,
"select" for checkboxes and list rows, "turn on" / "turn off" for switches,
"enter" for text, "press" for keys.

## Lint

`scripts/lint-prose-en.ts` runs on `en/**.mdx` as part of
`bun run site:check` (`bun run --cwd packages/butler-site lint:prose` on its
own). It skips frontmatter, code, JSX tags and props, and URLs. The Korean
lint does not run on English pages.

- `banned-phrase`: the phrases below, from
  `scripts/prose-lint-phrases-en.json`. Bold labels and quoted UI strings are
  exempt, because labels are exact.
- `product-term`: "automation(s)" and "Steward", in bold and quotes too.
  Cannot be disabled.
- `emoji`: no emoji in prose.

| Phrase id | Blocks | Write instead |
| --- | --- | --- |
| `seamless` | seamless, seamlessly | what happens |
| `robust` | robust | the concrete behavior |
| `powerful` | powerful | the concrete capability |
| `leverage` | leverage | use |
| `utilize` | utilize | use |
| `in-order-to` | in order to | to |
| `worth-noting` | it's worth noting, important to note, please note | the fact itself, or a `<Notice>` |
| `easily` | easily, effortlessly, simply | nothing |
| `intensifier` | very, really, extremely, incredibly | nothing, or the number |
| `various` | various, a variety of, a wide range of | the actual items |
| `hype` | cutting-edge, state-of-the-art, game-changing, revolutionary, comprehensive, streamline, supercharge | the concrete behavior |
| `delve` | delve, deep dive, dive into | the task |
| `not-only-but` | not just/only X but Y, isn't just | Y |
| `meta-intro` | let's, we'll look at, in this guide | the task |
| `summary-closer` | in conclusion, in summary, to summarize | nothing |
| `chatbot-residue` | hope this helps, feel free to, let me know | nothing |

Escape hatch for a verbatim quote, with a reason, as in the Korean lint:

```mdx
{/* prose-lint-disable-next-line banned-phrase/various -- quotes the CLI help text */}
```

## Tests

`src/site/links.test.ts` runs in `bun run site:check`:

- Internal links in English pages are `/en/help/<slug>/` and must resolve,
  anchors included. While English is in progress, a link to a page that is
  published in Korean but not yet in English is allowed.
- Every English page has a Korean page with the same slug, `section` and
  `order`.
- **Translation report.** For each published Korean page it lists the English
  page as missing or planned, or lists where its heading outline, component
  counts, code blocks, internal links or external URLs differ from the Korean
  page. It prints as a to-do list until `"en"` is added to `COMPLETE_LOCALES`
  in `src/site/sections.ts`; from then on any line fails the check. A page is
  done when it has no line in the report.

## Workflow

1. Open `ko/<slug>.mdx` and `en/<slug>.mdx` (a stub with frontmatter).
2. Translate section by section, keeping every tag, prop, list and code
   block in place. Look up each bold label; do not guess.
3. Rewrite links to `/en/help/…` and fix anchors to the English headings of
   the target page. If the target is not translated yet, agree its heading
   text with whoever translates it, or link the page without an anchor and
   add the anchor later.
4. Set `status: published`.
5. Run `bun run site:check`. The page must have no line in the translation
   report, and `bun run --cwd packages/butler-site labels` must list no bold
   label of yours except OS or third-party labels.
6. Run `bun run site:build` and read the page at `/en/help/<slug>/`, at
   desktop width and at 375 px.

## Quick checks

- [ ] Every bold string is on screen in the English app and matches `en.ts`?
- [ ] Same headings, components, lists, tables and code blocks as the Korean page?
- [ ] Links go to `/en/help/…`, anchors match English headings?
- [ ] Code, paths, commands and keys untouched?
- [ ] Same facts, steps, numbers and caveats?
- [ ] Steps imperative, one action each?
- [ ] No hype, no "not X but Y", no meta intro, no emoji?
- [ ] No "automation", no "Steward"?
