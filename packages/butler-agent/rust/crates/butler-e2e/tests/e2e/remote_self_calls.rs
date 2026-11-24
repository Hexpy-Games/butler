//! Model tools on a deployed remote Butler exercise its own gateway.
use std::{path::Path, time::Duration};

use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    fake_chatgpt::FakeChatGptAuthority,
    harness_error, matching,
    provider::{Provider, is_title_request},
    sanitize::Placeholders,
};
use serde_json::{Value, json};

use super::{
    access_tiers::stub::call, browser_usage::stub::response, computer_account::Deployed,
    remote_sessions::remote_chat_with_model,
};

const CANON: &str = "Read this project's canon.";
const DOCUMENT: &str = "Write and read back the remote note.";
const WALLPAPER: &str = "List wallpapers.";
const BRANCH: &str = "Branch the preceding answer.";
const CHILD: &str = "Have a Steward report the result.";
const WORKER: &str = "Have a Steward start a Worker.";
const NOTE: &str = "The note was written on the remote computer.";
const RESULT: &str = "The Steward verified the remote result.";
const PARENT_ANSWER: &str = "The Steward's remote result reached this conversation.";

struct Remote {
    deployed: Deployed,
    provider: Provider,
    authority: FakeChatGptAuthority,
    chat: String,
}

impl Remote {
    async fn start(id: &str) -> Result<Self, HarnessError> {
        let provider =
            Provider::replay(Cassette::load("TOOL-01")?, Placeholders::default()).await?;
        provider.set_chat_responder(script);
        let authority = FakeChatGptAuthority::start().await?;
        provider.chatgpt_authority(&authority.issuer);
        let (deployed, chat) = remote_chat_with_model(
            id,
            "full_access",
            &format!("{}/v1", provider.base_url),
            &authority,
            false,
        )
        .await?;
        Ok(Self {
            deployed,
            provider,
            authority,
            chat,
        })
    }

    async fn turn(&self, prompt: &str) -> Result<(), HarnessError> {
        self.deployed.s.turn(&self.chat, prompt).await?;
        Ok(())
    }

    fn result(&self, id: &str) -> Option<Value> {
        self.provider
            .requests()
            .iter()
            .find_map(|body| output(body, id))
    }

    async fn finish(self) -> Result<(), HarnessError> {
        let Deployed {
            s,
            remote,
            sshd,
            files,
            ..
        } = self.deployed;
        drop((remote, sshd, files, self.authority));
        s.finish().await?;
        self.provider.finish().await
    }
}

#[tokio::test]
async fn reads_project_canon() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let remote = Remote::start("REMOTE-SELF-CANON").await?;
    remote.turn(CANON).await?;
    let result = remote.result("canon").unwrap_or(Value::Null);
    assert_eq!(result["ok"], true, "{result}");
    remote.finish().await
}

#[tokio::test]
async fn creates_and_reads_document() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let remote = Remote::start("REMOTE-SELF-DOCUMENT").await?;
    remote.turn(DOCUMENT).await?;
    let result = remote.result("read").unwrap_or(Value::Null);
    assert_eq!(result["output"]["body"], NOTE, "{result}");
    remote.finish().await
}

#[tokio::test]
async fn lists_wallpapers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let remote = Remote::start("REMOTE-SELF-WALLPAPERS").await?;
    remote.turn(WALLPAPER).await?;
    let result = remote.result("wallpaper").unwrap_or(Value::Null);
    assert_eq!(result["ok"], true, "{result}");
    remote.finish().await
}

#[tokio::test]
async fn creates_topic_branch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let remote = Remote::start("REMOTE-SELF-BRANCH").await?;
    remote.turn("Answer the source conversation.").await?;
    remote.turn(BRANCH).await?;
    let result = remote.result("branch").unwrap_or(Value::Null);
    assert_eq!(result["output"]["title"], "Remote branch", "{result}");
    remote.finish().await
}

#[tokio::test]
async fn starts_worker_with_profile() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let remote = Remote::start("REMOTE-SELF-WORKER").await?;
    remote.turn(WORKER).await?;
    let worker = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(result) = remote.result("worker") {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| harness_error("the remote Steward produced no Worker delegation result"))?;
    assert_eq!(worker["ok"], true, "{worker}");
    remote.finish().await
}

