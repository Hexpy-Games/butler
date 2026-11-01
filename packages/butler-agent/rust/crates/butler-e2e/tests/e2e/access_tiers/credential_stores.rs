//! No file tool writes Butler's own credential stores, in any access mode, so the
//! refusal comes before any approval card and says what to do instead.
use super::stub::{self, call};
use super::{assert_counts, delivered, outputs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use serde_json::json;

#[tokio::test]
async fn file_tools_refuse_credential_stores_before_asking() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-CREDENTIAL-STORES")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &folder).await?;
    for store in [
        butler_platform::data_paths::ENVIRONMENT,
        "auth/answers.json",
    ] {
        let target = s.sandbox.data.join(store);
        let before = std::fs::read(&target).ok();
        let prompt = format!("Write the {store} store.");
        let args = json!({"path":target.to_string_lossy(),"content":"{}","create_parents":true});
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.clone(), vec![call("store", "write_file", &args)]);
        let id = s.gw.say_turn(&chat, &prompt).await?;
        delivered(&s, &chat, &id).await?;
        let cards = s.gw.approval_requests(&chat).await?;
        assert!(cards.is_empty(), "asked before refusing: {cards:?}");
        assert_counts(&s, &id, 0, 0)?;
        assert_eq!(
            std::fs::read(&target).ok(),
            before,
            "a file tool wrote {store}"
        );
        let told = outputs(&s, &chat, &id, &script, &prompt).await?.join("\n");
        assert!(told.contains("credential_store_blocked"), "{told}");
        assert!(
            told.contains("Ask the user to change this in Settings"),
            "{told}"
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
