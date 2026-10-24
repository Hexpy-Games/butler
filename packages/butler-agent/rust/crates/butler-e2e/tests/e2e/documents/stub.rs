use super::*;
use butler_e2e::e2e::cassette::Cassette;
pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    let template = cassette.exchanges[0].clone();
    cassette.exchanges.clear();
    for (prompt, calls) in [
        (
            CREATE,
            vec![
                ("tool_describe", json!({"ids":["native:document_create"]})),
                (
                    "tool_call",
                    json!({"id":"native:document_create","arguments":{"title":"Report","body":"```blocks\n{\"v\":9,\"blocks\":[]}\n```"}}),
                ),
                (
                    "tool_call",
                    json!({"id":"native:document_create","arguments":{"title":"Report","body":body()}}),
                ),
            ],
        ),
        (
            READ,
            vec![
                ("tool_describe", json!({"ids":["native:document_read"]})),
                (
                    "tool_call",
                    json!({"id":"native:document_read","arguments":{"id":"{{DOC_ECHO_1}}"}}),
                ),
            ],
        ),
        (
            EDIT,
            vec![
                (
                    "tool_describe",
                    json!({"ids":["native:document_edit","native:document_read"]}),
                ),
                (
                    "tool_call",
                    json!({"id":"native:document_edit","arguments":{"id":"{{DOC_ECHO_1}}","base_rev":1,"ops":[{"anchor":"Original line","replace":"Overwrite"}]}}),
                ),
                (
                    "tool_call",
                    json!({"id":"native:document_edit","arguments":{"id":"{{DOC_ECHO_1}}","base_rev":1,"ops":[{"anchor":" ","replace":"x"}]}}),
                ),
                (
                    "tool_call",
                    json!({"id":"native:document_edit","arguments":{"id":"{{DOC_ECHO_1}}","base_rev":1,"ops":[{"anchor":"Untouched paragraph","replace":"x"},{"anchor":"paragraph","replace":"y"}]}}),
                ),
                (
                    "tool_call",
                    json!({"id":"native:document_edit","arguments":{"id":"{{DOC_ECHO_1}}","base_rev":1,"ops":[{"anchor":"Untouched paragraph","replace":"Butler updated paragraph"}]}}),
                ),
                (
                    "tool_call",
                    json!({"id":"native:document_read","arguments":{"id":"{{DOC_ECHO_1}}"}}),
                ),
            ],
        ),
    ] {
        let mut round = Vec::new();
        for (index, call) in calls
            .iter()
            .enumerate()
            .map(|(i, c)| (i, Some(c)))
            .chain(std::iter::once((calls.len(), None)))
        {
            let mut exchange = template.clone();
            exchange.request.key.user_request = prompt.into();
            exchange.request.key.round = round.clone();
            let item = match call {
                Some((name, args)) => {
                    json!({"type":"function_call","id":format!("fc_doc_{index}"),"call_id":format!("call_doc_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"})
                }
                None => {
                    json!({"type":"message","id":"msg_doc","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Ready.","annotations":[]}]})
                }
            };
            exchange.response = crate::browser_usage::stub::response(&item);
            cassette.exchanges.push(exchange);
            round.extend(["function_call".into(), "function_call_output".into()]);
        }
    }
    Ok(cassette)
}
