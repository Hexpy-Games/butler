use super::*;
use butler_e2e::e2e::cassette::{Cassette, Chunk, ResponseRecord};
pub(super) const TASK: &str = "Compare prices and reach checkout";

pub(super) fn commit() -> Value {
    json!([{"action":"click","ref":"f0-e90","commits":true}])
}

pub(super) fn cassette(failed: bool) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = if failed {
        vec![call(
            "browse",
            &json!({"goal":"Find price","url":"https://store.example/listing","fields":["price"]}),
            "price",
        )]
    } else {
        vec![
            call(
                "browse",
                &json!({"goal":"Find price","url":"https://store.example/listing","fields":["price","invented"]}),
                "price",
            ),
            call(
                "browse",
                &json!({"goal":"Reach checkout","url":"https://store.example/cart"}),
                "checkout",
            ),
        ]
    };
    let mut first = template.exchanges[0].clone();
    first.request.key.user_request = TASK.into();
    first.request.key.round.clear();
    first.response = response(&calls);
    cassette.exchanges.push(first);
    let mut round = vec![];
    round.extend(vec!["function_call".into(); calls.len()]);
    round.extend(vec!["function_call_output".into(); calls.len()]);
    if !failed {
        let mut approve = template.exchanges[0].clone();
        approve.request.key.user_request = TASK.into();
        approve.request.key.round = round.clone();
        approve.response = response(&[call(
            "browser_act",
            &json!({"tab":"cart","observation":"cart-o2","steps":commit()}),
            "approval",
        )]);
        cassette.exchanges.push(approve);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    if failed {
        let mut fallback = template.exchanges[0].clone();
        fallback.request.key.user_request = TASK.into();
        fallback.request.key.round = round.clone();
        fallback.response = response(&[call(
            "browser_act",
            &json!({"tab":"listing","observation":"listing-o1","steps":[{"action":"wait","value":"50"}]}),
            "fallback",
        )]);
        cassette.exchanges.push(fallback);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = TASK.into();
    last.request.key.round = round;
    last.response = message("Done");
    cassette.exchanges.push(last);
    let replies = if failed {
        vec![]
    } else {
        vec![
            (
                "Find price",
                json!({"notes":"","next":{"act":{"steps":[{"action":"wait","value":"50"}]}}}),
            ),
            (
                "Find price",
                json!({"notes":"","next":{"open":{"url":"https://store.example/product-a"}}}),
            ),
            (
                "Find price",
                json!({"notes":"Product A costs 18.","next":{"open":{"url":"https://store.example/product-b"}}}),
            ),
            (
                "Find price",
                json!({"notes":"","next":{"read":{"query":"가격 price","start_chunk":0}}}),
            ),
            (
                "Find price",
                json!({"notes":"","next":{"done":{"fields":{"price":"12","invented":"missing"},"evidence":[{"field":"price","quote":"Price 12"},{"field":"invented","quote":"fabricated quotation"}],"summary":"Found the price."}}}),
            ),
            (
                "Reach checkout",
                json!({"notes":"","next":{"act":{"steps":[{"action":"click","ref":"f0-e90"}]}}}),
            ),
            (
                "Reach checkout",
                json!({"notes":"","next":{"act":{"steps":commit()}}}),
            ),
        ]
    };
    if failed {
        let mut exchange = template.exchanges[1].clone();
        exchange.request.key.user_request = "Find price".into();
        exchange.request.key.round.clear();
        exchange.response = ResponseRecord { status: 400, headers: vec![], chunks: vec![Chunk { delay_ms: 0, text: json!({"error":{"message":"fixture unavailable","type":"invalid_request_error"}}).to_string() }] };
        cassette.exchanges.push(exchange);
    }
    for (goal, reply) in replies {
        let mut exchange = template.exchanges[1].clone();
        exchange.request.key.user_request = goal.into();
        exchange.request.key.round.clear();
        exchange.response = message(&format!("Executor reply:\n```json\n{reply}\n```\n"));
        cassette.exchanges.push(exchange);
    }
    Ok(cassette)
}

pub(super) fn call(name: &str, args: &Value, id: &str) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}

pub(super) fn message(text: &str) -> ResponseRecord {
    response(&[
        json!({"type":"message","id":"msg_browse","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]} ]}),
    ])
}

pub(super) fn response(items: &[Value]) -> ResponseRecord {
    let mut record = crate::browser_usage::stub::response(&items[0]);
    if items.len() == 1 {
        return record;
    }
    let mut events: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let single = crate::browser_usage::stub::response(item);
        for (n, chunk) in single.chunks.iter().enumerate() {
            let data = chunk
                .text
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap();
            let mut event: Value = serde_json::from_str(data).unwrap();
            if event["type"] == "response.completed" {
                continue;
            }
            if index > 0 && n == 0 {
                continue;
            }
            if event.get("output_index").is_some() {
                event["output_index"] = json!(index);
            }
            event["sequence_number"] = json!(events.len());
            events.push(event);
        }
    }
    let data = record
        .chunks
        .last()
        .unwrap()
        .text
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let mut done: Value = serde_json::from_str(data).unwrap();
    done["response"]["output"] = json!(items);
    done["sequence_number"] = json!(events.len());
    events.push(done);
    record.chunks = events
        .into_iter()
        .map(|event| Chunk {
            delay_ms: 0,
            text: format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            ),
        })
        .collect();
    record
}

pub(super) fn payment_cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let mut first = template.exchanges[0].clone();
    first.request.key.user_request = "Inspect checkout".into();
    first.request.key.round.clear();
    first.response = response(&[call(
        "browse",
        &json!({"goal":"Review order","url":"https://store.example/checkout"}),
        "payment",
    )]);
    cassette.exchanges.push(first);
    let mut executor = template.exchanges[1].clone();
    executor.request.key.user_request = "Review order".into();
    executor.request.key.round.clear();
    executor.response = message(
        &json!({"notes":"","next":{"act":{"steps":[{"action":"click","ref":"f0-e90"}]}}})
            .to_string(),
    );
    cassette.exchanges.push(executor);
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Inspect checkout".into();
    last.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    last.response = message("Order awaits the planner.");
    cassette.exchanges.push(last);
    Ok(cassette)
}
