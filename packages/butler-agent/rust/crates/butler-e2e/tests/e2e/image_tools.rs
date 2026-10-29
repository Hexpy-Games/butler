//! Image calls use stub chat, fake billed endpoints and the real gateway.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod edits;
mod flows;
use super::access_tiers::{approve, delivered, paused, stub};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fake_servers::images::ImageServer,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::sync::Arc;
const MODEL: &str = "openai/gpt-image-2.5-sunburst";
struct Fixture {
    s: Scenario,
    script: Arc<stub::Script>,
    image: ImageServer,
    chat: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn start(access: Access, provider: &str) -> Result<Self, HarnessError> {
        let image = ImageServer::start().await?;
        let (url, script, chat) = stub::start().await?;
        let setup = Setup::new("IMAGE-TOOLS")?
            .access(access)
            .stub_cassette(Cassette::load("TOOL-01")?)
            .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
            .env("OPENAI_BASE_URL", format!("{}/v1", image.base))
            .env("BUTLER_GOOGLE_BASE_URL", &image.base);
        let mut s = setup.start().await?;
        s.agent.terminate().await?;
        let path = s.sandbox.data.join("app-server/butler-client.sqlite");
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(path.parent().unwrap())?;
            let db=rusqlite::Connection::open(path)?;
            db.execute_batch("DROP TABLE app_assets; CREATE TABLE app_assets(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,bytes INTEGER NOT NULL,alt TEXT NOT NULL,source_url TEXT NOT NULL,created_at TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'collected',parent_id TEXT,model_ref TEXT);")?;
            Ok::<_,HarnessError>(())
        }).await.map_err(|e|HarnessError(e.to_string()))??;
        s.gw = s.agent.start_again().await?;
        let key =
            s.gw.post(
                "/credentials",
                json!({"provider_id":provider,"api_key":"image-stub-key"}),
            )
            .await?;
        assert_eq!(key.status, 201, "{}", key.text);
        let model = if provider == "google" {
            "google/gemini-nano-banana-2.1"
        } else {
            MODEL
        };
        let selected =
            s.gw.send(
                reqwest::Method::PUT,
                "/settings/image-model",
                Some(
                    json!({"model_ref":model,"credential_id":key.data()["credential"]["id"]})
                        .to_string(),
                ),
            )
            .await?;
        assert_eq!(selected.status, 200, "{}", selected.text);
        Ok(Self {
            s,
            script,
            image,
            chat,
        })
    }
    fn script(&self, prompt: &str, calls: Vec<Value>) {
        self.script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.into(), calls);
    }
    async fn finish(self) -> Result<(), HarnessError> {
        self.chat.abort();
        self.s.finish().await
    }
    async fn run(&self, prompt: &str) -> Result<String, HarnessError> {
        let id = self.s.gw.say_turn("general", prompt).await?;
        delivered(&self.s, "general", &id).await?;
        Ok(id)
    }
    fn output(&self, id: &str) -> Value {
        self.script
            .requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .flat_map(|r| r["input"].as_array().into_iter().flatten())
            .find(|i| i["type"] == "function_call_output" && i["call_id"] == id)
            .and_then(|i| i["output"].as_str())
            .map(|s| {
                let v: Value = serde_json::from_str(s).unwrap();
                v.get("output").cloned().unwrap_or(v)
            })
            .expect("model receives tool output")
    }
    async fn stored_images(&self) -> Result<u64, HarnessError> {
        let path = self.s.sandbox.data.join("app-server/butler-client.sqlite");
        tokio::task::spawn_blocking(move || {
            let db = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            Ok::<_, HarnessError>(
                db.query_row("SELECT COUNT(*) FROM app_assets", [], |r| r.get(0))?,
            )
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))?
    }
    async fn raw(&self, path: &str) -> Result<Vec<u8>, HarnessError> {
        Ok(self
            .s
            .gw
            .http()
            .get(format!("{}{path}", self.s.gw.base))
            .bearer_auth(&self.s.gw.token)
            .send()
            .await?
            .bytes()
            .await?
            .to_vec())
    }
}
fn call(id: &str, name: &str, args: &Value) -> Value {
    stub::call(id, name, args)
}
fn generate(id: &str) -> Value {
    call(
        id,
        "generate_image",
        &json!({"prompt":"A red kite above a blue sea","size":"1024x1024","quality":"high"}),
    )
}
