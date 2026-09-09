# Qwen reasoning effort: 운영 vLLM 실측

## 범위와 실험 계획

사용자가 제시한 reasoningEffort variant가 현재 서버에서 실제 적용되는지 확인하고, 동일한 실제 업무 입력에서 결과 차이를 측정한다. 서버 및 Butler 설정은 변경하지 않는다. 직접 모델 호출만 수행하며 생성된 도구 호출을 실행하지 않는다.

1. 현재 모델/서버 식별 및 공식 모델 템플릿·동일 버전 vLLM 코드 확인.
2. 서버 render endpoint로 각 필드와 값이 실제 입력 토큰을 바꾸는지 확인.
3. 기존 Butler 샘플링(temperature=0, stream=false, 출력 한도 생략)에서 none/low/medium/xhigh 비교.
4. 빈 응답은 streaming/raw completion으로 구분하고, 공식 권장 샘플링으로 별도 민감도 확인.
5. 가시 답변·추론 문자량·생성 토큰·finish_reason·시간을 대조한다. 작은 표본으로 일반 성공률이나 모델 순위를 추정하지 않는다.

## 환경

- vLLM /version: 0.27.1
- /v1/models: qwen3.8-27b
- 모델 root: Qwen3.8-27B-W4A16-AutoRound-fast
- 실제 서버 context: 114688
- 사용자 예시 FP8/262144 환경과 다르며 결과를 FP8로 일반화하지 않는다.
- 실험은 순차 호출. GPU의 다른 사용자 부하와 prefix cache를 완전히 통제하지 못하므로 latency는 관측값이다.
- raw 실험 요청/응답은 /tmp/butler-qwen-effort-investigation/에 비공개 파일 권한으로 저장. 보고서에 숨겨진 추론 원문을 싣지 않는다.

## API와 템플릿 확인

