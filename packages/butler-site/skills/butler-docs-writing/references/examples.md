# Before and after, from our own pages

Real edits from the first polish pass. Facts, labels, links and code are
unchanged in every pair.

## Meta intro (troubleshooting.mdx)

Before:

> Butler를 쓰다 자주 만나는 문제와 확인 방법을 정리했습니다. 어느 단계에서 문제가 생겼는지 먼저 확인하고, 해결되지 않으면 진단 정보를 모아 보고합니다.

After:

> 어느 단계에서 문제가 생겼는지 먼저 확인하고, 해결되지 않으면 진단 정보를 모아 보고합니다.

The first sentence only announced the page.

## "~한 경우입니다" as a section opener (troubleshooting.mdx)

Before:

> [첫 실행](/help/getting-started/first-run/#설치)의 **설치** 단계에서 "Butler Agent를 준비하지 못했습니다."가 표시되는 경우입니다.

After:

> [첫 실행](/help/getting-started/first-run/#설치)의 **설치** 단계에서 **Butler Agent를 준비하지 못했습니다.** 메시지가 표시되면 다음 순서로 시도합니다.

Condition + action, and the on-screen message is bold, exact (`ko.ts`
`installFailed`), with its period. The space and `메시지가` after the closing
`**` matter: see "Bold that never closes" below.

## "~한 경우입니다" as an explanation (troubleshooting.mdx)

Before: `…이면 앱 패키지에서 Agent 버전을 읽지 못한 경우입니다.`

After: `…이면 앱 패키지에서 Agent 버전을 읽지 못했다는 뜻입니다.`

## "~한 것입니다" (troubleshooting.mdx, agent-cli.mdx)

Before: `상태가 \`failed\`인 첫 항목에서 준비가 멈춘 것입니다.`

After: `상태가 \`failed\`인 첫 항목이 준비가 멈춘 지점입니다.`

Before: `…명령이 오류 없이 끝나면 설치가 완료된 것입니다.`

After: `…명령이 오류 없이 끝나면 설치가 완료됩니다.`

## "다음과 같습니다" (troubleshooting.mdx, mcp-server.mdx)

Before: `자주 보는 오류는 다음과 같습니다.`

After: `자주 보는 오류와 해결 방법입니다.`

Before: `` `memory_graph`의 인자는 다음과 같습니다. ``

After: `` `memory_graph`는 다음 인자를 받습니다. ``

## Mixed list styles (settings.mdx)

Before (two noun-phrase items, one sentence item):

```mdx
- 이벤트 종류 — **대화 기억 정리**, **사용자 정보 분석**, **대화 기록 반영**, **컨텍스트 정리**, **정기 기억 정리**
- 상태 — **성공**, **완료**, **실패**, **실행 중**, **아직 실행 전**, **상태 확인 필요**
- **새로고침**으로 다시 불러오고, **더보기**로 20개씩 더 불러옵니다.
```

After (all sentences):

```mdx
- 이벤트 종류는 **대화 기억 정리**, **사용자 정보 분석**, **대화 기록 반영**, **컨텍스트 정리**, **정기 기억 정리**입니다.
- 상태는 **성공**, **완료**, **실패**, **실행 중**, **아직 실행 전**, **상태 확인 필요** 중 하나로 표시됩니다.
- **새로고침**으로 다시 불러오고, **더보기**로 20개씩 더 불러옵니다.
```

## One item breaks a noun list (models/cloud.mdx)

Before:

```mdx
- API 키: `~/.butler/auth/model-provider-credentials.json`
- OpenAI OAuth 로그인 정보: `~/.butler/auth/openai-codex.json`. 만료가 가까워지면 Butler가 자동으로 갱신합니다.
- 등록한 모델 목록: `~/.butler/butler.config.json`
```

After: the three paths stay a noun list; the sentence moves below it.

```mdx
- API 키: `~/.butler/auth/model-provider-credentials.json`
- OpenAI OAuth 로그인 정보: `~/.butler/auth/openai-codex.json`
- 등록한 모델 목록: `~/.butler/butler.config.json`

OpenAI OAuth 로그인 정보는 만료가 가까워지면 Butler가 자동으로 갱신합니다.
```

## Bold sentences as list terms (models/backup.mdx)

Before: `- **바로 다음 모델로 넘어갑니다** — 제공자 사용 한도 소진, …, 지원하지 않는 모델.`
(bold that is not a UI label; noun list ending in a period; the second item
mixed a noun list and a sentence).

After: a two-column table, `오류 | 처리`, with noun-phrase error cells and
sentence behavior cells.

## Long 의-chain around bold labels (basics/conversation.mdx)

Before: `이 기본값은 **설정 → 모델**의 **권한** 항목에 있는 **접근 권한**에서 바꿉니다.`

After: `이 기본값은 **설정 → 모델 → 권한**의 **접근 권한**에서 바꿉니다.`

## Stiff verb (troubleshooting.mdx)

Before: `DMG를 열고 \`Butler.app\`을 응용 프로그램 폴더로 끌어다 놓아 기존 앱을 대치합니다.`

After: `DMG를 열고 \`Butler.app\`을 응용 프로그램 폴더로 끌어다 놓아 기존 앱을 바꿉니다.`

## Quoted UI strings become exact bold (troubleshooting.mdx)

Before: `대화에 "응답 처리 중 문제가 발생했습니다."가 표시되면 아래 버튼으로 다시 시도합니다.`

After: `대화에 **응답 처리 중 문제가 발생했습니다.** 메시지가 표시되면 아래 버튼으로 다시 시도합니다.`

When the doc quoted only half a message, quote all of it and drop the
paraphrase that repeated the other half:

Before: `"실시간 연결이 끊겨 다시 연결하고 있습니다."가 표시되면 Butler가 자동으로 다시 연결합니다. 이 동안 화면의 작업 상태는 최신이 아닐 수 있습니다.`

After: `**실시간 연결이 끊겨 다시 연결하고 있습니다. 표시된 작업 상태는 최신이 아닐 수 있습니다.** 안내가 표시되면 Butler가 자동으로 다시 연결합니다.`

## Bold that never closes (first-run.mdx, conversation.mdx, command-palette.mdx)

Markdown does not close `**` when the label ends in punctuation and a letter
follows at once, so these rendered with literal asterisks:

Before: `**Butler Agent를 준비하지 못했습니다.**라는 메시지와 함께`

After: `**Butler Agent를 준비하지 못했습니다.** 메시지와 함께`

Before: `상태가 **허용 여부를 기다리고 있습니다.**로 바뀌고,`

After: `상태에 **허용 여부를 기다리고 있습니다.** 문구가 표시되고,`

The lint rule `bold-flanking` catches this.

## Formal-noun cleft and "앞의 것 / 뒤의 것"

Before (personalization.mdx): `- 삭제되는 것은 분석으로 모은 후보, 저장된 프로필, 답변에 쓰던 요약입니다.`

After: `- 분석으로 모은 후보, 저장된 프로필, 답변에 쓰던 요약이 삭제됩니다.`

Before (basics/conversation.mdx): `앞의 것은 처음 보낸 설정 그대로, 뒤의 것은 지금 이 대화에 선택된 모델과 권한 설정으로 다시 요청합니다.`

After: `**원래 설정으로 다시 시도**는 처음 보낸 설정 그대로, **현재 설정으로 새로 시도**는 지금 이 대화에 선택된 모델과 권한 설정으로 다시 요청합니다.`

## Opinion phrasing (models/backup.mdx)

Before: `사용 한도 소진이나 제공자 장애에 대비하려면 다른 제공자의 모델을 예비 모델로 두는 것이 좋습니다.`

After: `사용 한도 소진이나 제공자 장애에 대비하려면 다른 제공자의 모델을 예비 모델로 둡니다.`

## Translationese

Before (personalization.mdx): `Butler의 이름과 말투, 답변 언어, 그리고 대화에서 사용자에 대해 학습할 범위를 정하는 설정입니다.`

After: `Butler의 이름과 말투, 답변 언어, 대화에서 사용자에 대해 학습할 범위를 정하는 설정입니다.`

Before (extensions/skills.mdx): `설정이 닫히고 스킬을 만들기 위한 새 대화가 열립니다.`

After: `설정이 닫히고 스킬을 만드는 새 대화가 열립니다.`

## A justified exception

An earlier `getting-started/first-run.mdx` listed the onboarding safety notice
exactly as the app showed it, and one app sentence ended in `~하세요.`.
Rewriting it would have misquoted the app, so the line carried a disable with a
reason:

```mdx
- 민감한 경로나 토큰이 포함된 요청은 실행 전에 한 번 더 확인하세요. {/* prose-lint-disable-line sentence-ending -- quotes the onboarding safety notice (ko.ts safetyItems) verbatim */}
```
