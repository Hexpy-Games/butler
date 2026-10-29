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
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
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
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
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

#[tokio::test]
async fn materialize_keeps_project_root_when_a_parent_directory_is_swapped()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::NO_FOLLOW, "directory links");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("MATERIALIZE-CONTAINED-PROJECT")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let credential = setup.sandbox.data.join("auth/login");
    std::fs::create_dir_all(credential.parent().unwrap())?;
    std::fs::write(&credential, "private-fixture")?;
    let release = setup.sandbox.root.join("materialize-release");
    let folder = setup.sandbox.root.join("project-base");
    std::fs::create_dir(&folder)?;
    let setup = setup
        .env("BUTLER_E2E_HOLD_POINT", "message_attachment")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_str().unwrap());
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let project: String = db.query_row(
        "SELECT p.workspace_path FROM projects p JOIN chats c ON c.project_id=p.id WHERE c.id=?1",
        [&chat],
        |row| row.get(0),
    )?;
    drop(db);
    *script.prompt.lock().unwrap() = "Write working notes".into();
    *script.steps.lock().unwrap() = [
        write("section/nested/report.txt", "Admitted bytes"),
        write("hard-link.txt", "Working notes"),
        write("safe.txt", "Complete safe notes"),
        done(),
    ]
    .into();
    let accepted = s.gw.say(&chat, "Write working notes").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    super::handoff::wait_for(|| release.with_extension("held").exists()).await;
    let project = std::path::PathBuf::from(project);
    let outside = s.sandbox.home.join("outside-files");
    std::fs::create_dir_all(outside.join("nested"))?;
    std::fs::write(outside.join("nested/report.txt"), "Outside bytes")?;
    std::fs::rename(project.join("section"), project.join("saved-section"))?;
    butler_platform::secure_fs::symlink(&outside, &project.join("section"))?;
    std::fs::remove_file(project.join("hard-link.txt"))?;
    std::fs::hard_link(&credential, project.join("hard-link.txt"))?;
    std::fs::write(&release, "release")?;
    s.gw.wait_terminal(&chat, &turn, std::time::Duration::from_secs(30))
        .await?;
    let messages = s.gw.messages(&chat).await?;
    let message = messages
        .iter()
        .find(|message| {
            message["turn_id"] == turn
                && message["role"] == "assistant"
                && message["status"] == "delivered"
        })
        .unwrap();
    assert_eq!(message["text"], "Done.");
    let attachments = message["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1, "{message}");
    assert_eq!(
        s.gw.get(attachments[0]["url"].as_str().unwrap())
            .await?
            .text,
        "Complete safe notes"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("saved-section/nested/report.txt"))?,
        "Admitted bytes"
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("nested/report.txt"))?,
        "Outside bytes"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A credential-named write stays a changed file but is never offered for
/// download; publishing it reports the refusal instead of failing.
#[tokio::test]
async fn credential_named_write_is_reported_and_never_published() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let path = "keys/fixture.key";
    assert!(
        std::path::Path::new(path).components().any(
            |part| butler_platform::secure_fs::secret_name(&part.as_os_str().to_string_lossy())
        ),
        "fixture must match the shared credential-name rule"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-SECRET-NAME")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .access(butler_e2e::e2e::scenario::Access::FullAccess)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    *script.steps.lock().unwrap() = [
        write(path, "private-fixture"),
        call("output_publish", json!({"path":path,"title":"Key"})),
        done(),
    ]
    .into();
    let s = setup.start().await?;
    let (_, turn) = run_turn(&s, &script, "Write the key.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let message = last(&s).await?;
    let changed = message["changed_files"].as_array().unwrap();
    assert_eq!(changed.len(), 1, "{message}");
    assert!(message.get("artifacts").is_none(), "{message}");
    assert!(message.get("attachments").is_none(), "{message}");
    assert!(
        message["limitation_codes"]
            .as_array()
            .unwrap()
            .contains(&json!("message_file_unavailable")),
        "{message}"
    );
    let published = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .flat_map(|request| request["input"].as_array().cloned().unwrap_or_default())
        .filter_map(|item| serde_json::from_str::<Value>(item["output"].as_str()?).ok())
        .map(|result| result.get("output").cloned().unwrap_or(result))
        .find(|result| result.get("skipped_files").is_some())
        .unwrap();
    assert_eq!(published["published"], false, "{published}");
    assert!(published.get("output_id").is_none(), "{published}");
    let skipped = published["skipped_files"].as_array().unwrap();
    assert_eq!(skipped.len(), 1, "{published}");
    assert_eq!(
        std::path::Path::new(skipped[0].as_str().unwrap()),
        std::path::Path::new(path)
    );
    assert_eq!(documents(&s).await?, Vec::<Value>::new());
    s.finish().await?;
    server.abort();
    Ok(())
}
