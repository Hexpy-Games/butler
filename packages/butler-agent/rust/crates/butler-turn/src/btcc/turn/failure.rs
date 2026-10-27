use crate::btcc::RuntimeFailure;

/// The answer of a turn whose agent loop failed operationally.
pub(super) fn runtime_failure_message(original: &str, failure: &RuntimeFailure) -> String {
    runtime_failure_message_for_work(original, failure, None)
}

/// The failure answer in the user's language (Korean when the request is
/// Korean), noting when the accepted Work already completed.
pub(super) fn runtime_failure_message_for_work(
    original: &str,
    failure: &RuntimeFailure,
    accepted_work: Option<&crate::btcc::AcceptedWorkResult>,
) -> String {
    let work_completed =
        accepted_work.is_some_and(|value| value.status == crate::btcc::AcceptedWorkStatus::Success);
    let korean = original.chars().any(|value| ('가'..='힣').contains(&value));
    if failure.code == "provider_tools_unsupported" && !work_completed {
        return if korean {
            "이 모델 서버는 도구 호출을 지원하지 않습니다.".into()
        } else {
            "This model server doesn't support tool calls.".into()
        };
    }
    let short = match (failure.code.as_str(), korean) {
        ("provider_output_truncated", true) => Some("답변이 출력 한도에 도달했습니다."),
        ("provider_output_truncated", false) => {
            Some("The answer reached the model's output limit.")
        }
        ("provider_stop_unrecognized", true) => Some("모델 응답이 중단되었습니다."),
        ("provider_stop_unrecognized", false) => Some("The model response stopped."),
        ("provider_response_refused", true) => Some("모델이 답변을 거절했습니다."),
        ("provider_response_refused", false) => Some("Model refused the response."),
        ("provider_safety_error", true) => Some("안전 필터에 걸렸습니다."),
        ("provider_safety_error", false) => Some("Provider safety filter."),
        _ => None,
    };
    if let Some(short) = short.filter(|_| !work_completed) {
        return short.into();
    }
    let cause = cause(failure, korean);
    if korean {
        if work_completed {
            format!(
                "작업은 완료했지만 {cause} 최종 설명을 작성하지 못했습니다. 작업 결과는 저장되어 있습니다."
            )
        } else {
            format!("{cause} 작업을 더 진행하지 못했습니다. 진행한 내용은 저장되어 있습니다.")
        }
    } else if work_completed {
        format!(
            "The work is complete, but {cause} prevented the final explanation. The results are saved."
        )
    } else {
        format!("{cause} prevented further work. Progress is saved.")
    }
}

fn cause(failure: &RuntimeFailure, korean: bool) -> &'static str {
    match (failure.code.as_str(), korean) {
        ("provider_plan_usage_unavailable", true) => "ChatGPT 플랜 사용량을 확인하지 못해",
        ("provider_plan_not_eligible", true) => "이 계정은 ChatGPT 플랜을 쓸 수 없어",
        ("provider_plan_not_authorized" | "provider_route_not_supported", true) => {
            "ChatGPT 플랜 권한이 맞지 않아"
        }
        ("chatgpt_sign_in_required", true) => "ChatGPT 로그인이 필요해",
        ("chatgpt_plan_not_enabled", true) => "ChatGPT 플랜 사용이 꺼져 있어",
        ("provider_unsupported_capability" | "provider_unsupported_input", true) => {
            "ChatGPT 플랜이 지원하지 않는 요청이라"
        }
        ("provider_response_refused", true) => "모델이 답변을 거절해",
        ("provider_safety_error", true) => "모델 제공자의 안전 필터에 걸려",
        ("provider_stop_unrecognized", true) => "모델이 알 수 없는 이유로 응답을 멈춰",
        ("provider_response_incomplete", true) => "모델 응답이 중간에 끝나",
        ("provider_rate_limited", true) => "모델 제공자의 요청 한도에 걸려",
        ("provider_quota_exhausted", true) => "모델 제공자의 사용량 한도가 소진되어",
        ("provider_auth_error", true) => "모델 제공자 인증에 실패해",
        ("provider_network_error" | "provider_stream_interrupted", true) => "모델과의 연결이 끊겨",
        ("provider_round_timeout" | "provider_timeout", true) => "모델의 응답을 받지 못해",
        ("provider_empty_response", true) => "모델이 답변을 반환하지 않아",
        ("provider_request_rejected" | "provider_bad_request", true) => {
            "모델 제공자가 요청을 거부해"
        }
        ("provider_api_error", true) => "모델 제공자에서 오류가 발생해",
        (_, true) => "실행 중 오류가 발생해",
        ("provider_plan_usage_unavailable", false) => "Unavailable ChatGPT plan usage",
        ("provider_plan_not_eligible", false) => "An ineligible ChatGPT plan",
        ("provider_plan_not_authorized" | "provider_route_not_supported", false) => {
            "A ChatGPT plan permission mismatch"
        }
        ("chatgpt_sign_in_required", false) => "A required ChatGPT sign-in",
        ("chatgpt_plan_not_enabled", false) => "ChatGPT plan use being off",
        ("provider_unsupported_capability" | "provider_unsupported_input", false) => {
            "An unsupported ChatGPT plan request"
        }
        ("provider_response_refused", false) => "A model refusal",
        ("provider_safety_error", false) => "The provider's safety filter",
        ("provider_stop_unrecognized", false) => "An unrecognized model stop",
        ("provider_response_incomplete", false) => "An incomplete model response",
        ("provider_rate_limited", false) => "The model provider's rate limit",
        ("provider_quota_exhausted", false) => "The model provider's exhausted quota",
        ("provider_auth_error", false) => "A model provider authentication failure",
        ("provider_network_error" | "provider_stream_interrupted", false) => {
            "An interrupted model connection"
        }
        ("provider_round_timeout" | "provider_timeout", false) => "A model response timeout",
        ("provider_empty_response", false) => "An empty model response",
        ("provider_request_rejected" | "provider_bad_request", false) => {
            "The model provider's request rejection"
        }
        ("provider_api_error", false) => "A model provider error",
        (_, false) => "An execution error",
    }
}
