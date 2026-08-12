# Butler agent benchmark pilot

This report is generated from the persisted benchmark observations. It does not contain prompts, transcripts, credentials, tool payloads, hidden reasoning, or private absolute paths.

- Schema: `butler.agent-benchmark.v1`
- Run: `sol-medium-compact-20260809`
- Baseline: `549463fbe074fc25042f9302cd330699948dab50`
- Seed: `20260809`
- Observations: 12
- Accepted: 0
- Ranking: withheld (all 12 historical observations are rejected and unranked)

## Track configurations

- Controlled: butler: model=openai/gpt-5.6-sol, reasoning=medium, provider=product-resolved, permissions=benchmark-workspace-full-source-read-only, tools=product-default; hermes: model=openai/gpt-5.6-sol, reasoning=medium, provider=openai-codex, permissions=benchmark-workspace-full-source-read-only, tools=filesystem,web; opencode: model=openai/gpt-5.6-sol, reasoning=medium, provider=product-resolved, permissions=benchmark-workspace-full-source-read-only, tools=filesystem,web
- Recommended-default: butler: not present; hermes: not present; opencode: not present

## Gates

No adapter gates were recorded.

## Per-arm metrics

| Agent | Track | Scenario | Cache | State | Gate | Input | Cache read | Cache write | Output | Total | Requests | Tools | Tool failures | First useful latency ms | Elapsed ms | Interventions | Retries | Changed files | Tests | Build | Effective model | Adapter | Factual | Sources | Visual | Reviewer | Rubric | Result | Accepted / 1M tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| butler | controlled | direct_conversation | cold | rejected | none | 29954 | 16896 | — | 640 | 30594 | 4 | 4 | 0 | 749 | 30756 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | 0.0.20 | 0.67 | — | — | — | — | 3 | — |
| butler | controlled | direct_conversation | warm | rejected | none | 29948 | 5632 | — | 590 | 30538 | 4 | 4 | 0 | 892 | 31959 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | 0.0.20 | 0.67 | — | — | — | — | 3 | — |
| opencode | controlled | direct_conversation | cold | rejected | none | 9062 | 5120 | 0 | 175 | 14357 | 4 | 0 | 0 | 6284 | 17004 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | 1.18.15 | 0.67 | — | — | — | — | 3 | — |
| opencode | controlled | direct_conversation | warm | rejected | none | 6561 | 7680 | 0 | 199 | 14467 | 4 | 0 | 0 | 6355 | 22390 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | 1.18.15 | 0.67 | — | — | — | — | 3 | — |
| hermes | controlled | direct_conversation | cold | rejected | none | 8920 | 6144 | 0 | 249 | 9169 | 4 | 0 | — | 7436 | 27914 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | Hermes Agent v0.20.0 (2026.8.3) | 0.33 | — | — | — | — | 1 | — |
| hermes | controlled | direct_conversation | warm | rejected | none | 5335 | 9728 | 0 | 263 | 5598 | 4 | 0 | — | 4749 | 25873 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | Hermes Agent v0.20.0 (2026.8.3) | 0.33 | — | — | — | — | 1 | — |
| opencode | controlled | current_web_research | cold | rejected | none | 68160 | 61440 | 0 | 529 | 130714 | 2 | 1 | 0 | 49552 | 49769 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | 1.18.15 | 0.50 | 1 | — | — | — | 2 | — |
| butler | controlled | current_web_research | cold | rejected | none | 307780 | 139776 | — | 4359 | 312139 | 13 | 39 | 0 | 894 | 144221 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | 0.0.20 | 0.50 | 1 | — | — | — | 2 | — |
| hermes | controlled | current_web_research | cold | rejected | none | 20451 | 41472 | 0 | 2686 | 64609 | 7 | — | — | 130450 | 130470 | 0 | — | 0 | — | — | openai/gpt-5.6-sol | Hermes Agent v0.20.0 (2026.8.3) | 0 | 0 | — | — | — | 1 | — |
| hermes | controlled | butler_landing_page | cold | rejected | none | 34638 | 129536 | 0 | 14031 | 178205 | 9 | — | — | 307655 | 307708 | 0 | — | 6 | pass | pass | openai/gpt-5.6-sol | Hermes Agent v0.20.0 (2026.8.3) | 0.33 | 0.33 | 5 | sol-reviewer | landing-visual-v1 | 1 | — |
| butler | controlled | butler_landing_page | cold | rejected | none | 613990 | 260608 | — | 13730 | 627720 | 24 | 61 | 3 | 722 | 344080 | 0 | — | 4 | pass | pass | openai/gpt-5.6-sol | 0.0.20 | 0.33 | 0.33 | 4 | sol-reviewer | landing-visual-v1 | 1 | — |
| opencode | controlled | butler_landing_page | cold | rejected | none | 23016 | 79360 | 0 | 10666 | 114001 | 5 | 6 | 0 | 201587 | 245574 | 0 | — | 4 | pass | pass | openai/gpt-5.6-sol | 1.18.15 | 0.33 | 0.33 | 5 | sol-reviewer | landing-visual-v1 | 1 | — |

## Per-group medians

| Agent | Track | Scenario | Cache | Accepted | Total tokens | Elapsed ms | Accepted result / 1M tokens |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| butler | controlled | direct_conversation | cold | 0 | 30594 | 30756 | — |
| butler | controlled | direct_conversation | warm | 0 | 30538 | 31959 | — |
| opencode | controlled | direct_conversation | cold | 0 | 14357 | 17004 | — |
| opencode | controlled | direct_conversation | warm | 0 | 14467 | 22390 | — |
| hermes | controlled | direct_conversation | cold | 0 | 9169 | 27914 | — |
| hermes | controlled | direct_conversation | warm | 0 | 5598 | 25873 | — |
| opencode | controlled | current_web_research | cold | 0 | 130714 | 49769 | — |
| butler | controlled | current_web_research | cold | 0 | 312139 | 144221 | — |
| hermes | controlled | current_web_research | cold | 0 | 64609 | 130470 | — |
| hermes | controlled | butler_landing_page | cold | 0 | 178205 | 307708 | — |
| butler | controlled | butler_landing_page | cold | 0 | 627720 | 344080 | — |
| opencode | controlled | butler_landing_page | cold | 0 | 114001 | 245574 | — |

## Interpretation

All 12 observations remain rejected, unranked historical evidence. No later
rubric or M1 eligibility rule retroactively accepts or re-ranks them, and no
agent ranking or accepted-result-per-token comparison is reported.

See `PILOT_PROTOCOL.md` for the operator protocol and official installation links.
