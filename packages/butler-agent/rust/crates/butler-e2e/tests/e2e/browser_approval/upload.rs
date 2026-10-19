//! Uploads send exactly validated bytes and dispose their private copies.
use super::*;

#[tokio::test]
async fn upload_checks_content_refusals_and_consumes_stages() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::FILE_IDS, "Unix hard links");
    let upload = |path: &str| {
        call(
            "browser_act",
            json!({"tab":"pub","observation":"obs-1",
        "steps":[{"action":"upload","ref":"e1","value":path}]}),
        )
    };
    let prompt = "Upload the public package";
    let setup = Setup::new("UPLOAD-CONTAINED-CONTENT")?.stub_cassette(host::cassette(&[(
        prompt.into(),
        vec![
            call("browser_observe", json!({"tab":"pub"})),
            upload("missing"),
            upload("node_modules"),
            upload("alias"),
            upload("node_modules/pkg/index.txt"),
        ],
    )])?);
    let data = setup.sandbox.data.clone();
    std::fs::create_dir_all(data.join("auth"))?;
    std::fs::create_dir_all(data.join("node_modules/pkg"))?;
    std::fs::write(data.join("auth/login"), "private-fixture")?;
    std::fs::hard_link(data.join("auth/login"), data.join("alias"))?;
    std::fs::write(data.join("package-store"), "complete-public")?;
    std::fs::hard_link(
        data.join("package-store"),
        data.join("node_modules/pkg/index.txt"),
    )?;
    let s = setup.start().await?;
    let host = Host::attach(&s).await?;
    let (id, card) = ask(&s, prompt).await?;
    let card = card.expect("an upload requires owner confirmation");
    assert_eq!(host.uploads(), Vec::<String>::new());
    allow(&s, &id, &card).await?;
    assert_eq!(host.uploads(), ["complete-public"]);
    let requests = s.provider()?.requests();
    let history = requests.last().unwrap().to_string();
    for reason in [
        "upload_file_not_found",
        "upload_not_a_file",
        "upload_sensitive_file",
    ] {
        assert!(history.contains(reason), "{reason} missing from results");
    }
    let stage = data.join(butler_platform::data_paths::READER_STAGING);
    assert!(std::fs::read_dir(stage)?.next().is_none());
    s.finish().await
}
