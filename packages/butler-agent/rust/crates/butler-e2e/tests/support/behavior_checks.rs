use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::fs;

pub(super) fn tokens(request: &Value) -> Value {
    let count = |s: &str| tiktoken_rs::o200k_base_singleton().encode_ordinary(s).len();
    json!({"instructions":count(request["instructions"].as_str().unwrap_or_default()),
        "tools":count(&request["tools"].to_string()),"input":count(&request["input"].to_string()),
        "serialized":count(&request.to_string())})
}

pub(super) fn render(request: &Value) -> String {
    let mut text = format!(
        "{}\n\n",
        request["instructions"].as_str().unwrap_or_default()
    );
    for item in request["input"].as_array().into_iter().flatten() {
        text.push_str(&format!(
            "\n[{}]\n",
            item["role"].as_str().unwrap_or("tool")
        ));
        if let Some(content) = item["content"].as_str() {
            text.push_str(content);
        }
        for part in item["content"].as_array().into_iter().flatten() {
            if let Some(content) = part["text"].as_str() {
                text.push_str(content);
            }
        }
    }
    text
}

fn sql<T>(value: rusqlite::Result<T>) -> Result<T, HarnessError> {
    value.map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))
}

pub(super) fn calls(s: &Scenario, turn: &str) -> Result<Vec<Value>, HarnessError> {
    let db = sql(rusqlite::Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    ))?;
    let mut query = sql(db.prepare("SELECT tool_name, arguments_json, status, error_code, result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 ORDER BY turn_sequence, call_id"))?;
    let rows = sql(query.query_map([turn], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    }))?;
    let mut out = Vec::new();
    for row in rows {
        let (name, args, status, error, result) = sql(row)?;
        let args: Value = serde_json::from_str(&args)?;
        let effective = if name == "tool_call" {
            args["id"]
                .as_str()
                .and_then(|id| id.strip_prefix("native:"))
                .unwrap_or("call_mcp_tool")
        } else {
            &name
        };
        out.push(
            json!({"name":effective,"wire_name":name,"args":args,"status":status,"error":error,"result":result.and_then(|r| serde_json::from_str::<Value>(&r).ok())}),
        );
    }
    Ok(out)
}

pub(super) fn add_wire_calls(calls: &mut Vec<Value>, requests: &[Value]) {
    let mut seen = std::collections::BTreeSet::new();
    for request in requests {
        for item in request["input"].as_array().into_iter().flatten() {
            if item["type"] == "function_call_output" {
                if let Ok(result) =
                    serde_json::from_str::<Value>(item["output"].as_str().unwrap_or("{}"))
                {
                    calls
                        .push(json!({"name":"__feedback","result":result,"wire_observation":true}));
                }
                continue;
            }
            if item["type"] != "function_call" || !seen.insert(item["call_id"].to_string()) {
                continue;
            }
            let Ok(args) =
                serde_json::from_str::<Value>(item["arguments"].as_str().unwrap_or("{}"))
            else {
                continue;
            };
            let name = item["name"].as_str().unwrap_or_default();
            let effective = if name == "tool_call" {
                args["id"]
                    .as_str()
                    .and_then(|id| id.strip_prefix("native:"))
                    .unwrap_or("call_mcp_tool")
            } else {
                name
            };
            calls.push(json!({"name":effective,"args":args,"wire_observation":true}));
        }
    }
}

pub(super) fn check(
    case: &Value,
    s: &Scenario,
    turn: &Value,
    messages: &[Value],
    calls: &[Value],
    approvals: &[Value],
) -> Result<Vec<String>, HarnessError> {
    let mut errors = Vec::new();
    let reply: String = messages
        .iter()
        .filter(|m| m["role"] == "assistant")
        .filter_map(|m| m["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let state = case["state"].as_str().unwrap_or("delivered");
    if turn["state"] != state {
        errors.push(format!("state expected {state}, got {}", turn["state"]));
    }
    if let Some(tool) = case["tool"].as_str() {
        let matched: Vec<_> = calls
            .iter()
            .filter(|c| {
                c["name"] == tool
                    || case["tool_alternatives"]
                        .as_array()
                        .is_some_and(|tools| tools.contains(&c["name"]))
            })
            .collect();
        if matched.is_empty() {
            errors.push(format!("missing tool {tool}"));
        }
        if let Some(arg) = case["argument_contains"].as_str()
            && !approvals.iter().any(|a| a.to_string().contains(arg))
            && !matched.iter().any(|c| {
                c["args"]
                    .to_string()
                    .to_lowercase()
                    .contains(&arg.to_lowercase())
            })
        {
            errors.push(format!("{tool}: missing argument class {arg}"));
        }
    }
    for forbidden in case["forbidden"].as_array().into_iter().flatten() {
        if calls.iter().any(|c| c["name"] == *forbidden) {
            errors.push(format!("forbidden action {forbidden}"));
        }
    }
    if case["no_tools"] == true && !calls.is_empty() {
        errors.push("unexpected tool call".into());
    }
    if let Some(text) = case["reply_contains"].as_str()
        && !reply.contains(text)
    {
        errors.push(format!("reply missing {text}"));
    }
    if let Some(text) = case["reply_contains_insensitive"].as_str()
        && !reply.to_lowercase().contains(&text.to_lowercase())
    {
        errors.push(format!("reply missing {text}"));
    }
    if let Some(text) = case["reply_equals"].as_str()
        && reply.trim() != text
    {
        errors.push(format!("reply differs from {text}"));
    }
    if case["language"] == "ko"
        && !reply
            .chars()
            .any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c))
    {
        errors.push("reply lacks Korean".into());
    }
    for (path, content) in case["file_equals"].as_object().into_iter().flatten() {
        if fs::read_to_string(s.sandbox.data.join(path))
            .unwrap_or_default()
            .trim()
            != content.as_str().unwrap()
        {
            errors.push(format!("file content differs: {path}"));
        }
    }
    for path in case["file_absent"].as_array().into_iter().flatten() {
        if s.sandbox.data.join(path.as_str().unwrap()).exists() {
            errors.push(format!("unapproved file exists: {path}"));
        }
    }
    if let Some(expected) = case["approval"].as_bool() {
        if expected == approvals.is_empty() {
            errors.push(format!("approval presence differs: {expected}"));
        }
        if expected
            && !approvals.iter().any(|a| {
                a.to_string()
                    .contains(case["argument_contains"].as_str().unwrap())
            })
        {
            errors.push("approval does not show exact action".into());
        }
    }
    if case["requires_error"] == true
        && !calls.iter().any(|c| {
            c["error"].is_string() || c["status"] == "failed" || c["result"]["ok"] == false
        })
    {
        errors.push("fault was not exercised".into());
    }
    if let Some(code) = case["expected_error_code"].as_str()
        && !calls.iter().any(|c| c["result"]["error"]["code"] == code)
    {
        errors.push(format!("missing injected error {code}"));
    }
    if let Some(text) = case["memory_contains"].as_str() {
        let root = s.sandbox.data.join("cognition/memory/rules");
        let found = fs::read_dir(root)?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .any(|e| {
                fs::read_to_string(e.path())
                    .unwrap_or_default()
                    .contains(text)
            });
        if !found {
            errors.push("durable memory source missing".into());
        }
    }
    Ok(errors)
}
