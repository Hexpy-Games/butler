//! RM-01–RM-05 drive the real tool executor and cards with a scripted provider.
use super::*;
mod delegated;
mod guards;
mod ordering;
mod projection;

fn call(name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{name}"),"call_id":format!("call_{name}"),
        "name":name,"arguments":args.to_string(),"status":"completed"})
}
fn reply(text: &str) -> Value {
    json!({"type":"message","id":"msg_rm","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]})
}
fn script(script: &stub::Script, message: &str, rounds: Vec<Value>) {
    script.replies.lock().unwrap().insert(
        message.split_whitespace().collect::<Vec<_>>().join(" "),
        rounds,
    );
}
fn resolve(id: &Value, outcome: &str, answer: &str, quote: &str) -> Value {
    call(
        "resolve_ask",
        &json!({"ask_id":id,"outcome":outcome,"answer":answer,"quote":quote}),
    )
}
fn source(request: &Value) -> &str {
    request["input"][0]["content"][0]["text"].as_str().unwrap()
}
fn reminder(request: &Value) -> Value {
    let source = source(request);
    let start = source.find("## Open asks").expect("volatile reminder");
    let tail = &source[start..];
    let line = tail.lines().find(|line| line.starts_with('{')).unwrap();
    serde_json::from_str(line).unwrap()
}
fn results(script: &stub::Script) -> Vec<Value> {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .flat_map(|r| r["input"].as_array().unwrap().iter())
        .filter(|i| i["type"] == "function_call_output")
        .filter_map(|i| {
            i["output"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
        })
        .map(|r| r.get("output").cloned().unwrap_or(r))
        .collect()
}
async fn named_ask(
    s: &Scenario,
    script_: &stub::Script,
    title: &str,
) -> Result<Value, HarnessError> {
    named_ask_with_questions(s, script_, title, crate::ask_user::stub::questions()).await
}
async fn named_ask_with_questions(
    s: &Scenario,
    script_: &stub::Script,
    title: &str,
    mut args: Value,
) -> Result<Value, HarnessError> {
    let message = format!("Keep this choice on an open card: {title}");
    args["questions"][0]["title"] = json!(title);
    args["wait"] = json!(false);
    let card_title = args["questions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| q["title"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join(" · ");
    script(
        script_,
        &message,
        vec![call("ask_user", &args), reply("Saved.")],
    );
    let (_, turn) = s.turn("general", &message).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let page = asks(s, "general").await?;
    Ok(page["asks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["title"] == card_title)
        .unwrap()
        .clone())
}
#[tokio::test]
async fn rm_01_unrelated_reply_uses_one_closing_line_without_reasking() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, provider, server) = setup("RM-01").await?;
    named_ask(&s, &provider, "Destination").await?;
    let second = named_ask(&s, &provider, "Format").await?;
    let message = "What is two plus two?";
    let text = "Four.\nStill open: Format, Destination.";
    script(&provider, message, vec![reply(text)]);
    provider.requests.lock().unwrap().clear();
    let (_, turn) = s.turn("general", message).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = provider.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    let prompt = source(&requests[0]);
    assert!(prompt.find("## Current turn context").unwrap() < prompt.find("## Open asks").unwrap());
    assert!(prompt.find("## Open asks").unwrap() < prompt.find("## Current request").unwrap());
    assert!(prompt.contains("end the reply with one short line naming up to three by title. Never repeat a question in full or ask it again"));
    assert_eq!(
        reminder(&requests[0])["open"][0]["ask_id"],
        second["ask_id"]
    );
    assert_eq!(reminder(&requests[0])["open"].as_array().unwrap().len(), 2);
    assert_eq!(asks(&s, "general").await?["open_count"], 2);
    assert_answer(&s, text).await?;
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn rm_02_chat_answer_settles_only_the_named_ask_and_updates_its_card()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, provider, server) = setup("RM-02").await?;
    let first = named_ask(&s, &provider, "Destination").await?;
    let mut questions = crate::ask_user::stub::questions();
    let mut other = questions["questions"][0].clone();
    other["id"] = json!("details");
    other["title"] = json!("Which details?");
    questions["questions"].as_array_mut().unwrap().push(other);
    let second = named_ask_with_questions(&s, &provider, "Format", questions).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let message = "두 번째는\n A로";
    script(
        &provider,
        message,
        vec![
            resolve(&second["ask_id"], "answered", "A", "두 번째는 A로"),
            reply("A로 정했습니다.\n남은 항목: Destination."),
        ],
    );
    provider.requests.lock().unwrap().clear();
    let (_, turn) = s.turn("general", message).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    event(&live, &second["ask_id"], "resolved_in_chat").await?;
    assert_eq!(
        asks(&s, "general").await?["asks"][0]["ask_id"],
        first["ask_id"]
    );
    assert!(
        results(&provider)
            .iter()
            .any(|r| r["ok"] == true && r["state"] == "resolved_in_chat"),
        "{:?}",
        results(&provider)
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    let answers = view.data()["question_answers"].as_array().unwrap();
    let answer = answers
        .iter()
        .find(|a| {
            a["request_ref"]
                == second["ask_id"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("question:")
                    .unwrap()
        })
        .unwrap();
    assert_eq!(answer["response"]["answers"][0]["custom"], "A");
    let answers = answer["response"]["answers"].as_array().unwrap();
    assert_eq!(answers.len(), 2);
    assert_eq!(answers.iter().filter(|a| a["custom"] == "A").count(), 1);
    assert_eq!(answers[1]["skipped"], true);
    assert_eq!(answers[1]["custom"], Value::Null);
    // The already settled ask must return its persisted state on another attempt.
    script(
        &provider,
        "A again",
        vec![
            resolve(&second["ask_id"], "answered", "A", "A"),
            reply("Already settled."),
        ],
    );
    s.turn("general", "A again").await?;
    let requests = provider.requests.lock().unwrap().clone();
    assert_eq!(
        reminder(requests.last().unwrap())["open"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(results(&provider).iter().any(|r| {
        r["error"]["code"] == "ask_not_open"
            && r["error"]["message"]
                .as_str()
                .unwrap()
                .contains("resolved_in_chat")
    }));
    let before = s.gw.turns("general").await?.len();
    s.restart().await?;
    s.turn("general", "Continue after restarting.").await?;
    assert_eq!(s.gw.turns("general").await?.len(), before + 1);
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert!(view.data()["messages"].as_array().unwrap().iter().all(|m| {
        !m["text"]
            .as_str()
            .unwrap_or("")
            .starts_with("Answers to your deferred questions")
    }));
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn rm_03_dropped_ask_stays_absent_for_three_turns_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, provider, server) = setup("RM-03").await?;
    let question = named_ask(&s, &provider, "Destination").await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    script(
        &provider,
        "그건 됐어",
        vec![
            resolve(&question["ask_id"], "dropped", "", "그건 됐어"),
            reply("알겠습니다."),
        ],
    );
    s.turn("general", "그건 됐어").await?;
    event(&live, &question["ask_id"], "dismissed").await?;
    s.restart().await?;
    for message in [
        "First unrelated question",
        "Second unrelated question",
        "Third unrelated question",
    ] {
        provider.requests.lock().unwrap().clear();
        s.turn("general", message).await?;
        assert!(
            provider
                .requests
                .lock()
                .unwrap()
                .iter()
                .all(|r| !source(r).contains("## Open asks"))
        );
        assert_eq!(asks(&s, "general").await?["open_count"], 0);
    }
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["question_answers"], json!([]));
    server.abort();
    s.finish().await
}
async fn assert_answer(s: &Scenario, text: &str) -> Result<(), HarnessError> {
    let view = s.gw.get("/session-view?session_id=general").await?;
    let messages = view.data()["messages"].as_array().unwrap();
    let last = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "assistant")
        .unwrap();
    assert_eq!(last["text"], text);
    Ok(())
}
