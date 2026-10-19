//! Delivery validates credentials and preserves the bytes admitted at handoff.
use super::*;

#[tokio::test]
async fn delivery_refuses_credentials_and_stages_validated_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::secure_fs::FILE_IDS,
        "Unix credential file identities"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-CONTAINED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    for path in [
        "auth/login",
        "state/app-gateway/project-folder-token-secret",
        "sandbox-quarantine/entry",
    ] {
        let path = setup.sandbox.data.join(path);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, "private-fixture")?;
    }
    std::fs::hard_link(
        setup.sandbox.data.join("auth/login"),
        setup.sandbox.data.join("alias"),
    )?;
    *script.steps.lock().unwrap() = [
        deliver("auth/login", "Denied"),
        deliver("state/app-gateway/project-folder-token-secret", "Denied"),
        deliver("sandbox-quarantine/entry", "Denied"),
        deliver("alias", "Denied"),
        call(
            "run_command",
            json!({"command":"printf complete", "output_paths":["alias"],
            "summary":"Inspect declared output", "state_effect":"mutation"}),
        ),
        write("report.txt", "complete-before"),
        deliver("report.txt", "Report"),
        call(
            "write_file",
            json!({"path":"report.txt", "content":"complete-after", "overwrite":true,
            "expected_sha256":butler_e2e::e2e::sha256_hex(b"complete-before")}),
        ),
        done(),
    ]
    .into();
    let report = setup.sandbox.data.join("report.txt");
    let s = setup.start().await?;
    run_turn(&s, &script, "Deliver the report.").await?;
    assert_eq!(std::fs::read_to_string(report)?, "complete-after");
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["title"], "Report");
    let message = last(&s).await?;
    let files = message["attachments"].as_array().unwrap();
    let delivered: Vec<_> = files.iter().filter(|f| f["deliverable"] == true).collect();
    assert_eq!(delivered.len(), 1);
    for attachment in files {
        let content = s.gw.get(attachment["url"].as_str().unwrap()).await?.text;
        assert!(
            !content.contains("private-fixture"),
            "command artifacts must not expose credential content"
        );
    }
    assert_eq!(
        s.gw.get(delivered[0]["url"].as_str().unwrap()).await?.text,
        "complete-before"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn redelivery_of_hard_linked_package_replaces_drawer_and_consumes_stage()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::FILE_IDS, "Unix hard links");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-REPLACE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    let data = setup.sandbox.data.clone();
    let source = "node_modules/.pnpm/pkg/node_modules/pkg/index.js";
    std::fs::create_dir_all(data.join(source).parent().unwrap())?;
    std::fs::write(data.join("package-store"), "complete-before")?;
    std::fs::hard_link(data.join("package-store"), data.join(source))?;
    *script.steps.lock().unwrap() = [
        call("read_file", json!({"requests":[{"path":source}]})),
        call(
            "grep_files",
            json!({"pattern":"complete", "literal":true, "root":"node_modules/.pnpm/pkg/node_modules/pkg", "include_globs":["**/index.js"]}),
        ),
        deliver(source, "Package"),
        call("output_publish", json!({"path":source,"title":"Package"})),
        call(
            "edit_file",
            json!({"path":source,"old_text":"complete-before","new_text":"complete-after"}),
        ),
        deliver(source, "Package"),
        call("output_publish", json!({"path":source,"title":"Package"})),
        done(),
    ]
    .into();
    let s = setup.start().await?;
    run_turn(&s, &script, "Read, search, revise and publish the package.").await?;
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1, "{docs:?}");
    assert_eq!(
        s.gw.get(docs[0]["file"]["url"].as_str().unwrap())
            .await?
            .text,
        "complete-after"
    );
    let stage = data.join(butler_platform::data_paths::READER_STAGING);
    assert!(
        !stage.exists() || std::fs::read_dir(stage)?.next().is_none(),
        "stages must be consumed"
    );
    let requests = script.requests.lock().unwrap().clone();
    let tool_results = requests
        .iter()
        .flat_map(|request| request["input"].as_array().into_iter().flatten())
        .filter_map(|item| item["output"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(tool_results.contains("complete-before"));
    let grep_ok = requests
        .iter()
        .flat_map(|request| request["input"].as_array().into_iter().flatten())
        .filter_map(|item| item["output"].as_str())
        .filter_map(|output| serde_json::from_str::<Value>(output).ok())
        .map(|result| result.get("output").cloned().unwrap_or(result))
        .any(|output| {
            output["matches"]
                .as_array()
                .is_some_and(|matches| matches.iter().any(|item| item["text"] == "complete-before"))
        });
    assert!(
        grep_ok,
        "grep must return the hard-linked package content: {tool_results}"
    );
    let publications: std::collections::BTreeSet<_> = requests
        .iter()
        .flat_map(|request| request["input"].as_array().into_iter().flatten())
        .filter_map(|item| item["output"].as_str())
        .filter_map(|output| serde_json::from_str::<Value>(output).ok())
        .map(|result| result.get("output").cloned().unwrap_or(result))
        .filter_map(|result| {
            Some((
                result["output_id"].as_str()?.to_owned(),
                result["revision"].as_u64()?,
            ))
        })
        .collect();
    assert_eq!(
        publications.len(),
        2,
        "both package versions must publish: {tool_results}"
    );
    let publications: Vec<_> = publications.into_iter().collect();
    assert_eq!(publications[0].0, publications[1].0);
    assert_eq!((publications[0].1, publications[1].1), (1, 2));
    s.finish().await?;
    server.abort();
    Ok(())
}
