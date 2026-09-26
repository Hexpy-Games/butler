use super::*;

#[derive(serde::Deserialize)]
struct Fixture {
    locale: String,
    cases: Vec<Case>,
}
#[derive(serde::Deserialize)]
struct Case {
    input: Value,
    effect: String,
    authority: String,
}

#[test]
fn sorted_json_matches_bun_effect_and_authority_codecs() {
    let fixture: Fixture = serde_json::from_str(include_str!("sorted-bun-golden.json")).unwrap();
    let collation = crate::locale::LocaleCollation::new(&fixture.locale).unwrap();
    for case in fixture.cases {
        let before = stringify(&case.input).unwrap();
        assert_eq!(
            stringify_sorted(&case.input, &|left, right| left
                .encode_utf16()
                .cmp(right.encode_utf16()))
            .unwrap(),
            case.effect
        );
        assert_eq!(
            stringify_sorted(&case.input, &|left, right| collation.compare(left, right)).unwrap(),
            case.authority
        );
        assert_eq!(stringify(&case.input).unwrap(), before);
    }
}

#[test]
fn sorted_json_preserves_collation_ties_and_distinct_unicode_keys() {
    let input: Value =
        serde_json::from_str(r#"{"é":"é","é":"é","10":"ten","2":"two","nested":{"z":1,"a":2}}"#)
            .unwrap();
    assert_eq!(
        stringify_sorted(&input, &|_, _| std::cmp::Ordering::Equal).unwrap(),
        r#"{"2":"two","10":"ten","é":"é","é":"é","nested":{"z":1,"a":2}}"#
    );
}
