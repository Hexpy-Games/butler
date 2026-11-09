//! `documentApi.ts`: what the document routes answer, and the one write the page makes.
use butler_shell_client::{Error, ShellClient};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Author {
    User,
    Butler,
}

/// `DocumentRevision`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(super) struct Revision {
    pub(super) rev: u64,
    pub(super) author: Author,
    pub(super) updated_at: String,
}

/// `DocumentAsset`: an image of the body, by its message-asset id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(super) struct Asset {
    pub(super) id: String,
}

/// `EditableDocument`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(super) struct Doc {
    pub(super) title: String,
    pub(super) body: String,
    pub(super) rev: u64,
    #[serde(default)]
    pub(super) chat_id: Option<String>,
    #[serde(default)]
    pub(super) assets: Vec<Asset>,
}

/// `DocumentUpdate`: the `document.updated` payload.
#[derive(Deserialize)]
pub(super) struct Update {
    pub(super) rev: u64,
    pub(super) author: Author,
}

/// `restoreDocument`: restores `rev` on top of the head, reading the head again when another
/// write won the race (HTTP 409, `revision_conflict`).
pub(super) async fn restore(client: ShellClient, id: String, rev: u64) -> Result<Value, Error> {
    loop {
        let head = client.get_document(&id).await?;
        let expected = head["rev"].as_u64().ok_or(Error::Protocol)?;
        let body = json!({ "rev": rev, "expected_rev": expected, "author": "user" });
        match client.restore_document(&id, &body).await {
            Err(Error::Http(409)) => {}
            answer => return answer,
        }
    }
}
