//! Drift and density are reserved for modules bundled with the app.

use super::{Entry, FRAGMENT, IMPORT, archive, failure, manifest, message, module_ids};
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::secure_fs::FileMode;
use serde_json::{Value, json};

/// WALL-08 — User imports keep the legacy motion rule and reject bundled-only density.
#[tokio::test]
async fn wall_08_user_import_rejects_bundle_only_manifest_fields() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WALL-08")?.start().await?;
    for (field, value, expected) in [
        (
            "motion",
            json!("drift"),
            "motion: must be static or animated",
        ),
        (
            "density",
            json!(true),
            "density: is only available to bundled modules",
        ),
    ] {
        let mut value_manifest: Value = serde_json::from_str(&manifest("user.drift-test")).unwrap();
        value_manifest[field] = value;
        let text = value_manifest.to_string();
        let bytes = archive(&[
            Entry::File("wallpaper.json", text.as_bytes(), FileMode::ORDINARY),
            Entry::File("shader.frag", FRAGMENT.as_bytes(), FileMode::ORDINARY),
        ]);
        let refused =
            s.gw.upload_file(IMPORT, "drift.zip", "application/zip", &bytes)
                .await?;
        assert_eq!(
            failure(&refused),
            (400, "wallpaper_module_invalid"),
            "{field}: {}",
            refused.text
        );
        assert!(
            message(&refused).contains(expected),
            "{expected}: {}",
            refused.text
        );
    }
    assert_eq!(module_ids(&s.gw).await?, Vec::<String>::new());
    s.finish().await
}
