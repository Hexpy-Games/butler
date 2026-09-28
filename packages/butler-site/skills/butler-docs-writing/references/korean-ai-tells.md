# Korean AI tells, filtered for a manual

Patterns that make Korean prose read as machine-written, grouped the way the
Korean humanizer skills group them (see `NOTICE`). Everything here is
paraphrased and re-scoped for a user manual. The last column says how we
handle it:

- **lint**: the prose lint blocks it (id in `banned-phrases.md` or a rule id).
- **fix**: fix it when you touch the sentence; review catches it.
- **keep**: generic humanizer advice that does not apply to manuals.

## 1. 번역투 (translationese)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| English "through/via" | 설정을 통해 바꿉니다 | 설정에서 바꿉니다 | lint `through` |
| "in terms of" | 설정에 있어서 | 설정할 때 | lint `in-regard-to` |
| Double passive | 저장되어집니다, 보여집니다 | 저장됩니다, 보입니다 | lint `double-passive*` |
| Passive of an awkward verb | 목록이 다시 불러와지고 | 목록이 새로 고쳐지고 | fix |
| "about" where the verb takes an object | 설정에 대해 설명합니다 | 설정을 설명합니다 | fix |
| Agent phrase "by" | 사용자에 의해 변경된 값 | 사용자가 바꾼 값 | fix |
| "have/possess" | 두 가지 방식을 가지고 있습니다 | 방식이 두 가지입니다 | fix |
| "for the purpose of" | 스킬을 만들기 위한 새 대화 | 스킬을 만드는 새 대화 | fix |
| Serial "and" before the last item | 이름과 말투, 답변 언어, 그리고 학습 범위 | 이름과 말투, 답변 언어, 학습 범위 | fix |
| Pronoun calque | 그것은 설정을 저장합니다 | (drop the pronoun or name the thing) | fix |
| Needless "-의" (English "the ... of") | 지금의 추론 강도 | 지금 추론 강도 | fix |
| Stacked genitives around labels | **설정 → 모델**의 **권한** 항목에 있는 **접근 권한** | **설정 → 모델 → 권한**의 **접근 권한** | fix |

## 2. 기계적 구조 (mechanical structure)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| Mixed list styles | one item `이벤트 종류 — …` (noun), next item `…불러옵니다.` (sentence) | all sentences or all noun phrases | lint `mixed-list` |
| Noun phrase with a final period | `- 인증 오류, 권한 오류.` | `- 인증 오류, 권한 오류` or a table | lint `sentence-ending` |
| Em dash joining clauses | 설정을 엽니다 — 그리고 고릅니다. | two sentences | lint `em-dash` |
| Bold used for emphasis | **반드시** 입력합니다 | 필수 항목입니다 | fix (bold is for UI labels only) |
| Bolded sentence that is not on screen | **바로 다음 모델로 넘어갑니다** — … | plain text, or a table column | fix |
| Circled or decorated numerals | ①, ❶, 1) | `1.` | lint `circled-number` (style lint) |
| Colon-headed teaser headings | `## 설치: 알아야 할 모든 것` | `## 설치` | fix |
| "첫째/둘째/셋째" prose lists | 첫째, 앱을 엽니다. 둘째, … | `<Steps>` with `1.` | fix |
| Binary contrast setups | A가 아니라 B입니다 (when nobody claimed A) | state B | fix |
| Every section ends with a summary line | …이렇게 하면 설정이 끝납니다. | stop after the last step | fix |
| Uniform sentence endings | all sentences end in ~합니다 | **keep**: 합니다체 is the house style | keep |
| Uniform sentence length | many 30–50 character sentences | **keep** unless a sentence is long enough to split | keep |
| Heavy use of lists | bullets everywhere | **keep** for options, fields, errors; use prose for one-off facts | keep |

## 3. AI 상투구 (stock phrases)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| Marketing adjectives | 강력한, 원활한, 손쉽게, 간편하게, 다양한, 효과적으로 | the concrete behavior, or nothing | lint |
| Signposts | 다음과 같습니다 | name what follows | lint `as-follows` |
| Softer signpost | 다음과 같이 열립니다 | 종류에 따라 이렇게 열립니다 / restructure | fix |
| Essay closers | 결론적으로, 요약하면, 종합하면 | delete | lint `summary-closer` |
| Significance inflation | 핵심적인 역할을 합니다, 중요한 기능입니다 | say what it does | fix |
| Hype stacks | 혁신적이고 획기적인 | delete | fix |
| Stiff Sino-Korean verbs | 대치합니다, 수행합니다, 활용합니다, 기재합니다 | 바꿉니다, 합니다/실행합니다, 씁니다, 적습니다 | lint `stiff-verb` for 대치; fix others |
| Product term drift | 자동화 | 예약 작업 | lint `automation` |

