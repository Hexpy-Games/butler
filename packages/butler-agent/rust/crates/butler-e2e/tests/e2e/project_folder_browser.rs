//! Cookie-authenticated browser selection is confined to the host workspace.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use butler_platform::secure_fs;
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{fs, path::Path};

struct Browser {
    client: Client,
    base: String,
    cookie: String,
}

impl Browser {
    async fn connect(s: &Scenario) -> Result<Self, HarnessError> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let output = s.agent.cli(&["open", "--no-browser", "--json"])?;
        assert_eq!(output.code, Some(0));
        let value = output.json()?;
        let link = value["data"]["url"].as_str().expect("connection URL");
        let response = client.get(link).send().await?;
        assert_eq!(response.status().as_u16(), 303);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .expect("ASCII session header")
            .split(';')
            .next()
            .expect("session")
            .to_owned();
        Ok(Self {
            client,
            base: s.gw.base.clone(),
            cookie,
        })
    }

    async fn list(&self, path: &str, after: Option<&str>) -> Result<(u16, Value), HarnessError> {
        let mut query = vec![("path", path)];
        if let Some(after) = after {
            query.push(("after", after));
        }
        let response = self
            .client
            .get(format!("{}/project-folders", self.base))
            .query(&query)
            .header("cookie", &self.cookie)
            .header("sec-fetch-site", "same-origin")
            .send()
            .await?;
        Ok((response.status().as_u16(), response.json().await?))
    }

    async fn create(&self, path: Value) -> Result<(u16, Value), HarnessError> {
        let response = self
            .client
            .request(Method::POST, format!("{}/projects", self.base))
            .header("cookie", &self.cookie)
            .header("origin", &self.base)
            .header("sec-fetch-site", "same-origin")
            .json(&json!({"source":"workspace_folder", "workspace_path":path}))
            .send()
            .await?;
        Ok((response.status().as_u16(), response.json().await?))
    }
}

#[tokio::test]
async fn cookie_browser_lists_pages_and_creates_nested_project() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PROJECT-FOLDER-BROWSER")?.start().await?;
    let browser = Browser::connect(&s).await?;
    let root = s.sandbox.home.join("butler-workspace");
    let (status, empty) = browser.list("", None).await?;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["data"]["folders"], json!([]));
    assert!(!root.exists(), "read must not create the workspace");
    seed(&root, &s.sandbox.workspace)?;
    let (status, listing) = browser.list("", None).await?;
    assert_eq!(status, 200, "{listing}");
    assert_eq!(listing["data"]["root_name"], "butler-workspace");
    assert_eq!(listing["data"]["path"], "");
    assert_eq!(
        listing["data"]["folders"],
        json!([{"name":"a"},{"name":"many"},{"name":"outer"}])
    );
    assert_eq!(listing["data"]["next_after"], Value::Null);
    assert_pages(&browser).await?;
    let (status, nested) = browser.list("outer", None).await?;
    assert_eq!(status, 200, "{nested}");
    assert_eq!(nested["data"]["folders"], json!([{"name":"inner"}]));
    let (status, leaf) = browser.list("outer/inner", None).await?;
    assert_eq!(status, 200);
    assert_eq!(leaf["data"]["folders"], json!([]));
    assert_ancestor_pages(&browser).await?;
    let (status, created) = browser.create(json!("a/b/c")).await?;
    assert_eq!(status, 201, "{created}");
    let id = created["data"]["project"]["id"]
        .as_str()
        .expect("project id");
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let stored: String = db.query_row(
        "SELECT workspace_path FROM projects WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    assert_eq!(
        Path::new(&stored),
        secure_fs::canonicalize(root.join("a/b/c"))?
    );
    let (status, reused) = browser.create(json!("a/b/c")).await?;
    assert_eq!(status, 201);
    assert_eq!(reused["data"]["project"]["id"], id);
    assert_refusals(&browser).await?;
    for path in ["/projects", "/project-folders"] {
        let response = browser
            .client
            .get(format!("{}{path}", browser.base))
            .send()
            .await?;
        assert_eq!(response.status().as_u16(), 401);
        assert_eq!(
            response.json::<Value>().await?["error"]["code"],
            "local_auth_required"
        );
    }
    drop(db);
    s.finish().await
}

