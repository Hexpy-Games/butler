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
            call("deliver_files", json!({"files":[{"path":"report.txt","title":"Report"}]})),
            call("edit_file", json!({"path":"report.txt","old_text":"retained-before","new_text":"uploaded-after"})),
            call("browser_observe", json!({"tab":"pub"})),
            upload("missing"),
            upload("node_modules"),
            upload("alias"),
            upload("../outside.txt"),
            call("browser_act", json!({"tab":"pub","observation":"obs-1","steps":[
                {"action":"upload","ref":"e1","value":"sub/../report.txt"},
                {"action":"upload","ref":"e1","value":"node_modules/pkg/index.txt"}]})),
        ],
    )])?);
    let data = setup.sandbox.data.clone();
    std::fs::create_dir_all(data.join("auth"))?;
    std::fs::create_dir_all(data.join("sub"))?;
    std::fs::write(data.parent().unwrap().join("outside.txt"), "outside bytes")?;
    std::fs::create_dir_all(data.join("node_modules/pkg"))?;
    std::fs::write(data.join("auth/login"), "private-fixture")?;
    std::fs::hard_link(data.join("auth/login"), data.join("alias"))?;
    std::fs::write(data.join("report.txt"), "retained-before")?;
    std::fs::write(data.join("package-store"), "complete-public")?;
    std::fs::hard_link(
        data.join("package-store"),
        data.join("node_modules/pkg/index.txt"),
    )?;
    let s = setup.start().await?;
    let host = Host::attach(&s).await?;
    let (id, card) = ask(&s, prompt).await?;
    let card = card.expect("an upload requires owner confirmation");
    assert!(card["approval"]["operation"]["allow_site"].is_null());
    assert_eq!(host.uploads(), Vec::<String>::new());
    allow(&s, &id, &card).await?;
    assert_eq!(host.uploads(), ["uploaded-after", "complete-public"]);
    let library = s.gw.get("/library?kind=document").await?;
    let documents = library.data();
    let items = documents["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{documents}");
    assert_eq!(
        s.gw.get(items[0]["file"]["url"].as_str().unwrap())
            .await?
            .text,
        "retained-before"
    );
    let requests = s.provider()?.requests();
    let history = requests.last().unwrap().to_string();
    for reason in [
        "upload_file_not_found",
        "upload_not_a_file",
        "upload_sensitive_file",
        "upload_outside_workspace",
    ] {
        assert!(history.contains(reason), "{reason} missing from results");
    }
    let stage = data.join(butler_platform::data_paths::READER_STAGING);
    assert!(std::fs::read_dir(stage)?.next().is_none());
    s.finish().await
}
