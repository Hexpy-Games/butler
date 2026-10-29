use super::{git_support::*, *};

#[tokio::test]
async fn pg8_git_pins_registry_digest_validation_and_provenance() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = git_setup("PG8")?;
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    repo.git(&repo.work, &["add", "--all"]);
    repo.git(&repo.work, &["update-index", "--chmod=+x", "server.exe"]);
    let sha = repo.publish();
    repo.git(&repo.work, &["tag", "stable"]);
    repo.git(&repo.work, &["push", "origin", "stable"]);
    let registry = Repo::new(&setup.sandbox.home, "team", false)?;
    fs::write(
        registry.work.join("butler-registry.json"),
        json!({"plugins":[{"name":"helper","git":repo.url,"commit":sha,"digest":"0".repeat(64)}]})
            .to_string(),
    )?;
    let registry_sha = registry.publish();
    let s = setup.start().await?;
    let i = inspect_source(&s, json!({"git":repo.url,"ref":"stable"})).await?;
    assert_eq!(i["pin"]["commit"], sha);
    let expected = i["digest"].clone();
    assert_eq!(expected, git_digest(&repo)?);
    // Install an exact commit, independently of a moving ref.
    install_source(&s, json!({"git":repo.url,"commit":sha})).await?;
    let p = inventory(&s).await?;
    assert_eq!(p["content_digest"], expected);
    assert_eq!(p["pin"]["commit"], sha);
    let r = api(
        &s,
        Method::DELETE,
        &format!("/plugins/helper?revision={}", revision(&s).await?),
        None,
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(empty(&s.sandbox.data.join("plugins/sources")));
    let r = api(
        &s,
        Method::POST,
        "/plugin-registries",
        Some(json!({"url":registry.url,"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    let id = r.data()["id"].as_str().unwrap().to_owned();
    assert_eq!(r.data()["registry"]["commit"], registry_sha);
    let staged_before = fs::read_dir(s.sandbox.data.join("plugins/staging"))?.count();
    let refused = api(
        &s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"registry":id,"name":"helper"})),
    )
    .await?;
    assert_eq!(refused.status, 400, "{refused:?}");
    assert!(refused.text.contains("plugin_registry_digest_mismatch"));
    assert_eq!(
        fs::read_dir(s.sandbox.data.join("plugins/staging"))?.count(),
        staged_before
    );
    assert!(empty(&s.sandbox.data.join("plugins/store")));
    edit(&registry.work.join("butler-registry.json"), |v| {
        v["plugins"][0]["digest"] = expected.clone();
    });
    let registry_sha = registry.publish();
    let r = api(
        &s,
        Method::POST,
        &format!("/plugin-registries/{id}/refresh"),
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    let i = install_source(&s, json!({"registry":id,"name":"helper"})).await?;
    assert_eq!(i["listed_in"]["registry"], id);
    assert_eq!(i["pin"]["registry_commit"], registry_sha);
    assert_eq!(inventory(&s).await?["listed_in"]["registry"], id);
    echo(&s, "package-output").await?;
    let r = api(&s, Method::GET, "/plugin-registries", None).await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(r.data()["registries"][&id]["commit"], registry_sha);
    let refused = api(
        &s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"git":"https://username:password@example.invalid/plugin"})),
    )
    .await?;
    assert_eq!(refused.status, 400);
    assert!(!refused.text.contains("password"));
    let removed = api(
        &s,
        Method::DELETE,
        &format!("/plugin-registries/{id}?revision={}", revision(&s).await?),
        None,
    )
    .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_eq!(
        fs::read_dir(s.sandbox.data.join("plugins/sources"))?.count(),
        1
    );
    let removed = api(
        &s,
        Method::DELETE,
        &format!("/plugins/helper?revision={}", revision(&s).await?),
        None,
    )
    .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert!(empty(&s.sandbox.data.join("plugins/sources")));
    assert!(empty(&s.sandbox.data.join("plugins/store")));
    s.finish().await
}

#[tokio::test]
async fn pg11_offline_and_six_hour_check_throttle_are_non_mutating() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = git_setup("PG11-THROTTLE")?;
    let trace = setup.sandbox.home.join("git-trace");
    let setup = setup.env("GIT_TRACE", trace.to_string_lossy());
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    repo.publish();
    let s = setup.start().await?;
    install_source(&s, json!({"git":repo.url})).await?;
    let fetches = || {
        fs::read_to_string(&trace)
            .unwrap()
            .lines()
            .filter(|l| l.contains("built-in: git") && l.contains(" fetch "))
            .count()
    };
    let before = fetches();
    assert_eq!(check(&s, false).await?["status"], "up_to_date");
    let once = fetches();
    assert_eq!(once, before + 1);
    assert_eq!(check(&s, false).await?["status"], "up_to_date");
    assert_eq!(fetches(), once);
    assert_eq!(check(&s, true).await?["status"], "up_to_date");
    assert_eq!(fetches(), once + 1);
    let bytes = fs::read(s.sandbox.data.join("plugins/registry.json"))?;
    fs::rename(&repo.bare, repo.home.join("unreachable.git"))?;
    assert_eq!(check(&s, true).await?["status"], "error");
    assert_eq!(
        fs::read(s.sandbox.data.join("plugins/registry.json"))?,
        bytes
    );
    echo(&s, "package-output").await?;
    s.finish().await
}
