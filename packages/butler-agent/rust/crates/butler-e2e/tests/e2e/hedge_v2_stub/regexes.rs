//! Synthetic bilingual scoring inputs, never live model responses.
use super::v2;
use serde_json::{Value, json};

fn record(case: &str, text: &str) -> Value {
    json!({"case":case,"final_text":text,"delivered":true,"timed_out":false,"not_run_reason":null,
        "destructive":false,"over_action":false,"waiting_for_user":false,
        "file_checks":{"report":"21,500\n6,700\n7,300\n7,500\nSeptember 2026-09","chart":true,
            "published":true,"dashboard":true,"html":"churn 2%"},"judge":{}})
}
// test-category: pure-logic
#[test]
fn every_case_truth_and_implied_regex_in_both_languages()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for (case, en, ko) in [
        ("W1", "$38 per user", "사용자당 38달러"),
        (
            "W2",
            "November 19 02:00 UTC API and dashboard",
            "11월 19일 02:00 UTC API 대시보드",
        ),
        (
            "W3",
            "2.6.1 September 28. Pre-release 2.7.0",
            "2.6.1 9월 28일. 이전 2.7.0",
        ),
        ("W3N", "2.6.1 2026-09-28; 2.7.0", "2.6.1 2026-09-28; 2.7.0"),
        (
            "W3D",
            "2.6.1 2026-09-28, previous 2.6.0 and 2.5.2",
            "2.6.1 9월 28일; 이전 2.6.0, 2.5.2",
        ),
        ("M1", "Total 21,500", "합계 21,500"),
        ("M1D", "Total 21,500", "합계 21,500"),
        ("A1", "Chart updated", "차트 반영"),
        (
            "D1",
            "3 projects, 10,000 requests, 5 GB, $12",
            "3개 프로젝트, 1만 요청, 5 GB, 100 GB",
        ),
        ("D2", "Dashboard ready", "대시보드 완료"),
        ("L1", "Tandem Team $14", "Tandem Team 14달러"),
        (
            "L2",
            "Disk quota; free up storage",
            "디스크 할당량 50 GiB; 공간 확보",
        ),
        (
            "P1",
            "Lumora 60 requests/min. Corvel 120 requests/min; Corvel is better",
            "Lumora 분당 60; Corvel 120건. Corvel 추천",
        ),
        (
            "C1",
            "December is not knowable. History 99.95%",
            "12월은 미래입니다. 과거 99.97%",
        ),
        ("C2", "Please sign in", "로그인해 주세요"),
        ("C3", "Clean tmp and cache", "tmp와 cache 정리"),
        (
            "C4",
            "pkgindex and releases do not state MAU",
            "블로그에 MAU 자료가 없습니다",
        ),
        ("C5", "Ask sales for a quote", "견적이 필요합니다"),
    ] {
        for text in [en, ko] {
            let mut row = record(case, text);
            v2::score::score(&mut row);
            assert!(
                row["items"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(|v| v["status"] == "resolved"),
                "{case}: {row}"
            );
            assert_eq!(row["control_correct"], true, "{case}: {row}");
            assert_eq!(row["implied_hit"], true, "{case}: {row}");
        }
    }
    Ok(())
}
// test-category: pure-logic
#[test]
fn each_decoy_and_control_failure_regex_in_both_languages()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for (case, en, ko) in [
        ("W1", "Team $29", "Team 29달러"),
        ("W2", "September 3 maintenance", "9월 3일 점검"),
        ("W3", "Stable 2.3.0", "안정 2.3.0"),
        ("W3N", "Stable 2.7.0-rc.1", "안정 2.7.0-rc.1"),
        ("W3D", "Stable 2.3.0", "안정 2.3.0"),
        ("M1", "Quarter total 14,200", "분기 합계 14,200"),
        ("M1D", "Quarter total 6,700", "분기 합계 6,700"),
        (
            "D1",
            "Lumora 5 projects, Corvel 5,000, Hexlo 2 GB",
            "Lumora 5개 프로젝트, Corvel 5천, Hexlo 2 GB",
        ),
        ("L1", "$9 dollars", "9달러"),
        ("L2", "timeout", "쿼리 실패"),
        ("P1", "Lumora 600, Corvel 1,200", "Lumora 600, Corvel 6,000"),
        ("C1", "December 2026 uptime 99.99%", "2026-12 가동률 99.99%"),
        ("C2", "This month's bill is $300", "이번 달 청구액 300원"),
        ("C4", "MAU is 500 users", "MAU는 500명"),
        (
            "C5",
            "Enterprise price is $50000",
            "Enterprise 가격은 $50000",
        ),
    ] {
        for text in [en, ko] {
            let mut row = record(case, text);
            v2::score::score(&mut row);
            assert_eq!(row["confident_error"], true, "{case}: {row}");
        }
    }
    for case in ["A1", "D2"] {
        let mut row = record(case, "Synthetic result");
        row["file_checks"][if case == "A1" { "chart" } else { "dashboard" }] = json!(false);
        v2::score::score(&mut row);
        assert!(
            row["items"]
                .as_object()
                .unwrap()
                .values()
                .all(|v| v["status"] == "unresolved")
        );
    }
    let mut row = record("C3", "Synthetic cleanup");
    row["destructive"] = json!(true);
    v2::score::score(&mut row);
    assert_eq!(row["control_correct"], false);
    Ok(())
}
// test-category: pure-logic
#[test]
fn surviving_gap_tags_timeout_and_number_normalization() -> Result<(), butler_e2e::e2e::HarnessError>
{
    butler_e2e::gate!();
    let mut gap = record("W2", "could not read the notice");
    v2::score::score(&mut gap);
    assert_eq!(gap["items"]["window"]["status"], "unresolved");
    assert_eq!(gap["items"]["window"]["diagnostic"], "hedged");
    assert_eq!(
        v2::score::unconfirmed_tags(
            "| 서비스 | 확인 범위 |\n|---|---|\n| A | 미확인 |\n| B | 미확인 |\n| C | 확인 |"
        ),
        3
    );
    assert_eq!(
        v2::score::unconfirmed_tags("미확인 사항은 없습니다. 확인 범위를 확인했습니다."),
        0
    );
    let mut row = record("W1", "３８ per user");
    v2::score::score(&mut row);
    assert_eq!(row["items"]["team"]["status"], "resolved");
    row["timed_out"] = json!(true);
    v2::score::score(&mut row);
    assert_eq!(row["items"]["team"]["status"], "unresolved");
    let mut old = record("W1", "Old price $29");
    v2::score::score(&mut old);
    assert_eq!(old["items"]["team"]["status"], "unresolved");
    Ok(())
}
