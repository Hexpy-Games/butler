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

/// Self-protective disclaimer patterns, once per answer.
#[expect(clippy::expect_used, reason = "literal regex patterns are valid")]
pub fn defensive_hits(text: &str) -> Vec<&'static str> {
    static PATTERNS: OnceLock<Vec<(&str, Regex)>> = OnceLock::new();
    static EXCLUSION: OnceLock<Regex> = OnceLock::new();
    let exclusion = EXCLUSION.get_or_init(|| {
        Regex::new(
            r"(?i)미안|죄송|내 실수|제 실수|잘못\s*(했|이었|된 판단|짚|받아)|sorry|my mistake",
        )
        .expect("static defensive exclusion")
    });
    let sentences = defensive_sentences(text);
    PATTERNS
        .get_or_init(|| {
            defensive_patterns()
                .into_iter()
                .map(|(name, pattern)| {
                    (
                        name,
                        Regex::new(&format!("(?i){pattern}")).expect("static defensive pattern"),
                    )
                })
                .collect()
        })
        .iter()
        .filter_map(|(name, pattern)| {
            sentences
                .iter()
                .any(|sentence| !exclusion.is_match(sentence) && pattern.is_match(sentence))
                .then_some(*name)
        })
        .collect()
}
fn defensive_patterns() -> [(&'static str, &'static str); 10] {
    [
        (
            "ko_cannot_assert",
            r"단정(할 수 ?(는|도)? ?없|하기(는|엔)? 어렵|하지(는|도)? 않|할 단계(는|가)? 아니|짓기 어렵)",
        ),
        (
            "ko_not_confirmed_fact",
            r"확정(할 수 ?(는|도)? ?없|하기(는)? 어렵|(된|적인) (것|사실|판단|결론)(은|이)? 아니|해서 전달할 단계)",
        ),
        (
            "ko_cannot_say",
            r"(말할|보고할|주장할|판단할|결론 ?내릴|평가할|간주할) 수(는|도)? 없|라고 (보기|하기|말하기)(는|엔)? 어렵|주장하지(는)? 않",
        ),
        (
            "ko_not_guarantee",
            r"보장(하지|할 수 ?(는)? ?없|하는 (것|변경)은 아니|되지(는)? 않|하진 않)",
        ),
        (
            "ko_not_independently",
            r"독립적으로[^.。\n]{0,30}(검증|확인)하지",
        ),
        (
            "ko_not_marked",
            r"(완료|완성)(했다고|로|된 것으로)[^.。\n]{0,12}(처리하지|보시면 안|간주하면 안|볼 수 없)",
        ),
        ("ko_reading_caution", r"(읽|보|해석하)(으)?면 안 된다"),
        (
            "en_cannot",
            r"\b(cannot|can't|could not|can not) (be )?(claim|conclude|say|guarantee|assert|determine|confirm) ",
        ),
        (
            "en_not_guarantee",
            r"\b(does not|doesn't|do not|is not a|no) (guarantee|prove)\b|\bnot (a )?(definitive|settled|complete) (judgment|fact|answer)",
        ),
        (
            "en_not_marked",
            r"\bnot (marked|treated|reported) (it |this |the \w+ )?as (complete|done|finished)",
        ),
    ]
}
fn defensive_sentences(text: &str) -> Vec<String> {
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
    let mut result = Vec::new();
    let mut start = 0;
    let mut chars = prose.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        if c == '\n'
            || (matches!(c, '.' | '!' | '?' | '。')
                && chars.peek().is_some_and(|(_, next)| next.is_whitespace()))
        {
            result.push(prose[start..index + c.len_utf8()].to_owned());
            start = index + c.len_utf8();
        }
    }
    result.push(prose[start..].to_owned());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: pure-logic
    #[test]
    fn defensive_patterns_and_self_correction() {
        for (text, name) in [
            (
                "일반적인 정확도 향상을 보장하지는 않는다.",
                "ko_not_guarantee",
            ),
            ("전체 요청을 완료했다고 처리하지 않았다.", "ko_not_marked"),
            (
                "산출물을 독립적으로 다시 검증하지는 못했다.",
                "ko_not_independently",
            ),
            ("아직 단정하기 어렵다.", "ko_cannot_assert"),
            ("개선됐다고 말할 수 없다.", "ko_cannot_say"),
            ("확정된 사실은 아니다.", "ko_not_confirmed_fact"),
            (
                "This does not guarantee better latency.",
                "en_not_guarantee",
            ),
            ("We cannot conclude that it improved.", "en_cannot"),
            ("I have not marked it as complete.", "en_not_marked"),
        ] {
            assert_eq!(defensive_hits(text), [name]);
            assert_eq!(defensive_hits(&format!("{text} {text}")), [name]);
        }
        for text in [
            "The fix shipped and tests pass.",
            "제가 잘못 짚었어요, 단정할 수 없다고 한 건 실수예요.",
            "```text\nWe cannot conclude that it improved.\n```",
        ] {
            assert_eq!(defensive_hits(text), [] as [&str; 0], "{text}");
        }
    }

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