## 4. 형식명사 (formal nouns)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| "~한 것입니다" ending | 준비가 멈춘 것입니다 | 준비가 멈춘 지점입니다 / 멈췄습니다 | lint `geot-ending` |
| "~한 경우입니다" ending | 버전을 읽지 못한 경우입니다 | ~했다는 뜻입니다 / ~하면 ~합니다 | lint `gyeongu-ending` |
| "~하는 것이 좋습니다/권장합니다" | 두는 것이 좋습니다 | ~하려면 ~합니다 / ~하기를 권장합니다 | lint `geot-opinion` |
| "것은 … 입니다" cleft | 삭제되는 것은 후보와 프로필입니다 | 후보와 프로필이 삭제됩니다 | fix |
| "~는 것이 정상입니다" | 멈춰 있는 것이 정상입니다 | 멈춰 있습니다. 정상 동작입니다. | fix |
| "앞의 것 / 뒤의 것" | 앞의 것은 …, 뒤의 것은 … | repeat the two labels | fix |
| "~의 문제입니다" as a section opener | ~할 때의 문제입니다 | ~할 때 ~하지 않으면 다음을 확인합니다 | fix |
| Nominal stacks | 컨텍스트 조립 결과 확인 필요 | verb phrase | fix |

## 5. 중복 수식 (redundant modification)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| Intensifiers | 매우, 정말, 굉장히 | delete or give the number | lint `intensifier` |
| Synonym pairs | 도움과 지원, 중요하고 핵심적인 | one word | fix |
| "-적" chains | 체계적 관리, 전략적 활용 | a verb | fix |
| Empty qualifiers | 사실상, 기본적으로 (when nothing is non-basic) | delete | fix |
| Needless "반드시" on a required field | 반드시 입력합니다 | 필수 항목입니다 / 입력합니다 | fix |

## 6. 헤징 (hedging)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| Stacked possibility | ~할 수도 있을 수 있습니다 | ~할 수 있습니다 | fix |
| Conjecture endings | ~로 보입니다, ~로 여겨집니다 | state it, or leave it out if unverified | fix |
| "~할 수 있습니다" for a plain result | 버튼을 누르면 창이 열릴 수 있습니다 (it always opens) | 창이 열립니다 | fix |
| Capability statements | 여러 파일을 한 번에 고를 수 있습니다 | **keep**: a real capability | keep |
| Real uncertainty | 실행이 조금 늦어질 수 있습니다 | **keep**: the product behaves that way | keep |

## 7. 접속사 남용 (conjunction overuse)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| Sentence-initial connectors | 또한, 따라서, 즉, 그러므로 | drop; order the sentences instead | fix |
| Comma after a connector | 그리고, 하지만, | drop the comma or the connector | fix |
| Meta connectors | 이는 ~을 의미합니다, 이 점에서 | say the thing | fix |
| Long -고/-며 chains | ~하고, ~하며, ~한 뒤, ~합니다 (4+ clauses) | split at the second clause | fix |

## 8. 메타 도입과 챗봇 잔재 (meta intros, chatbot leftovers)

| Pattern | Looks like | Write instead | Handling |
| --- | --- | --- | --- |
| Page announces itself | 자주 만나는 문제를 정리했습니다. | delete; start with the first check | lint `meta-intro` |
| "이 문서는/이 절에서는 ~을 다룹니다" | 이 문서는 섹션을 순서대로 정리하고 … | keep only the fact (섹션은 앱에 표시되는 순서를 따릅니다) | fix |
| Scope notes that disambiguate | 이 문서는 Butler가 다른 서버에 접속하는 경우를 다룹니다. | **keep**: tells the reader they may be on the wrong page | keep |
| Heading repeated as the first sentence | `## 알림` → 알림에 대해 설명합니다. | start with the content | fix |
| Chatbot residue | 도움이 되었기를 바랍니다, 궁금한 점이 있으면 | delete | lint `chatbot-residue` |
| Talking about the edit | 이전 버전과 달리, 새로 추가된 | describe the product as it is | fix |
| Emoji | ✅, 🚀, ⚠️ | words; `<Notice tone="warning">` for warnings | lint `emoji` |

## Generic humanizer advice that does not apply here

- **Vary sentence endings.** No. Body text is 합니다체 throughout. Mixing in
  해요체 (`~해요`, `~하세요`) or 해라체 (`~한다`) is the error.
- **Add voice, opinions, or personality.** No. The manual states behavior.
- **Replace lists with prose.** No. Options, fields, error codes and steps are
  lists or tables. Keep one style per list.
- **Avoid passive voice.** Partly. UI state is naturally passive
  (`표시됩니다`, `저장됩니다`). Only double passives are wrong.
- **Avoid three-item lists.** No. If the UI has three options, list three.
- **Drop subjects.** Already normal in Korean; keep the subject when it
  changes (Butler vs. the reader vs. the app).
