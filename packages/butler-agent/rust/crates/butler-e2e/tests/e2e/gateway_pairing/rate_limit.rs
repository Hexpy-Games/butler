use super::helpers::*;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};

#[tokio::test]
async fn sec_17_repeated_wrong_codes_get_429_with_retry_after() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-17")?.data_folder_token().start().await?;
    let app = admin(&s);
    let browser = browser();
    let pin = issue(&app).await?;
    let (paired, answer) = tokio::join!(
        connect(&s.gw, &browser, pin["code"].as_str().unwrap()),
        app.answer_pairing(Some("47")),
    );
    answer?;
    let paired = paired?;
    assert_eq!(paired.status().as_u16(), 303);

    issue(&app).await?;
    for _ in 0..10 {
        rejected(&s.gw, &browser, "00000000").await?;
    }

    let pin = issue(&app).await?;
    let code = pin["code"].as_str().unwrap();
    let response = browser
        .post(format!("{}/devices/pair", s.gw.base))
        .json(&json!({"code": code, "device_name": "Test phone", "platform": "ios", "match_code": "47"}))
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 429);
    let retry_after = response.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert!((1..=60).contains(&retry_after));
    assert_eq!(
        response.json::<Value>().await?["error"]["code"],
        "rate_limited"
    );
    assert_eq!(devices(&app).await?.as_array().unwrap().len(), 1);

    let response = browser
        .post(format!("{}/connect", s.gw.base))
        .header("accept", "text/html")
        .header("origin", &s.gw.base)
        .header("sec-fetch-site", "same-origin")
        .form(&[("code", code), ("match_code", "47")])
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 429);
    assert!(response.headers().contains_key("retry-after"));
    assert!(response.text().await?.contains("Too many attempts"));
    s.finish().await
}
