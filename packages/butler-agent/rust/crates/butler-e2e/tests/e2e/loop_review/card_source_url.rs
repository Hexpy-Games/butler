//! A card source copied with the closing parenthesis of the sentence around
//! it is delivered without it; parentheses that belong to the URL stay.
use super::common::run;
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use serde_json::json;

#[tokio::test]
async fn card_source_ends_where_the_url_ends() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let spec = json!({"v":2,"blocks":[{"type":"cards","id":"pages","items":[
        {"title":"Relic","source":"https://example.org/view.do?relicId=26277)"},
        {"title":"Moon","source":"https://en.wikipedia.org/wiki/Moon_(disambiguation)"}]}]});
    let r = run(
        "CARD-SOURCE-URL",
        vec![
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"blocks_1","type":"function",
                "function":{"name":"answer_blocks","arguments":spec.to_string()}}]}),
            json!({"role":"assistant","content":"Both pages are below."}),
        ],
        "Show the two pages as cards.",
    )
    .await?;
    let reply = r.reply.unwrap_or_default();
    assert_eq!(turn_state(&r.turn), "delivered", "{}", r.turn);
    let items = &reply["answer_blocks"][0]["spec"]["blocks"][0]["items"];
    assert_eq!(
        items[0]["source"], "https://example.org/view.do?relicId=26277",
        "{reply}"
    );
    assert_eq!(
        items[1]["source"], "https://en.wikipedia.org/wiki/Moon_(disambiguation)",
        "{reply}"
    );
    Ok(())
}
