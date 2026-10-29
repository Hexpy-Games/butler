//! Block snapshots share the delivered-answer scenario's real collected images.
use super::*;
use butler_e2e::e2e::scenario::Scenario;

pub(crate) async fn asset_lifetime(
    s: &Scenario,
    session: &str,
    message: &Value,
) -> Result<(), HarnessError> {
    let paths = ["/blocks/4", "/blocks/4/tabs/1/blocks/0"];
    let mut saved = Vec::new();
    for path in paths {
        let input = json!({"message_id":message["id"],"path":path});
        let reply = s.gw.post("/library/blocks", input.clone()).await?;
        let item = ok(&reply);
        assert_eq!(item["block"]["v"], 2);
        assert_eq!(item["origin"]["path"], path);
        let expected = message["answer_blocks"][0]["spec"].pointer(path).unwrap();
        let mut actual = item["block"]["blocks"][0].clone();
        let mut expected = expected.clone();
        strip(&mut actual);
        strip(&mut expected);
        assert_eq!(actual, expected);
        let repeated = s.gw.post("/library/blocks", input).await?;
        assert_eq!(ok(&repeated)["id"], item["id"]);
        saved.push(item);
    }
    assert_eq!(
        page(s, "/library?kind=scrap").await?["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let image = &message["answer_blocks"][0]["spec"]["blocks"][4]["tabs"][1]["blocks"][0];
    let asset = image["img"].as_str().unwrap();
    assert_eq!(refs(s, asset)?, 2);
    assert_eq!(
        s.gw.delete(&format!("/sessions/{session}?permanent=true"))
            .await?
            .status,
        200
    );
    for item in &saved {
        let id = item["id"].as_str().unwrap();
        let read = s.gw.get(&format!("/library/{id}")).await?;
        let mut actual = ok(&read);
        let mut expected = item.clone();
        strip(&mut actual);
        strip(&mut expected);
        assert_eq!(
            actual, expected,
            "the saved snapshot survives chat deletion"
        );
        let leaf = if actual["block"]["blocks"][0]["type"] == "tabs" {
            &read.data()["block"]["blocks"][0]["tabs"][1]["blocks"][0]
        } else {
            &read.data()["block"]["blocks"][0]
        };
        let url = leaf["image_url"].as_str().unwrap();
        assert!(url.starts_with(&format!("/message-assets/{asset}?expires=")));
        assert_eq!(
            reqwest::get(format!("{}{url}", s.gw.base)).await?.status(),
            200
        );
    }
    for (index, item) in saved.iter().enumerate() {
        assert_eq!(
            s.gw.delete(&format!("/library/{}", item["id"].as_str().unwrap()))
                .await?
                .status,
            200
        );
        assert_eq!(refs(s, asset)?, i64::try_from(1 - index).unwrap());
    }
    for image in message["answer_blocks"][0]["spec"]["blocks"][0]["items"]
        .as_array()
        .unwrap()
    {
        assert_eq!(
            reqwest::get(format!(
                "{}{}",
                s.gw.base,
                image["image_url"].as_str().unwrap()
            ))
            .await?
            .status(),
            404,
            "the deleted chat and scraps release every collected image"
        );
    }
    Ok(())
}
fn refs(s: &Scenario, asset: &str) -> Result<i64, HarnessError> {
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok(db.query_row(
        "SELECT COUNT(*) FROM app_asset_refs WHERE asset_id=?1 AND owner_kind='library'",
        [asset],
        |r| r.get(0),
    )?)
}
fn strip(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.remove("image_url");
            for value in fields.values_mut() {
                strip(value);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip(item);
            }
        }
        _ => {}
    }
}
