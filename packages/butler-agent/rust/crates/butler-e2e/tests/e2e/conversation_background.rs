//! CBG: independent conversation sources over the shared wallpaper library.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, media, scenario::Setup};
use serde_json::{Value, json};
#[path = "conversation_background/resources.rs"]
mod resources;

fn riso() -> Value {
    json!({"kind":"live", "module":"butler.riso-print"})
}
fn image(id: &str) -> Value {
    json!({"kind":"image", "asset":id, "fit":"cover", "dim":0, "blur":0})
}

#[tokio::test]
async fn cbg_01_defaults_and_partial_patches_survive_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CBG-01")?.start().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(
        settings["conversation_background"],
        json!({"source":riso(), "overlay":70})
    );
    assert_eq!(settings["wallpaper"]["source"], riso());
    let bloom =
        |colors| json!({"kind":"live", "module":"butler.bloom", "params":{"colors":colors}});
    let home =
        s.gw.patch("/settings", json!({"wallpaper":{"source":bloom("aurora")}}))
            .await?;
    assert_eq!(home.status, 200, "{}", home.text);
    for patch in [json!({"source":bloom("monochrome")}), json!({"overlay":35})] {
        let reply =
            s.gw.patch("/settings", json!({"conversation_background":patch}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(reply.data()["wallpaper"], home.data()["wallpaper"]);
    }
    s.restart().await?;
    let settings = s.gw.settings().await?;
    assert_eq!(
        settings["conversation_background"],
        json!({"source":bloom("monochrome"), "overlay":35})
    );
    assert_eq!(settings["wallpaper"], home.data()["wallpaper"]);
    let changed_home =
        s.gw.patch("/settings", json!({"wallpaper":{"source":{"kind":"none"}}}))
            .await?;
    assert_eq!(changed_home.status, 200, "{}", changed_home.text);
    assert_eq!(
        changed_home.data()["conversation_background"],
        settings["conversation_background"]
    );
    let events = s.gw.events_since(0).await?;
    assert!(events.iter().any(|e| e["type"] == "settings.updated"
        && e["payload"]["settings"]["conversation_background"]
            == settings["conversation_background"]));
    s.finish().await
}

#[tokio::test]
async fn cbg_02_strict_overlay_and_source_validation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-02")?.start().await?;
    let before = s.gw.settings().await?;
    for invalid in [
        json!({}),
        json!(null),
        json!({"overlay":-5}),
        json!({"overlay":100}),
        json!({"overlay":1}),
        json!({"overlay":70.5}),
        json!({"overlay":"70"}),
        json!({"overlay":null}),
        json!({"other":70}),
        json!({"source":{"kind":"video"}}),
        json!({"source":{"kind":"live", "module":"../bad"}}),
        json!({"source":{"kind":"live", "module":"butler.bloom", "params":{"Speed":1}}}),
        json!({"source":image("wp_missing123")}),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"conversation_background":invalid}))
                .await?;
        assert_eq!(reply.status, 400, "{invalid}: {}", reply.text);
        assert_eq!(
            reply.error_code(),
            Some("settings_conversation_background_invalid")
        );
        assert_eq!(s.gw.settings().await?, before);
    }
    for overlay in (0..=95).step_by(5) {
        let reply =
            s.gw.patch(
                "/settings",
                json!({"conversation_background":{"overlay":overlay}}),
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(reply.data()["conversation_background"]["overlay"], overlay);
    }
    s.finish().await
}

