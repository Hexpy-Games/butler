use super::*;
use butler_e2e::e2e::cassette::Cassette;

pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    let template = cassette.exchanges[0].clone();
    cassette.exchanges.clear();
    for (prompt, calls) in [
        (
            RESEARCH,
            vec![
                ("tool_describe", json!({"ids":["native:document_create"]})),
                (
                    "tool_call",
                    json!({"id":"native:document_create","arguments":{"title":TITLE,"body":body()}}),
                ),
            ],
        ),
        (FOLLOW, vec![]),
        (OTHER, vec![]),
    ] {
        let mut round = Vec::new();
        for index in 0..=calls.len() {
            let mut exchange = template.clone();
            exchange.request.key.user_request = prompt.into();
            exchange.request.key.round = round.clone();
            let item = if let Some((name, args)) = calls.get(index) {
                json!({"type":"function_call","id":format!("fc_ss1_{index}"),"call_id":format!("call_ss1_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"})
            } else {
                json!({"type":"message","id":"msg_ss1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"The research is ready. Key findings are in the document.","annotations":[]}]})
            };
            exchange.response = crate::browser_usage::stub::response(&item);
            cassette.exchanges.push(exchange);
            round.extend(["function_call".into(), "function_call_output".into()]);
        }
    }
    Ok(cassette)
}
