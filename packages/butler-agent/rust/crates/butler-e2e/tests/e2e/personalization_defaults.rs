//! First-install defaults through the real agent and stub provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Fixture, Setup},
};
use serde_json::json;

#[tokio::test]
async fn fresh_korean_defaults_and_user_edits_survive_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let cassette = Cassette::load("Q-02")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let model = cassette.meta.model.clone();
    let effort = cassette.meta.effort.clone();
    let setup = Setup::new("LANG-EOL")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette);
    std::fs::write(
        setup.sandbox.data.join("butler.config.json"),
        json!({"user":{"language":"ko"}}).to_string(),
    )?;
    fixtures_ready(&setup)?;
    let template =
        std::fs::read_to_string(setup.sandbox.resources.join("templates/eol.template.md"))?;
    let mut s = setup.start().await?;
    let view = s.gw.get("/personalization").await?;
    assert_eq!(view.data()["eol"], template);
    assert_ne!(template.trim(), "");
    assert!(
        view.data()["persona"]
            .as_str()
            .unwrap()
            .contains("base: butler")
    );
    assert!(
        view.data()["persona"]
            .as_str()
            .unwrap()
            .contains("base_locale: ko")
    );
    assert_eq!(view.data()["response_language"], "ko");
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(config["user"]["responseLanguageDefaultSource"], "installer");
    s.gw.patch(
        "/settings",
        json!({"model":model, "reasoning_effort":effort}),
    )
    .await?;
    let (_, turn) = s.turn("general", &prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert!(
        requests[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("Use Korean")
    );
    // Deletion during a running process must be repaired before admission, too.
    std::fs::remove_file(s.sandbox.data.join("eol.md"))?;
    let (_, turn) = s.turn("general", &prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("eol.md"))?,
        template
    );
    assert!(
        s.provider()?.requests().last().unwrap()["instructions"]
            .as_str()
            .unwrap()
            .contains(template.trim())
    );
    std::fs::write(s.sandbox.data.join("eol.md"), "")?;
    assert_eq!(s.gw.get("/personalization").await?.data()["eol"], template);
    let edited = "My own soul document.";
    s.gw.patch(
        "/personalization",
        json!({"eol":edited,"persona":"My own persona.","response_language":"en"}),
    )
    .await?;
    s.restart().await?;
    let view = s.gw.get("/personalization").await?;
    assert_eq!(view.data()["eol"], edited);
    assert_eq!(view.data()["persona"], "My own persona.");
    assert_eq!(view.data()["response_language"], "en");
    let modified = std::fs::metadata(s.sandbox.data.join("eol.md"))?.modified()?;
    s.restart().await?;
    assert_eq!(
        std::fs::metadata(s.sandbox.data.join("eol.md"))?.modified()?,
        modified
    );
    s.finish().await
}

fn fixtures_ready(setup: &Setup) -> Result<(), HarnessError> {
    butler_e2e::e2e::fixtures::onboarding_complete(&setup.sandbox.data)?;
    butler_e2e::e2e::fixtures::scheduler_ran_today(
        &setup.sandbox.data,
        butler_e2e::e2e::fixtures::FIXTURE_TIME,
    )
}

#[tokio::test]
async fn empty_eol_and_missing_reply_key_migrate_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("LANG-EOL-MIGRATE")?.fixture(Fixture::Empty);
    std::fs::write(setup.sandbox.data.join("eol.md"), " \n")?;
    let mut s = setup.start().await?;
    s.gw.patch("/settings", json!({"language":"ko"})).await?;
    let view = s.gw.get("/personalization").await?;
    assert_eq!(view.data()["response_language"], "ko");
    assert_eq!(
        view.data()["eol"],
        std::fs::read_to_string(s.sandbox.resources.join("templates/eol.template.md"))?
    );
    s.gw.patch("/settings", json!({"language":"en"})).await?;
    s.restart().await?;
    assert_eq!(
        s.gw.get("/personalization").await?.data()["response_language"],
        "ko"
    );
    s.gw.patch("/personalization", json!({"response_language":"en"}))
        .await?;
    s.gw.patch("/settings", json!({"language":"ko"})).await?;
    s.restart().await?;
    assert_eq!(
        s.gw.get("/personalization").await?.data()["response_language"],
        "en"
    );
    s.finish().await
}

#[tokio::test]
async fn stored_ui_language_and_explicit_english_are_distinct() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let cassette = Cassette::load("Q-02")?;
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let mut s = Setup::new("LANG-UI")?
        .stub_cassette(cassette)
        .fixture(Fixture::Empty)
        .start()
        .await?;
    s.gw.patch("/settings", json!({"language":"ko"})).await?;
    s.agent.terminate().await?;
    let config = s.sandbox.data.join("butler.config.json");
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&config)?)?;
    let user = value["user"].as_object_mut().unwrap();
    user.insert("language".into(), json!("en"));
    user.remove("responseLanguage");
    user.remove("responseLanguageDefaultSource");
    std::fs::write(&config, value.to_string())?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        s.gw.get("/personalization").await?.data()["response_language"],
        "ko"
    );
    let persisted: serde_json::Value = serde_json::from_slice(&std::fs::read(&config)?)?;
    assert_eq!(persisted["user"]["responseLanguageDefaultSource"], "ui");
    butler_e2e::e2e::fixtures::onboarding_complete(&s.sandbox.data)?;
    s.select_model(&s.model).await?;
    let (_, turn) = s.turn("general", &prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(
        s.provider()?.requests()[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("Use Korean")
    );
    s.agent.terminate().await?;
    value["user"]["responseLanguage"] = json!("en");
    std::fs::write(&config, value.to_string())?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        s.gw.get("/personalization").await?.data()["response_language"],
        "en"
    );
    s.finish().await
}

#[tokio::test]
async fn os_locale_is_last_resort_and_defaults_write_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (installer, locale, expected) in [
        (None, "ko_KR.UTF-8", "ko"),
        (Some("en"), "ko_KR.UTF-8", "en"),
        (None, "C", "en"),
    ] {
        let setup = Setup::new("LANG-OS")?
            .fixture(Fixture::Empty)
            .env("LC_ALL", locale);
        if let Some(installer) = installer {
            std::fs::write(
                setup.sandbox.data.join("butler.config.json"),
                json!({"user":{"language":installer}}).to_string(),
            )?;
        }
        let mut s = setup.start().await?;
        assert_eq!(
            s.gw.get("/personalization").await?.data()["response_language"],
            expected
        );
        let config = s.sandbox.data.join("butler.config.json");
        let persisted: serde_json::Value = serde_json::from_slice(&std::fs::read(&config)?)?;
        assert_eq!(
            persisted["user"]["responseLanguageDefaultSource"],
            if installer.is_some() {
                "installer"
            } else {
                "fallback"
            }
        );
        let eol = s.sandbox.data.join("eol.md");
        let persona = s.sandbox.data.join("personas/active.md");
        let timestamps = [
            std::fs::metadata(&config)?.modified()?,
            std::fs::metadata(&eol)?.modified()?,
            std::fs::metadata(&persona)?.modified()?,
        ];
        s.agent.launch.set_env("LC_ALL", "en_US.UTF-8");
        s.restart().await?;
        assert_eq!(
            s.gw.get("/personalization").await?.data()["response_language"],
            expected
        );
        assert_eq!(
            [
                std::fs::metadata(&config)?.modified()?,
                std::fs::metadata(&eol)?.modified()?,
                std::fs::metadata(&persona)?.modified()?
            ],
            timestamps
        );
        s.finish().await?;
    }
    Ok(())
}
