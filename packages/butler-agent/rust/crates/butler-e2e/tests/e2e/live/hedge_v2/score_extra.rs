//! Judgment and recall facts supplied by the coordinator.
use super::{Item, confident, matches};
use serde_json::{Value, json};

pub(super) fn items(case: &str) -> Vec<Item> {
    let item = |name, truth, decoy| Item { name, truth, decoy };
    match case {
        "R1" => vec![item(
            "ship",
            &[
                r"((^|[^A-Za-z0-9_])B($|[^A-Za-z0-9_])|후보 ?B|pred_b|설정 ?B)[^\n]{0,60}(배포|추천|권장|선택|낫|채택)|(배포|추천|권장|선택|채택)[^\n]{0,40}((^|[^A-Za-z0-9_])B($|[^A-Za-z0-9_])|후보 ?B|pred_b|설정 ?B)",
                r"0?\.889|88\.9",
            ],
            r"((^|[^A-Za-z0-9_])A($|[^A-Za-z0-9_])|후보 ?A|pred_a|설정 ?A)[^\n]{0,20}(를|을)? ?(배포|채택)(하세요|하자|합시다|해|하는 게 좋)",
        )],
        "J1" => vec![item(
            "cause",
            &[
                r"(배포|v4\.18)[^\n]{0,50}(때문|원인|탓|영향|으로 보|가능성이 (크|높|매우)|유력)",
                r"(^|[^0-9])2[01]\d($|[^0-9])",
                r"(^|[^0-9])3[2-6]\d($|[^0-9])",
            ],
            r"(트래픽|요청 ?(수|량))[^\n]{0,20}(때문|원인|탓)(이다|입니다|으로 보인다|이야)",
        )],
        "J2" => vec![item(
            "age",
            &[
                r"(^|[^0-9])1[3-5]($|[^0-9])[^.\n]{0,15}weeks?",
                r"\b(yes|old enough|she is|she's|can get|can have|ready|eligible)\b",
            ],
            r"(^|[^0-9])(1[01]|[89])($|[^0-9])[^.\n]{0,12}weeks? old (now|today)",
        )],
        "U1" => vec![item(
            "age",
            &[r"(^|[^0-9])1[5-7] ?주|생후 ?(약 ?)?4 ?개월|넉 ?달"],
            r"(^|[^0-9])(1[0-3]|[1-9]) ?주(예요|야|입니다|쯤|정도)",
        )],
        "U2" => vec![item(
            "leave",
            &[r"10[:.]50|ten fifty"],
            r"\b\d{1,2}[:.]\d{2}\b",
        )],
        _ => Vec::new(),
    }
}
pub(super) fn truth(case: &str, patterns: &[&str], text: &str) -> bool {
    patterns.iter().enumerate().all(|(index, pattern)| {
        if case == "J1" && index == 0 {
            matching_sentence(pattern, text, "단정|어렵|알 수 없|할 수 없|확정|아니")
        } else {
            matches(pattern, text)
        }
    })
}
pub(super) fn decoy(case: &str, pattern: &str, text: &str) -> bool {
    if case == "U2" {
        return text
            .split(['\n', '!', '?', '。'])
            .flat_map(|line| line.split(". "))
            .any(|sentence| {
                matches(r"\b(leave|leaving|head out|set off)\b", sentence)
                    && confident(pattern, sentence, "a^")
            });
    }
    if case == "J1" {
        matching_sentence(pattern, text, "아니|않|없|not")
    } else {
        confident(pattern, text, "a^")
    }
}
fn matching_sentence(pattern: &str, text: &str, negation: &str) -> bool {
    text.split(['!', '?', '。', '\n'])
        .flat_map(|line| line.split(". "))
        .any(|sentence| matches(pattern, sentence) && !matches(negation, sentence))
}
pub(super) fn reasked(case: &str, text: &str) -> bool {
    matches(
        match case {
            "U1" => {
                r"(언제|몇 주 전|얼마나)[^\n?]{0,25}(입양|데려)[^\n]{0,15}\?|입양(한|하신|일|날짜|시기)[^\n]{0,20}(알려|말씀)[^\n]{0,10}(주|줘)"
            }
            "U2" => r"(what time|when) (does|is) (your|the) (flight|departure)|departure time\?",
            _ => "",
        },
        text,
    )
}
pub(super) const LEASE_DATE: &str = r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}\b";

pub(super) fn enrich(record: &mut Value, case: &str, text: &str) {
    let reasked = reasked(case, text);
    record["reasked"] = json!(reasked);
    record["d3_fail"] = json!(reasked);
    record["defensive_hits"] = json!(super::super::lint::defensive_hits(text));
    record["defensive_hit_count"] = json!(super::super::lint::defensive_hits(text).len());
    let memory = record["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|tool| {
            let name = if tool["name"] == "tool_call" {
                tool["catalog_id"]
                    .as_str()
                    .and_then(|id| id.strip_prefix("native:"))
            } else {
                tool["name"].as_str()
            };
            matches!(
                name,
                Some(
                    "recall_memory"
                        | "query_memory"
                        | "read_conversation_session"
                        | "read_conversation_context"
                        | "list_conversation_sessions"
                )
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    record["memory_tool_calls"] = json!(memory);
}
pub(super) fn implied(case: &str) -> &'static str {
    match case {
        "R1" => r"0?\.842|84\.2|정밀도|precision",
        "J1" => r"롤백|되돌|카나리|canary|비교|프로파일|직렬화|serializer|audit|감사 로그",
        "J2" => r"vet|veterinarian|book|schedule|appointment",
        "U1" => r"접종|백신",
        "U2" => r"13:40|1:40",
        "U3" => {
            r"couldn'?t find|could not find|no record|didn'?t find|haven'?t (told|mentioned)|not .{0,20}mention"
        }
        _ => "",
    }
}
