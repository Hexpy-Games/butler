//! Reference grammar and limits through create/edit, with real uploaded files.
use super::*;
use std::fmt::Write as _;

#[tokio::test]
async fn at_11_markdown_references_and_unique_limit_survive_create_and_edit()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-11")?.start().await?;
    let project = project(&s).await?;
    let mut files = Vec::new();
    for _ in 0..21 {
        files.push(attachments::upload(&s, &project).await?);
    }
    let a = files[0]["file_id"].as_str().unwrap();
    let b = files[1]["file_id"].as_str().unwrap();
    let markdown = format!(
        "![a](attachment:{a}) [b][ref] [duplicate](AtTaChMeNt:{a})\n\n[ref]: AtTaChMeNt:{b}\n\n`![](attachment:invalid)`\n\n```\n![](attachment:invalid)\n```\n<img src='attachment:invalid'>"
    );
    let epic = attachments::save(&s, &project, &markdown).await?;
    assert_eq!(epic["description"], markdown);
    let mut actual = ids_from_files(&epic["attachments"]);
    actual.sort();
    let mut expected = vec![a.to_owned(), b.to_owned()];
    expected.sort();
    assert_eq!(actual, expected);
    let path = format!("/canon/epics/{}", epic["id"].as_str().unwrap());
    let mut description = String::new();
    for file in &files[..20] {
        write!(
            description,
            "[file](attachment:{})",
            file["file_id"].as_str().unwrap()
        )
        .unwrap();
    }
    // Duplicates count once, including when the unique count is exactly twenty.
    write!(description, "![again](attachment:{a})").unwrap();
    let created = attachments::save(&s, &project, &description).await?;
    assert_eq!(created["attachments"].as_array().unwrap().len(), 20);
    let edited = data(
        s.gw.patch(
            &path,
            json!({"expected_revision":epic["revision"],"description":description}),
        )
        .await?,
        200,
    );
    assert_eq!(edited["attachments"].as_array().unwrap().len(), 20);
    write!(
        description,
        "[overflow](attachment:{})",
        files[20]["file_id"].as_str().unwrap()
    )
    .unwrap();
    for (description, code, status) in [
        (description, "too_many_attachments", 409),
        (
            "![bad](attachment:../../secret)".into(),
            "invalid_attachments",
            400,
        ),
    ] {
        for reply in [
            s.gw.post(
                &format!("/projects/{project}/canon/epics"),
                json!({"title":"Rejected","description":description}),
            )
            .await?,
            s.gw.patch(
                &path,
                json!({"expected_revision":edited["revision"],"description":description}),
            )
            .await?,
        ] {
            assert_eq!(reply.status, status, "{}", reply.text);
            assert_eq!(reply.body["error"]["code"], code);
        }
    }
    let loaded = data(s.gw.get(&path).await?, 200);
    assert_eq!(loaded["revision"], edited["revision"]);
    assert_eq!(loaded["attachments"], edited["attachments"]);
    s.finish().await
}

fn ids_from_files(files: &Value) -> Vec<String> {
    files
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["file_id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn at_12_edit_reference_survives_concurrent_upload_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-12")?.start().await?;
    let project = project(&s).await?;
    let file = attachments::upload(&s, &project).await?;
    let epic = create_epic(&s, &project, "Concurrent edit").await?;
    let id = file["file_id"].as_str().unwrap();
    // A durable stale queue entry may coexist with a pending upload or new reference.
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO app_file_sweep VALUES(?1)", [id])?;
    drop(db);
    let path = format!("/canon/epics/{}", epic["id"].as_str().unwrap());
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let (edited, fresh) = tokio::join!(
        s.gw.patch(&path, json!({"expected_revision":epic["revision"],"description":format!("![capture](attachment:{id})")})),
        attachments::upload(&s, &project),
    );
    let edited = data(edited?, 200);
    let fresh = fresh?;
    assert_eq!(edited["attachments"][0]["file_id"], id);
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == epic["id"]
                && e["payload"]["revision"] == edited["revision"]
        })
        .await?;
    let loaded = data(s.gw.get(&path).await?, 200);
    assert_eq!(loaded["attachments"][0]["file_id"], id);
    for file in [&file, &fresh] {
        let (status, bytes) = s.gw.download(file["url"].as_str().unwrap()).await?;
        assert_eq!(status, 200);
        assert_eq!(bytes, butler_e2e::e2e::media::digits_png("57", 12));
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_file_sweep WHERE file_id=?1",
            [id],
            |r| r.get(0)
        )?,
        0
    );
    s.finish().await
}

#[tokio::test]
async fn at_15_chat_file_ownership_and_escaped_duplicate_references() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-15")?.start().await?;
    let project = project(&s).await?;
    let other = data(s.gw.post("/sessions", json!({"kind":"chat"})).await?, 201);
    for (name, mime, bytes) in [
        ("[notes].txt", "text/plain", b"Complete notes".as_slice()),
        (
            "[archive].bin",
            "application/octet-stream",
            b"\0\xff\x01".as_slice(),
        ),
        (
            "[capture].png",
            "image/png",
            butler_e2e::e2e::media::digits_png("57", 12).as_slice(),
        ),
    ] {
        let file =
            data(s.gw.upload(name, mime, bytes, Some("general")).await?, 201)["file"].clone();
        let rejected =
            s.gw.post(
                "/messages",
                json!({
                    "chat_id":other["session"]["id"],"text":"Read attachment",
                    "attachments":[{"file_id":file["file_id"]}],
                    "client_message_id":uuid::Uuid::new_v4().to_string()
                }),
            )
            .await?;
        assert_eq!(rejected.status, 403, "{}", rejected.text);
        assert_eq!(rejected.body["error"]["code"], "message_file_wrong_session");
        let id = file["file_id"].as_str().unwrap();
        let label = name.replace('[', "\\[").replace(']', "\\]");
        let prefix = if mime.starts_with("image/") { "!" } else { "" };
        let description =
            format!("{prefix}[{label}](attachment:{id})\n[duplicate](attachment:{id})");
        let epic = attachments::save(&s, &project, &description).await?;
        assert_eq!(epic["description"], description);
        assert_eq!(epic["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(epic["attachments"][0]["file_id"], id);
        assert_eq!(epic["attachments"][0]["safe_name"], file["safe_name"]);
    }
    s.finish().await
}