#[tokio::test]
async fn cbg_03_images_share_library_and_delete_protection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-03")?.start().await?;
    let uploaded =
        s.gw.upload_file(
            "/wallpapers",
            "photo.png",
            "image/png",
            &media::digits_png("7", 2),
        )
        .await?;
    assert_eq!(uploaded.status, 201, "{}", uploaded.text);
    let id = uploaded.data()["id"].as_str().unwrap();
    for key in ["wallpaper", "conversation_background"] {
        let reply =
            s.gw.patch("/settings", json!({key:{"source":image(id)}}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let refused = s.gw.delete(&format!("/wallpapers/{id}")).await?;
        assert_eq!(refused.status, 409, "{}", refused.text);
        assert_eq!(refused.error_code(), Some("wallpaper_in_use"));
        let cleared =
            s.gw.patch("/settings", json!({key:{"source":{"kind":"none"}}}))
                .await?;
        assert_eq!(cleared.status, 200, "{}", cleared.text);
    }
    assert_eq!(s.gw.delete(&format!("/wallpapers/{id}")).await?.status, 200);
    s.finish().await
}

fn store(data: &std::path::Path, settings: &Value) {
    let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute(
        "UPDATE app_settings SET value_json=?1 WHERE key='settings'",
        [settings.to_string()],
    )
    .unwrap();
}

#[tokio::test]
async fn cbg_04_missing_sources_fall_back_without_rewriting_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-04")?.start().await?;
    for source in [
        json!({"kind":"live", "module":"user.gone"}),
        image("wp_missing123"),
        json!({"kind":"image", "asset":"wp_missing123", "fit":"cover", "dim":0, "blur":0, "filter":{"module":"user.gone"}}),
    ] {
        let stored = json!({"wallpaper":{"source":source, "origin":"chosen"}, "conversation_background":{"source":source,"overlay":25}});
        store(&s.sandbox.data, &stored);
        let settings = s.gw.settings().await?;
        assert_eq!(settings["wallpaper"]["source"], riso());
        assert_eq!(
            settings["conversation_background"],
            json!({"source":riso(), "overlay":25})
        );
        let db =
            butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
                .unwrap();
        let raw: String = db
            .query_row(
                "SELECT value_json FROM app_settings WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), stored);
        if source["kind"] == "image" {
            let refused =
                s.gw.patch(
                    "/settings",
                    json!({"conversation_background":{"source":source}}),
                )
                .await?;
            assert_eq!(
                refused.status, 400,
                "an unchanged missing image is still validated: {}",
                refused.text
            );
        }
    }
    s.finish().await
}

#[tokio::test]
async fn cbg_05_legacy_default_migrates_but_choices_stay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-05")?.start().await?;
    let bloom = json!({"kind":"live","module":"butler.bloom","params":{"colors":"monochrome"}});
    let silk = json!({"kind":"live","module":"butler.silk"});
    let none = json!({"kind":"none"});
    let aurora = json!({"kind":"live","module":"butler.bloom","params":{"colors":"aurora"}});
    for (stored, expected) in [
        (
            json!({"wallpaper":{"source":bloom,"origin":"legacy"}}),
            riso(),
        ),
        (
            json!({"main_screen_theme":"bloom","main_screen_theme_preset":"monochrome"}),
            riso(),
        ),
        (
            json!({"wallpaper":{"source":bloom,"origin":"chosen"}}),
            bloom,
        ),
        (json!({"wallpaper":{"source":silk,"origin":"chosen"}}), silk),
        (json!({"wallpaper":{"source":none,"origin":"legacy"}}), none),
        (
            json!({"wallpaper":{"source":aurora,"origin":"legacy"}}),
            aurora,
        ),
    ] {
        store(&s.sandbox.data, &stored);
        assert_eq!(
            s.gw.settings().await?["wallpaper"]["source"],
            expected,
            "{stored}"
        );
    }
    s.finish().await
}

#[tokio::test]
async fn cbg_06_user_module_delete_is_protected_and_external_removal_falls_back()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-06")?.start().await?;
    let folder = s.sandbox.data.join("wallpapers/user.cbg");
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("wallpaper.json"), json!({"id":"user.cbg","name":{"en":"Print","ko":"프린트"},"version":"1.0.0","engine":1,"motion":"static","image":"none","params":[]}).to_string())?;
    std::fs::write(
        folder.join("shader.frag"),
        "void main(){fragColor=vec4(1.);}",
    )?;
    let source = json!({"kind":"live", "module":"user.cbg"});
    for key in ["wallpaper", "conversation_background"] {
        let reply =
            s.gw.patch("/settings", json!({key:{"source":source}}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(s.gw.settings().await?[key]["source"], source);
        let refused = s.gw.delete("/wallpaper-modules/user.cbg").await?;
        assert_eq!(refused.status, 409, "{}", refused.text);
        assert_eq!(refused.error_code(), Some("wallpaper_in_use"));
        let cleared =
            s.gw.patch("/settings", json!({key:{"source":{"kind":"none"}}}))
                .await?;
        assert_eq!(cleared.status, 200, "{}", cleared.text);
    }
    let chosen =
        s.gw.patch(
            "/settings",
            json!({"conversation_background":{"source":source}}),
        )
        .await?;
    assert_eq!(chosen.status, 200, "{}", chosen.text);
    std::fs::remove_dir_all(&folder)?;
    assert_eq!(
        s.gw.settings().await?["conversation_background"]["source"],
        riso()
    );
    s.finish().await
}
