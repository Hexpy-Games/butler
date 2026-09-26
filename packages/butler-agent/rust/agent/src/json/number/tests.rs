use super::*;

#[test]
fn json_number_coercions_match_actual_bun_bits() {
    let cases: Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let result = coerce_number(&case["input"]);
        if case.get("throws").is_some() {
            assert!(result.is_err(), "{}", case["input"]);
            continue;
        }
        let number = result.unwrap();
        let observed = if number.is_nan() {
            "nan".to_owned()
        } else {
            format!("{:016x}", number.to_bits())
        };
        assert_eq!(
            observed,
            case["bits"].as_str().unwrap(),
            "{}",
            case["input"]
        );
    }
}
