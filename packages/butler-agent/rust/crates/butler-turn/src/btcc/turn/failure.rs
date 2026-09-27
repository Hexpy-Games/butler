use crate::btcc::RuntimeFailure;

pub(super) fn runtime_failure_message(original: &str, failure: &RuntimeFailure) -> String {
    runtime_failure_message_for_work(original, failure, false)
}

pub(super) fn runtime_failure_message_for_work(
    original: &str,
    failure: &RuntimeFailure,
    work_completed: bool,
) -> String {
    let korean = original.chars().any(|value| ('가'..='힣').contains(&value));
    let cause = match (failure.code.as_str(), korean) {
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
    };
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
