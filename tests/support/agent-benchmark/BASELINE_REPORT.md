# Butler agent benchmark pilot

This report is generated from the persisted benchmark observations. It does not contain prompts, transcripts, credentials, tool payloads, hidden reasoning, or private absolute paths.

- Schema: `butler.agent-benchmark.v1`
- Run: `agent-benchmark-20260809`
- Baseline: `549463fbe074fc25042f9302cd330699948dab50`
- Seed: `20260809`
- Observations: 36
- Accepted: 0
- Ranking: withheld (missing or gated observations)

## Track configurations

- Controlled: butler: model=openai/gpt-5.5, reasoning=medium, permissions=benchmark-workspace-full-source-read-only, tools=product-default; hermes: model=openai/gpt-5.5, reasoning=unavailable, permissions=benchmark-workspace-full-source-read-only, tools=filesystem,web; reasoning unavailable (Hermes CLI has no official per-run reasoning flag); opencode: model=openai/gpt-5.5, reasoning=medium, permissions=benchmark-workspace-full-source-read-only, tools=filesystem,web
- Recommended-default: butler: model=product-resolved, reasoning=product-resolved, permissions=product-recommended-default, tools=product-default; hermes: model=product-resolved, reasoning=product-resolved, permissions=product-recommended-default, tools=filesystem,web,terminal; opencode: model=product-resolved, reasoning=product-resolved, permissions=product-recommended-default, tools=filesystem,web,terminal

## Gates

- butler / direct_conversation / controlled / cold: `measurement_unavailable`
- butler / direct_conversation / controlled / warm: `measurement_unavailable`
- opencode / direct_conversation / controlled / cold: `executable_missing`
- opencode / direct_conversation / controlled / warm: `executable_missing`
- hermes / direct_conversation / controlled / cold: `executable_missing`
- hermes / direct_conversation / controlled / warm: `executable_missing`
- opencode / direct_conversation / recommended-default / cold: `executable_missing`
- opencode / direct_conversation / recommended-default / warm: `executable_missing`
- hermes / direct_conversation / recommended-default / cold: `executable_missing`
- hermes / direct_conversation / recommended-default / warm: `executable_missing`
- butler / direct_conversation / recommended-default / cold: `measurement_unavailable`
- butler / direct_conversation / recommended-default / warm: `measurement_unavailable`
- opencode / current_web_research / controlled / cold: `executable_missing`
- opencode / current_web_research / controlled / warm: `executable_missing`
- butler / current_web_research / controlled / cold: `measurement_unavailable`
- butler / current_web_research / controlled / warm: `measurement_unavailable`
- hermes / current_web_research / controlled / cold: `executable_missing`
- hermes / current_web_research / controlled / warm: `executable_missing`
- butler / current_web_research / recommended-default / cold: `measurement_unavailable`
- butler / current_web_research / recommended-default / warm: `measurement_unavailable`
- opencode / current_web_research / recommended-default / cold: `executable_missing`
- opencode / current_web_research / recommended-default / warm: `executable_missing`
- hermes / current_web_research / recommended-default / cold: `executable_missing`
- hermes / current_web_research / recommended-default / warm: `executable_missing`
- hermes / butler_landing_page / controlled / cold: `executable_missing`
- hermes / butler_landing_page / controlled / warm: `executable_missing`
- butler / butler_landing_page / controlled / cold: `measurement_unavailable`
- butler / butler_landing_page / controlled / warm: `measurement_unavailable`
- opencode / butler_landing_page / controlled / cold: `executable_missing`
- opencode / butler_landing_page / controlled / warm: `executable_missing`
- hermes / butler_landing_page / recommended-default / cold: `executable_missing`
- hermes / butler_landing_page / recommended-default / warm: `executable_missing`
- butler / butler_landing_page / recommended-default / cold: `measurement_unavailable`
- butler / butler_landing_page / recommended-default / warm: `measurement_unavailable`
- opencode / butler_landing_page / recommended-default / cold: `executable_missing`
- opencode / butler_landing_page / recommended-default / warm: `executable_missing`

## Per-arm metrics

