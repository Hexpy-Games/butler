//! Non-gating lint for handback and avoidance language in live answers.
use std::sync::OnceLock;

use regex::Regex;

/// Names of hedge patterns found in an answer, once per pattern.
#[expect(clippy::expect_used, reason = "literal regex patterns are valid")]
pub fn hits(text: &str) -> Vec<&'static str> {
    static PATTERNS: OnceLock<Vec<(&str, Regex)>> = OnceLock::new();
    let sentences = sentences(text);
    PATTERNS
        .get_or_init(|| {
            [
                (
                    "verify_yourself",
                    r"verify (it |this |that |them )?(yourself|on your own)",
                ),
                ("please_check", r"\bplease (check|verify|confirm)\b"),
                (
                    "did_not_check",
                    r"\bI (did not|didn't|could not|couldn't) (check|verify|confirm)",
                ),
                (
                    "not_confirmed",
                    r"\b(is|are|was|were) not (confirmed|verified)\b",
                ),
                ("unconfirmed", r"\bunconfirmed\b"),
                ("could_not_read", r"\b(could|can) ?not read\b|\bunable to read\b"),
                ("ko_unconfirmed", r"미확(인|정|보)"),
                ("ko_cannot_guarantee", r"보장(할 수|하지|은|은 하지)? ?(못|없|않)"),
                ("ko_could_not_check", r"확인(을|은|이)? ?(못|할 수 없|하기 어렵|이 어렵)"),
                ("unverified", r"\bunverified\b"),
                ("could_not_be", r"\b(could|can) ?not be (verified|confirmed|determined)\b|\bunable to (verify|confirm)\b|\bnot (been )?(verified|confirmed|tested) yet\b"),
                (
                    "cannot_assert",
                    r"\bI (won't|will not|cannot|can't) (assert|guarantee)",
                ),
                ("seemed_unsafe", r"\b(looked|seemed) (suspicious|unsafe)\b"),
                ("ko_direct_check", r"직접 확인"),
                ("ko_please_check", r"확인해 (보세요|주세요|보시)"),
                ("ko_not_checked", r"확인(하지|되지) (않았|않은|못했)"),
                ("ko_not_verified", r"검증(하지|되지) (않았|못했)"),
                ("ko_cannot_assert", r"단정(하지|할 수) (않|없)"),
                (
                    "ko_suspicious_avoidance",
                    r"의심스러[워운].{0,20}(건드리지|손대지|열지)",
                ),
            ]
            .into_iter()
            .map(|(name, pattern)| {
                (
                    name,
                    Regex::new(&format!("(?i){pattern}")).expect("static hedge pattern"),
                )
            })
            .collect()
        })
        .iter()
        .filter_map(|(name, pattern)| sentences.iter().any(|line| pattern.is_match(line)).then_some(*name))
        .collect()
}

/// Remove fenced blocks before splitting so their punctuation is never prose.
#[expect(clippy::expect_used, reason = "literal regex patterns are valid")]
fn sentences(text: &str) -> Vec<String> {
    static EXCLUSIONS: OnceLock<Vec<Regex>> = OnceLock::new();
    let exclusions = EXCLUSIONS.get_or_init(|| {
        [
            r"미안|죄송|내 실수|제 실수|잘못(했|이었|된 판단)|sorry|my mistake|I should have",
            r"`[^`]{1,80}`[^.!?\n]{0,40}(검증|확인)(하지|되지) 않(는|음|습니다|다)",
        ]
        .map(|pattern| Regex::new(&format!("(?i){pattern}")).expect("static exclusion"))
        .to_vec()
    });
    let mut fence: Option<(char, usize)> = None;
    let mut prose = String::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'));
        let count = marker.map_or(0, |c| trimmed.chars().take_while(|v| *v == c).count());
        if count >= 3 {
            match fence {
                None => fence = marker.map(|c| (c, count)),
                Some((c, n)) if marker == Some(c) && count >= n => fence = None,
                _ => {}
            }
        } else if fence.is_none() {
            prose.push_str(line);
            prose.push('\n');
        }
    }
    prose
        .split(['.', '!', '?', '。', '\n'])
        .filter(|line| !exclusions.iter().any(|pattern| pattern.is_match(line)))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: pure-logic
    #[test]
    fn new_patterns_and_sentence_exclusions() {
        for (name, sentence) in [
            ("ko_unconfirmed", "결과는 미확인입니다"),
            ("ko_cannot_guarantee", "보장할 수 없습니다"),
            ("ko_could_not_check", "확인하기 어렵습니다"),
            ("unverified", "The result is unverified"),
            ("could_not_read", "could not read the notice"),
            ("could_not_be", "The result could not be confirmed"),
        ] {
            assert!(hits(sentence).contains(&name), "{name}");
        }
        assert_eq!(hits("Sorry, the result is unverified"), Vec::<&str>::new());
        assert_eq!(hits("`value` 확인되지 않습니다"), Vec::<&str>::new());
        assert_eq!(hits("미안, 확인할 수 없습니다"), Vec::<&str>::new());
        assert_eq!(
            hits("~~~text\nUnverified!\n~~~\n```\n직접 확인\n```"),
            Vec::<&str>::new()
        );
        assert_eq!(
            hits("Unverified. Sorry, unverified. UNVERIFIED"),
            ["unverified"]
        );
        assert_eq!(
            hits("Sorry, unverified. The result is unconfirmed"),
            ["unconfirmed"]
        );
    }

    // test-category: pure-logic
    #[test]
    fn existing_patterns_still_match() {
        for (name, sentence) in [
            ("verify_yourself", "Verify it yourself"),
            ("please_check", "Please check the result"),
            ("did_not_check", "I didn't check"),
            ("not_confirmed", "Results are not confirmed"),
            ("unconfirmed", "Unconfirmed result"),
            ("cannot_assert", "I cannot guarantee"),
            ("seemed_unsafe", "It seemed unsafe"),
            ("ko_direct_check", "직접 확인"),
            ("ko_please_check", "확인해 주세요"),
            ("ko_not_checked", "확인하지 않았습니다"),
            ("ko_not_verified", "검증하지 못했습니다"),
            ("ko_cannot_assert", "단정할 수 없습니다"),
            ("ko_suspicious_avoidance", "의심스러워 건드리지 않았습니다"),
        ] {
            assert!(hits(sentence).contains(&name), "{name}");
        }
    }
}