#[tokio::test]
async fn delivers_steward_result_to_parent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let remote = Remote::start("REMOTE-SELF-RESULT").await?;
    remote.turn(CHILD).await?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if remote
                .deployed
                .s
                .gw
                .messages(&remote.chat)
                .await?
                .iter()
                .any(|message| message["text"] == PARENT_ANSWER)
            {
                return Ok::<(), HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| harness_error("the Steward result did not reach the parent conversation"))??;
    remote.finish().await
}

fn output(body: &Value, id: &str) -> Option<Value> {
    let output = body["input"]
        .as_array()?
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)?;
    serde_json::from_str(output["output"].as_str()?).ok()
}

fn script(body: &Value) -> Option<ResponseRecord> {
    if is_title_request(body) {
        return None;
    }
    let key = matching::key("/v1/responses", body, &Placeholders::default());
    let prompt = key.user_request.as_str();
    let item = match prompt {
        CANON => native(body, "canon", "canon_read", &json!({"view":"canon"})),
        DOCUMENT if output(body, "create").is_none() => native(
            body,
            "create",
            "document_create",
            &json!({"title":"Remote note","body":NOTE}),
        ),
        DOCUMENT => {
            let created = output(body, "create")?;
            let id = created["output"]["id"].as_str()?;
            native(body, "read", "document_read", &json!({"id":id}))
        }
        WALLPAPER => native(body, "wallpaper", "list_wallpapers", &json!({})),
        BRANCH => native(
            body,
            "branch",
            "start_topic_conversation",
            &json!({"title":"Remote branch","destination":"chat"}),
        ),
        CHILD | WORKER if output(body, "steward").is_none() => Some(call(
            "steward",
            "delegate_to_steward",
            &json!({"request":prompt,"checks":["Verify the requested result"],"safe_title":prompt}),
        )),
        _ if prompt.starts_with("role: steward") => steward(body, prompt.contains(WORKER)),
        _ => None,
    };
    let item = item.unwrap_or_else(|| {
        let text = if prompt.contains("result_id:") && prompt.contains(RESULT) {
            PARENT_ANSWER
        } else {
            "Checked."
        };
        json!({"type":"message","id":"msg_done","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]})
    });
    Some(response(&item))
}

fn native(body: &Value, id: &str, name: &str, arguments: &Value) -> Option<Value> {
    if output(body, id).is_some() {
        return None;
    }
    let native_id = format!("native:{name}");
    let describe = format!("describe-{id}");
    Some(if output(body, &describe).is_none() {
        call(&describe, "tool_describe", &json!({"ids":[native_id]}))
    } else {
        call(
            id,
            "tool_call",
            &json!({"id":native_id,"arguments":arguments}),
        )
    })
}

fn steward(body: &Value, worker: bool) -> Option<Value> {
    if output(body, "plan").is_none() {
        return Some(call(
            "plan",
            "replace_work_plan",
            &json!({
                "objective":"Verify the requested result",
                "execution_mode": if worker {"workers"} else {"direct"},
                "actions":[{"action_key":"verify","description":"Verify the result","dependency_keys":[]}],
                "checks":["Verify the requested result"]
            }),
        ));
    }
    if output(body, "review").is_none() {
        return Some(call(
            "review",
            "record_work_review",
            &json!({
                "subject":"plan","verdict":"accept","summary":"Ready"
            }),
        ));
    }
    if worker {
        return native(
            body,
            "worker",
            "delegate_to_worker",
            &json!({
                "task":{"scope":{"paths":["tasks/verify"]},"output":{"format":"text","fields":["summary"]}},
                "action_key":"verify","objective":"Verify the result","acceptance_criteria":["Result verified"],
                "implementation_brief":"Check the result","safe_title":"Verify"
            }),
        );
    }
    if output(body, "disposition").is_none() {
        let plan = output(body, "plan")?;
        return Some(call(
            "disposition",
            "record_work_disposition",
            &json!({
                "work_id":plan["output"]["work"]["work_id"],
                "disposition":"completed","summary":RESULT,
                "action_updates":[{"action_key":"verify","status":"done"}],"remaining_actions":[],"followups":[]
            }),
        ));
    }
    Some(
        json!({"type":"message","id":"msg_steward","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":RESULT,"annotations":[]}]}),
    )
}