| Agent | Track | Scenario | Cache | State | Gate | Input | Cache read | Cache write | Output | Total | Requests | Tools | Tool failures | First useful latency ms | Elapsed ms | Interventions | Retries | Changed files | Tests | Build | Effective model | Adapter | Factual | Sources | Visual | Reviewer | Rubric | Result | Accepted / 1M tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| butler | controlled | direct_conversation | cold | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | 0.0.20 | — | — | — | — | — | — | — |
| butler | controlled | direct_conversation | warm | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | 0.0.20 | — | — | — | — | — | — | — |
| opencode | controlled | direct_conversation | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| opencode | controlled | direct_conversation | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| hermes | controlled | direct_conversation | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| hermes | controlled | direct_conversation | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| opencode | recommended-default | direct_conversation | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| opencode | recommended-default | direct_conversation | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| hermes | recommended-default | direct_conversation | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| hermes | recommended-default | direct_conversation | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| butler | recommended-default | direct_conversation | cold | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 0.0.20 | — | — | — | — | — | — | — |
| butler | recommended-default | direct_conversation | warm | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 0.0.20 | — | — | — | — | — | — | — |
| opencode | controlled | current_web_research | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| opencode | controlled | current_web_research | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| butler | controlled | current_web_research | cold | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | 0.0.20 | — | — | — | — | — | — | — |
| butler | controlled | current_web_research | warm | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | 0.0.20 | — | — | — | — | — | — | — |
| hermes | controlled | current_web_research | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| hermes | controlled | current_web_research | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| butler | recommended-default | current_web_research | cold | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 0.0.20 | — | — | — | — | — | — | — |
| butler | recommended-default | current_web_research | warm | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 0.0.20 | — | — | — | — | — | — | — |
| opencode | recommended-default | current_web_research | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| opencode | recommended-default | current_web_research | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| hermes | recommended-default | current_web_research | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| hermes | recommended-default | current_web_research | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| hermes | controlled | butler_landing_page | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| hermes | controlled | butler_landing_page | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| butler | controlled | butler_landing_page | cold | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | 0.0.20 | — | — | — | — | — | — | — |
| butler | controlled | butler_landing_page | warm | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | 0.0.20 | — | — | — | — | — | — | — |
| opencode | controlled | butler_landing_page | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| opencode | controlled | butler_landing_page | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | openai/gpt-5.5 | — | — | — | — | — | — | — | — |
| hermes | recommended-default | butler_landing_page | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| hermes | recommended-default | butler_landing_page | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| butler | recommended-default | butler_landing_page | cold | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 0.0.20 | — | — | — | — | — | — | — |
| butler | recommended-default | butler_landing_page | warm | gated | measurement_unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 0.0.20 | — | — | — | — | — | — | — |
| opencode | recommended-default | butler_landing_page | cold | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| opencode | recommended-default | butler_landing_page | warm | gated | executable_missing | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

## Per-group medians

| Agent | Track | Scenario | Cache | Accepted | Total tokens | Elapsed ms | Accepted result / 1M tokens |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| butler | controlled | direct_conversation | cold | 0 | — | — | — |
| butler | controlled | direct_conversation | warm | 0 | — | — | — |
| opencode | controlled | direct_conversation | cold | 0 | — | — | — |
| opencode | controlled | direct_conversation | warm | 0 | — | — | — |
| hermes | controlled | direct_conversation | cold | 0 | — | — | — |
| hermes | controlled | direct_conversation | warm | 0 | — | — | — |
| opencode | recommended-default | direct_conversation | cold | 0 | — | — | — |
| opencode | recommended-default | direct_conversation | warm | 0 | — | — | — |
| hermes | recommended-default | direct_conversation | cold | 0 | — | — | — |
| hermes | recommended-default | direct_conversation | warm | 0 | — | — | — |
| butler | recommended-default | direct_conversation | cold | 0 | — | — | — |
| butler | recommended-default | direct_conversation | warm | 0 | — | — | — |
| opencode | controlled | current_web_research | cold | 0 | — | — | — |
| opencode | controlled | current_web_research | warm | 0 | — | — | — |
| butler | controlled | current_web_research | cold | 0 | — | — | — |
| butler | controlled | current_web_research | warm | 0 | — | — | — |
| hermes | controlled | current_web_research | cold | 0 | — | — | — |
| hermes | controlled | current_web_research | warm | 0 | — | — | — |
| butler | recommended-default | current_web_research | cold | 0 | — | — | — |
| butler | recommended-default | current_web_research | warm | 0 | — | — | — |
| opencode | recommended-default | current_web_research | cold | 0 | — | — | — |
| opencode | recommended-default | current_web_research | warm | 0 | — | — | — |
| hermes | recommended-default | current_web_research | cold | 0 | — | — | — |
| hermes | recommended-default | current_web_research | warm | 0 | — | — | — |
| hermes | controlled | butler_landing_page | cold | 0 | — | — | — |
| hermes | controlled | butler_landing_page | warm | 0 | — | — | — |
| butler | controlled | butler_landing_page | cold | 0 | — | — | — |
| butler | controlled | butler_landing_page | warm | 0 | — | — | — |
| opencode | controlled | butler_landing_page | cold | 0 | — | — | — |
| opencode | controlled | butler_landing_page | warm | 0 | — | — | — |
| hermes | recommended-default | butler_landing_page | cold | 0 | — | — | — |
| hermes | recommended-default | butler_landing_page | warm | 0 | — | — | — |
| butler | recommended-default | butler_landing_page | cold | 0 | — | — | — |
| butler | recommended-default | butler_landing_page | warm | 0 | — | — | — |
| opencode | recommended-default | butler_landing_page | cold | 0 | — | — | — |
| opencode | recommended-default | butler_landing_page | warm | 0 | — | — | — |

## Interpretation

Hermes/OpenCode installation or another required observation is unavailable. No agent ranking or fabricated comparison number is reported.

See `PILOT_PROTOCOL.md` for the operator protocol and official installation links.