fn seed(root: &Path, outside: &Path) -> Result<(), HarnessError> {
    fs::create_dir_all(root.join("outer/inner"))?;
    for path in ["a/b/c", "a/b/d", "a/sibling"] {
        fs::create_dir_all(root.join(path))?;
    }
    fs::create_dir(root.join(".git"))?;
    fs::create_dir(root.join("many"))?;
    fs::write(root.join("file.txt"), "plain file")?;
    secure_fs::fixture_links::directory_alias(outside, &root.join("escape"))?;
    secure_fs::fixture_links::directory_alias(&root.join("outer"), &root.join("alias"))?;
    for index in 0..205 {
        fs::create_dir(root.join(format!("many/Folder-{index:03}")))?;
    }
    for name in ["alpha", "Alpha-other", "Beta", "zebra"] {
        fs::create_dir(root.join("many").join(name))?;
    }
    Ok(())
}

async fn assert_ancestor_pages(browser: &Browser) -> Result<(), HarnessError> {
    for path in ["a", "a/b", "a/b/c"] {
        let (status, page) = browser.list(path, None).await?;
        assert_eq!(status, 200, "{page}");
        assert_eq!(page["data"]["path"], path);
        assert_eq!(page["data"]["next_after"], Value::Null);
    }
    for (parent, child, expected) in [
        ("a/b", "c", json!([{"name":"c"}, {"name":"d"}])),
        ("a", "b", json!([{"name":"b"}, {"name":"sibling"}])),
        (
            "",
            "a",
            json!([{"name":"a"}, {"name":"many"}, {"name":"outer"}]),
        ),
    ] {
        let (status, page) = browser.list(parent, None).await?;
        assert_eq!(status, 200, "{page}");
        assert_eq!(page["data"]["path"], parent);
        assert_eq!(page["data"]["folders"], expected);
        assert!(
            page["data"]["folders"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["name"] == child)
        );
        assert_eq!(page["data"]["next_after"], Value::Null);
        let (status, tail) = browser.list(parent, Some(child)).await?;
        assert_eq!(status, 200, "{tail}");
        assert_eq!(
            tail["data"]["folders"],
            json!(expected.as_array().unwrap()[1..])
        );
        assert_eq!(tail["data"]["next_after"], Value::Null);
    }
    Ok(())
}

async fn assert_pages(browser: &Browser) -> Result<(), HarnessError> {
    // Mixed case names exercise the case-folded ordering.
    let mut expected: Vec<String> = (0..205).map(|i| format!("Folder-{i:03}")).collect();
    expected.extend(["alpha", "Alpha-other", "Beta", "zebra"].map(str::to_owned));
    expected.sort_by_key(|name| (name.to_lowercase(), name.clone()));
    let mut all = Vec::new();
    let mut after = None;
    loop {
        let (status, page) = browser.list("many", after.as_deref()).await?;
        assert_eq!(status, 200, "{page}");
        let names: Vec<String> = page["data"]["folders"]
            .as_array()
            .expect("folders")
            .iter()
            .map(|folder| folder["name"].as_str().expect("name").to_owned())
            .collect();
        assert_eq!(
            names,
            expected[all.len()..(all.len() + 100).min(expected.len())]
        );
        assert_ne!(names.len(), 0);
        all.extend(names);
        after = page["data"]["next_after"].as_str().map(str::to_owned);
        if after.is_none() {
            break;
        }
        assert_eq!(after.as_ref(), all.last());
        assert!(all.len() < expected.len());
    }
    assert_eq!(
        all, expected,
        "complete, ordered and duplicate-free pagination"
    );
    Ok(())
}

async fn assert_refusals(browser: &Browser) -> Result<(), HarnessError> {
    for (path, status, code) in [
        ("..", 400, "project_folder_path_invalid"),
        ("a/../..", 400, "project_folder_path_invalid"),
        ("/abs", 400, "project_folder_path_invalid"),
        (r"C:\x", 400, "project_folder_path_invalid"),
        ("C:", 400, "project_folder_path_invalid"),
        (r"\\server\share", 400, "project_folder_path_invalid"),
        ("//server/share", 400, "project_folder_path_invalid"),
        ("outer//inner", 400, "project_folder_path_invalid"),
        ("outer/", 400, "project_folder_path_invalid"),
        ("escape", 403, "project_folder_outside_workspace"),
        ("missing", 404, "project_folder_not_found"),
        ("file.txt", 404, "project_folder_not_found"),
    ] {
        for (actual, body) in [
            browser.list(path, None).await?,
            browser.create(json!(path)).await?,
        ] {
            assert_eq!(actual, status, "{path}: {body}");
            assert_eq!(body["error"]["code"], code, "{path}: {body}");
        }
    }
    for path in [Value::Null, json!(""), json!(12)] {
        assert_eq!(browser.create(path).await?.0, 400);
    }
    Ok(())
}