[공식 Qwen 모델 카드](https://huggingface.co/Qwen/Qwen3.8-27B)는 low/medium/xhigh를 지원하며 기본은 xhigh라고 설명한다. 샘플 API도 최상위 reasoning_effort를 사용한다. [공식 템플릿](https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/chat_template.jinja)은 low와 xhigh에 서로 다른 추론 지시를 추가하며, medium에서는 별도 강도 지시를 추가하지 않는다. 고정 토큰 예산을 나눠 주는 구현이 아니다.

[vLLM 0.27.1 protocol](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/entrypoints/openai/chat_completion/protocol.py)은 reasoning_effort를 템플릿으로 전달하고 none이면 enable_thinking=false를 적용한다(명시적 template override가 없는 경우).

실제 서버 render + detokenize 결과:

| HTTP JSON 값 | 상태 | 실제 프롬프트 |
| --- | --- | --- |
| 생략 | 200 | xhigh와 동일한 토큰/문자열 SHA |
| reasoning_effort:none | 200 | 미리 닫힌 think 블록, 추론 비활성 |
| reasoning_effort:low | 200 | 간결한 추론 지시 |
| reasoning_effort:medium | 200 | 열린 think 블록, 강도 지시 없음 |
| reasoning_effort:xhigh | 200 | 신중한 검증·대안 고려 지시 |
| reasoning_effort:high/minimal/max | 400 | Qwen 템플릿의 지원 값 검증 실패 |
| reasoningEffort:low | 200 | 필드 무시, 생략/xhigh와 동일한 SHA |

즉 사용자 예시의 camelCase는 클라이언트 설정 형식이다. 전송 JSON은 snake_case로 변환돼야 한다. 현재 Butler는 그 변환/전달 자체가 빠져 있어 UI의 none과 무관하게 서버 기본 xhigh가 사용된다. 상위 OpenAI 호환 스키마가 허용하는 모든 값이 개별 모델 템플릿에서도 허용되는 것은 아니다.

## 실험 입력

- Parent: 좋은 오후 인사 세션의 마지막 결과 수신 턴(turn-afc29d1c-4e02-4bd7-8803-9331d6645194)에서 캡처한 지시/원래 입력을 복원. 빈 응답 재시도용 추가 메시지는 제거. xhigh prompt_tokens=17151은 원 실행 첫 라운드와 일치한다. tools 없는 최종 보고 조건 유지.
- Summary: 이전 4096 중단을 재현한 70720문자 요약 입력을 그대로 사용하되 max_tokens를 제거. xhigh 원 입력 토큰 기준 29210.
- 각 조건 1회. 샘플링/배치 비결정성이 남을 수 있어 성공률로 해석하지 않는다.

## 결과

조건별 1회, 전체 8회 모두 HTTP 200 / finish_reason=stop. 생성 토큰은 추론+가시 답변 합계다.

### 요약 입력

| effort | 시간(초) | 생성 토큰 | 추론 문자 | 답변 문자 | 관찰 |
| --- | ---: | ---: | ---: | ---: | --- |
| none | 39.87 | 1,680 | 0 | 3,054 | 요약 본문 생성 |
| low | 53.09 | 2,853 | 3,419 | 2,455 | 요약 본문 생성 |
| medium | 45.50 | 3,409 | 5,387 | 3,121 | 요약 본문 생성 |
| xhigh | 131.09 | 9,367 | 23,529 | 3,391 | 요약 본문 생성 |

### 버틀러 최종 보고 입력

| effort | 시간(초) | 생성 토큰 | 추론 문자 | 답변 문자 | 관찰 |
| --- | ---: | ---: | ---: | ---: | --- |
| none | 17.66 | 635 | 0 | 1,034 | 브리핑 본문 생성, 사실/출처 완전성은 별도 |
| low | 8.46 | 237 | 753 | 0 | 답변 없음 |
| medium | 6.81 | 567 | 1,734 | 74 | 전달하겠다는 예고문 |
| xhigh | 24.24 | 1,709 | 8,081 | 55 | tool_search 호출 형태의 일반 텍스트; 실제 tool_calls=0 |

요약 xhigh는 low 대비 생성 토큰 약 3.28배, 관측 시간 약 2.47배다. none 대비는 생성 토큰 5.58배, 관측 시간 3.29배다. 모든 요약에서 가시 본문이 나왔으나, 이것을 사실 보존 정확도에 대한 전면 검증으로 취급하지 않는다.

Parent xhigh 입력 토큰 수는 원 실행 첫 라운드와 일치하지만, 이번 출력은 원 실행의 빈 출력과 다르다. temperature=0도 운영 서버 배치/KV/수치 계산 환경에서 완전한 재현성을 보장하지 않으므로 한 번의 결과를 실패율로 해석하지 않는다.

## 추가 대조

### 빈 응답 대조에서 발견한 실제 메커니즘

- parent-low nonstream: 237 생성 토큰, reasoning 753문자, content 없음, tool_calls 없음, stop.
- 같은 입력/effort/temperature에서 stream:true: 동일 237토큰, 동일 reasoning 길이, content 없음, stop. 스트리밍 변경만으로 해결되지 않았다.
- 서버가 렌더한 동일 low 입력 token_ids를 /v1/completions로 전달하여 채팅 파서를 우회: 237토큰, stop. 이 대조만 raw completion 기본 16토큰 제한을 피하기 위해 max_tokens=32768을 명시했다. 실제 생성 237로 상한에 도달하지 않았다.
- 원시 생성의 reasoning 부분은 Chat API reasoning과 trim 후 완전히 일치한다. 원시 생성에는 닫힌 think 뒤에 read_file을 요청하는 tool_call XML이 있다. 파일 경로를 포함한 내부 호출 원문은 공개 보고서에서 생략한다.
- 즉 이 재현의 빈 답변은 추론이 끝나지 않은 것이 아니다. 모델은 추론을 끝내고, tools 없는 입력에서 사용할 수 없는 도구 호출을 생성했다. Chat API 응답에는 그 블록이 가시 답변이나 tool_calls로 나타나지 않았다.
- [Qwen3 parser](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/parser/qwen3.py)는 추론/도구를 통합 파싱한다. [ParserEngine.extract_reasoning](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/parser/engine/parser_engine.py)은 reasoning/text 이벤트만 반환하므로 도구 블록은 일반 답변에 포함되지 않는 코드 경로가 존재한다. 서버 실행 옵션 전체를 확보하지 못했으므로 특정 parser 클래스가 실제 설정됐다는 점까지 확인한 것은 아니다.
- 이전 운영 첫 빈 응답은 xhigh이고 1064토큰이었다. 이번 low/237토큰 재현은 구체적인 실패 메커니즘을 입증하지만, 저장되지 않은 이전 응답 원문까지 동일했다고 단정하지 않는다.

### 샘플링 민감도

공식 권장값으로 별도 대조: thinking은 temperature=1.0/top_p=0.95/top_k=20, none은 temperature=0.7/top_p=0.8/presence_penalty=1.5. seed=42, repetition_penalty=1.0, min_p=0.0. effort 주 비교와 샘플링 변경을 섞어 속도 순위나 성공률을 주장하지 않는다.



| effort | 시간(초) | 생성 토큰 | 추론 문자 | 답변 문자 | 결과 |
| --- | ---: | ---: | ---: | ---: | --- |
| none | 14.61 | 484 | 0 | 799 | 브리핑 본문 생성 |
| low | 2.76 | 241 | 775 | 0 | 빈 답변 |
| medium | 2.48 | 218 | 632 | 0 | 빈 답변 |
| xhigh | 106.66 | 6,841 | 20,696 | 1,046 | 브리핑 본문 생성 |

권장 샘플링도 low/medium의 빈 응답을 해결하지 못했다. xhigh는 이 대조 1회에서 본문을 생성했지만 106.66초/6841토큰이 필요했다. 샘플링 변경과 확률성의 효과를 분리한 반복 실험은 아니므로 안정화됐다고 판단할 수 없다. none과 권장 xhigh 모두 상위 결과의 검증 완료 주장을 그대로 반복하고 기사별 링크를 직접 전달하지 않아, 정상 본문 생성과 전체 품질 충족은 구분한다.

## 결론과 적용 방향

- 최상위 reasoning_effort는 현재 vLLM/Qwen에서 실제 지원되고 강도별 차이가 있다. Butler는 요청 effort를 wire field로 전달하고, 모델별 지원 값 none/low/medium/xhigh를 노출해야 한다. high를 그대로 보내면 현재 모델은 400이므로 공통 provider 전체를 가정한 값 전달은 피한다.
- 설정 생략은 xhigh다. 현재 UI none이 wire에서 누락되는 동작은 가벼운 모드가 아니라 서버 기본 강한 추론 모드를 택하게 만든다.
- effort는 출력 토큰 상한과 별개다. 이번 요약에서 출력 한도 생략은 유지됐으며 xhigh도 9367토큰 후 stop으로 정상 요약을 냈다.
- 낮은 effort가 항상 좋은 답변이나 빠른 업무 완주를 보장하지 않는다. 요약만 보면 low가 xhigh보다 훨씬 저렴하지만, 같은 low로 최종 보고에서는 없는 도구 호출과 빈 API 답변이 재현됐다.
- 최종 보고 입력의 도구/지시 불일치를 먼저 바로잡아야 한다. none은 이번 작은 표본에서 본문을 냈지만, 이를 전역 해결책으로 지정할 근거는 부족하다.
- 샘플링 권장값과 실제 값의 차이는 별도로 평가해야 하며, 근거 없이 전역 temperature를 바꾸지 않았다.
- 9개 render 조건과 14개 생성 호출(주 비교 8 + 대조 6)을 완료했다. 도구 실행, 설정 수정, 운영 재시작은 하지 않았다. 측정과 출력 검토를 완료했으며, 성공률/FP8 성능/장기 체인 품질은 이번 결과로 확정하지 않는다.
