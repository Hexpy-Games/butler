//! Meta-line detectors, echoed plan checks and the requested-content flag,
//! on synthetic answers and the shared example fixture.
use super::v2;
use butler_e2e::e2e::hedge::{echoed_checks, meta_hits, meta_lines};
use serde_json::{Value, json};

fn examples() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/hedge-v2/meta-examples.json"
    ))
    .unwrap()
}
// test-category: pure-logic
#[test]
fn meta_lines_flag_every_example_and_no_content_control()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let examples = examples();
    let flagged = examples["flag"].as_array().unwrap();
    for example in flagged {
        let text = example["text"].as_str().unwrap();
        let category = example["category"].as_str().unwrap();
        let lines = meta_lines(text);
        assert!(
            lines.iter().any(|(name, _)| name == category),
            "{category}: {text} -> {lines:?}"
        );
        assert_eq!(meta_hits(text)["total"], 1, "{text}");
    }
    for text in examples["clean"].as_array().unwrap() {
        let text = text.as_str().unwrap();
        assert_eq!(meta_lines(text), Vec::<(String, String)>::new(), "{text}");
        assert_eq!(meta_hits(text)["total"], 0, "{text}");
    }
    let joined = flagged
        .iter()
        .map(|e| e["text"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join(" ");
    let hits = meta_hits(&joined);
    assert_eq!(hits["total"], flagged.len(), "{hits:?}");
    for (category, count) in [
        ("self_report_negative", 6),
        ("reading_warning", 6),
        ("process_scope", 6),
    ] {
        assert_eq!(hits[category], count, "{category}: {hits:?}");
    }
    for text in [
        "Sorry, I did not change the schedule.",
        "미안, 예약은 변경하지 않았다.",
        "```text\nI left your 7 a.m. daily schedule unchanged.\n```",
    ] {
        assert_eq!(meta_hits(text)["total"], 0, "{text}");
    }
    Ok(())
}
// test-category: pure-logic
#[test]
fn echoed_checks_need_most_content_tokens_in_one_sentence()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let lines = [
        "기존 오전 7시 예약은 변경하지 않는다",
        "각 루머의 확인 상태를 구분한다",
        "Leave the 7 a.m. daily schedule unchanged",
        "Separate confirmation status for each rumor",
        "Brief",
    ]
    .map(str::to_owned);
    let text = "세라벨이 새 캐릭터라는 유출이다. 기존 매일 오전 7시 예약은 변경하지 않았다냐. \
        Seravel is the leaked character. I left your 7 a.m. daily schedule unchanged.";
    assert_eq!(
        echoed_checks(text, &lines),
        [lines[0].clone(), lines[2].clone()]
    );
    // Tokens split across sentences are not an echo.
    let split = "기존 예약이다. 오전에 다시 확인하겠다.";
    assert_eq!(echoed_checks(split, &lines[..1]), Vec::<String>::new());
    Ok(())
}
// test-category: pure-logic
#[test]
fn briefing_scores_meta_echo_and_requested_rumor() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for (text, shown) in [
        (
            "Merin Coast Line: 42 km, 9 stations. Jobless rate 2.9%, lowest in 14 months. \
             HarborBench: 23 of 120 tasks (19.2%). Leak (unconfirmed): Seravel joins in 3.2; \
             Glasswake Festival from November 12. I left your 7 a.m. daily schedule unchanged.",
            true,
        ),
        (
            "Merin Coast Line: 42 km, 9 stations. Jobless rate 2.9%, lowest in 14 months. \
             HarborBench: 23 of 120 tasks (19.2%). The 3.2 leaks could not be verified, \
             so I did not fill in unconfirmed details.",
            false,
        ),
    ] {
        let mut row = json!({"case":"B1E","final_text":text,"delivered":true,"timed_out":false,
            "not_run_reason":null,"content_request":true,"file_checks":{},"judge":{},
            "plan_checks":[["Leave the 7 a.m. daily schedule unchanged", "Show each leak"]],
            "plan_intent":[{"goal":"Get today's briefing","assume":"Research directly without workers"}]});
        v2::score::score(&mut row);
        assert_eq!(row["requested_rumor_shown"], shown, "{row}");
        assert_eq!(row["items"]["paper"]["status"], "resolved", "{row}");
        assert_eq!(row["meta_hits"]["self_report_negative"], 1, "{row}");
        assert_eq!(row["echoed_checks"], usize::from(shown), "{row}");
    }
    Ok(())
}
