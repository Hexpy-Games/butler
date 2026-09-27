# Banned phrases

The lint's phrase list lives in one data file:
[`packages/butler-site/scripts/prose-lint-phrases.json`](../../../scripts/prose-lint-phrases.json).
This table mirrors it for humans. `scripts/lint-prose.test.ts` fails when an id
is added to one and not the other, and when an entry's `example` stops
triggering its own id. To change the list, edit the JSON and this table in the
same change.

The lint reads prose only: frontmatter, code, JSX props, URLs, bold UI labels
and quoted UI strings are skipped. A phrase inside a bold label is the app's
wording and stays.

| id | Phrase (pattern) | Before | After |
| --- | --- | --- | --- |
| `various` | 다양한 / 다양하게 | 다양한 모델을 지원합니다. | OpenAI, Anthropic, Google 모델을 지원합니다. |
| `through` | ~를 통해 / ~을 통해 | 설정을 통해 바꿉니다. | 설정에서 바꿉니다. |
| `effectively` | 효과적으로 / 효과적인 | 검색어로 효과적으로 찾습니다. | 검색어로 찾습니다. |
| `in-regard-to` | ~에 있어서 | 설정에 있어서 순서를 지킵니다. | 설정할 때 순서를 지킵니다. |
| `smooth` | 원활한 / 원활하게 | 원활한 연결을 제공합니다. | 연결이 끊기면 자동으로 다시 연결합니다. |
| `easily` | 손쉽게 / 손쉬운 | 손쉽게 모델을 바꿉니다. | 모델을 바꿉니다. |
| `powerful` | 강력한 / 강력하게 | 강력한 검색을 제공합니다. | 대화, 프로젝트, 설정을 이름으로 찾습니다. |
| `conveniently` | 간편하게 / 간편한 | 간편하게 스킬을 추가합니다. | 스킬을 추가합니다. |
| `as-follows` | 다음과 같습니다 / 아래와 같습니다 | 자주 보는 오류는 다음과 같습니다. | 자주 보는 오류와 해결 방법입니다. |
| `geot-ending` | ~한 것입니다 | 상태가 `failed`인 첫 항목에서 준비가 멈춘 것입니다. | 상태가 `failed`인 첫 항목이 준비가 멈춘 지점입니다. |
| `gyeongu-ending` | ~한 경우입니다 | Agent 버전을 읽지 못한 경우입니다. | Agent 버전을 읽지 못했다는 뜻입니다. |
| `double-passive` | 되어지다 / 되어져 | 값이 저장되어집니다. | 값이 저장됩니다. |
| `double-passive-eojida` | 보여지다, 쓰여지다, 열려지다 … | 목록이 화면에 보여집니다. | 목록이 화면에 보입니다. |
| `stiff-verb` | 대치하다 | 기존 앱을 대치합니다. | 기존 앱을 바꿉니다. |
| `automation` | 자동화 | 자동화 목록을 엽니다. | 예약 작업 목록을 엽니다. |
| `meta-intro` | 정리했습니다, 알아보겠습니다, 살펴보겠습니다, 소개합니다 | 자주 만나는 문제를 정리했습니다. | (delete; start with the task) |
| `geot-opinion` | ~하는 것이 좋습니다 / 것을 권장합니다 | 다른 모델을 두는 것이 좋습니다. | 장애에 대비하려면 다른 제공자의 모델을 둡니다. |
| `intensifier` | 매우, 정말, 굉장히 | 검색이 매우 빠릅니다. | (delete, or give the number) |
| `summary-closer` | 결론적으로, 요약하면, 종합하면 | 결론적으로 설정을 바꿉니다. | (delete; manuals end on the last step) |
| `chatbot-residue` | 도움이 되었기를, 궁금한 점이 있으면, 언제든 문의 | 궁금한 점이 있으면 알려 주세요. | (delete) |

Not in the lint on purpose (too many legitimate uses; handle in review, see
`korean-ai-tells.md`): ~에 대해, ~에 의해, ~할 수 있습니다, 해당, 진행하다,
~하기 위한, 다음과 같이.
