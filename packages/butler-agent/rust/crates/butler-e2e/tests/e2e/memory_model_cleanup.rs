//! Turning the memory model off preserves locked assets until startup can remove them.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::secure_fs::{fixture_links::directory_alias, fixture_locks::deny_delete};
use serde_json::json;
use std::{path::Path, time::Duration};

const MODEL: &str = "cache/models/Xenova/bge-m3";
const ASSETS: [&str; 4] = [
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "onnx/model_quantized.onnx",
];

fn setup(id: &str) -> Result<Setup, HarnessError> {
    let mut setup = Setup::new(id)?;
    // Keep DATA below the legacy path limit while its model assets cross it.
    // The public agent still uses its short isolated HOME as the working dir.
    let padding = 230_usize.saturating_sub(setup.sandbox.root.to_string_lossy().len() + 6);
    setup.sandbox.data = setup
        .sandbox
        .root
        .join(format!("data-{}", "x".repeat(padding)));
    std::fs::create_dir_all(&setup.sandbox.data)?;
    Ok(setup)
}

fn leftovers(data: &Path) -> Result<(), HarnessError> {
    let staging = data.join(MODEL).join(".native-embedding-acquire");
    std::fs::create_dir_all(&staging)?;
    for asset in ASSETS {
        let path = data.join(MODEL).join(asset);
        std::fs::create_dir_all(
            path.parent()
                .ok_or_else(|| std::io::Error::other("model asset has no parent"))?,
        )?;
        std::fs::write(path, b"interrupted model acquisition")?;
        std::fs::write(
            staging.join(format!("{}.part", asset.replace('/', "_"))),
            b"partial",
        )?;
    }
    Ok(())
}

async fn wait_removed(data: &Path) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while ASSETS
            .iter()
            .any(|asset| data.join(MODEL).join(asset).exists())
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?;
    let staging = data.join(MODEL).join(".native-embedding-acquire");
    assert!(ASSETS.iter().all(|asset| {
        !staging
            .join(format!("{}.part", asset.replace('/', "_")))
            .exists()
    }));
    Ok(())
}

#[tokio::test]
async fn off_removes_leftovers_and_startup_retries_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("MEMORY-MODEL-CLEANUP")?.start().await?;
    leftovers(&s.sandbox.data)?;
    let reply =
        s.gw.post("/setup/memory-model", json!({"enabled":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["memory_model"]["state"], "off");
    wait_removed(&s.sandbox.data).await?;
    let config = std::fs::read(s.sandbox.data.join("butler.config.json"))?;
    let config: serde_json::Value = serde_json::from_slice(&config)?;
    assert_eq!(config["memory"]["embeddings"], "off");
    s.agent.terminate().await?;
    leftovers(&s.sandbox.data)?;
    s.gw = s.agent.start_again().await?;
    wait_removed(&s.sandbox.data).await?;
    assert_eq!(
        s.gw.get("/setup/readiness").await?.data()["memory_model"]["state"],
        "off"
    );
    s.finish().await
}

#[tokio::test]
async fn off_keeps_a_delete_locked_file_until_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("MEMORY-MODEL-LOCKED-CLEANUP")?.start().await?;
    leftovers(&s.sandbox.data)?;
    let root = s.sandbox.data.join(MODEL);
    let path = root.join(ASSETS[3]);
    let lock = deny_delete(&path)?;
    // This native read handle denies delete sharing on Windows. Unix can unlink
    // an open file, so report that capability instead of claiming lock coverage.
    if std::fs::remove_file(&path).is_ok() {
        drop(lock);
        s.finish().await?;
        eprintln!("butler-e2e: SKIPPED (host permits deleting an open read handle)");
        return Ok(());
    }
    let reply =
        s.gw.post("/setup/memory-model", json!({"enabled":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["memory_model"]["state"], "off");
    assert!(path.is_file(), "locked model remains for startup retry");
    assert!(
        s.agent
            .logs()
            .contains("model files kept (embed_asset_unavailable)")
    );
    assert!(ASSETS[..3].iter().all(|asset| !root.join(asset).exists()));
    drop(lock);
    s.restart().await?;
    wait_removed(&s.sandbox.data).await?;
    assert_eq!(
        s.gw.get("/setup/readiness").await?.data()["memory_model"]["state"],
        "off"
    );
    s.finish().await
}

#[tokio::test]
async fn off_never_deletes_model_files_aliased_outside_data() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("MEMORY-MODEL-CLEANUP-CONTAINMENT")?
        .start()
        .await?;
    let outside = s.sandbox.data.with_file_name(format!(
        "{}-external",
        s.sandbox.data.file_name().unwrap().to_string_lossy()
    ));
    leftovers(&outside)?;
    let model: std::path::PathBuf = s.sandbox.data.join(MODEL).components().collect();
    std::fs::create_dir_all(model.parent().unwrap())?;
    let external = butler_platform::secure_fs::canonicalize(outside.join(MODEL))?;
    directory_alias(&external, &model)?;
    let reply =
        s.gw.post("/setup/memory-model", json!({"enabled":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["memory_model"]["state"], "off");
    assert!(
        s.agent
            .logs()
            .contains("model files kept (embed_asset_path_unsafe)")
    );
    s.restart().await?;
    for asset in ASSETS {
        assert_eq!(
            std::fs::read(outside.join(MODEL).join(asset))?,
            b"interrupted model acquisition"
        );
    }
    s.finish().await
}
