//! Dev-only subprocess fixture: real provider serializer and durable TurnStore.
//! Accepts only a loopback endpoint. The E2E harness owns and kills this process.
#[path = "round_store/driver.rs"]
mod driver;
#[path = "round_store/provider.rs"]
mod support;
use butler_turn::btcc::{self, *};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Instant};
use url::Url;

type Error = Box<dyn std::error::Error>;

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [path, endpoint, model, rounds, mode] = args.as_slice() else {
        return Err("expected path endpoint model rounds mode".into());
    };
    let rounds: usize = rounds.parse()?;
    let endpoint = Url::parse(endpoint)?;
    if endpoint.host_str() != Some("127.0.0.1") {
        return Err("fixture requires loopback".into());
    }
    let fixture = btcc::storage::TestStorageFixture::activated();
    let mut config = fixture.config(&format!("round-store-{}", std::process::id()));
    std::fs::create_dir_all(Path::new(path).parent().ok_or("missing parent")?)?;
    if !Path::new(path).exists() {
        std::fs::copy(&config.path, path)?;
    }
    config.path = path.into();
    config.process_liveness = std::sync::Arc::new(driver::LivenessProbe);
    let start = Instant::now();
    let store = BtccStorage::open(config).await?;
    let repositories = BtccRepositories::new(store, None);
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    let prepared = btcc::storage::test_prepared_turn();
    let (mut turn, _) = repositories.load_or_admit(&prepared).await?;
    let mut claim = repositories.acquire_state_claim(&turn).await?;
    if mode == "init" {
        repositories.close().await?;
        return Ok(());
    }
    let provider = driver::provider(endpoint)?;
    let mut messages = vec![ModelRoundMessage::user(
        "Inspect the synthetic workspace and report the result.".into(),
        None,
    )];
    let mut continuation = None;
    let mut seed_result = None;
    let mut hashes = Vec::new();
    let mut full_rows = Vec::new();
    let mut times = Vec::new();
    let mut write_times = Vec::new();
    let start = Instant::now();
    let first = if mode == "latest" {
        rounds.saturating_sub(1)
    } else {
        0
    };
    if mode == "latest" {
        driver::outputs(&mut messages, 0..first);
    }
    for round in first..rounds {
        if mode == "checkpoint" && round == 2 {
            (turn, claim) = driver::resume(&repositories, &turn, &claim, path).await?;
        }
        let key = driver::key(&turn, &claim, model, round);
        let begin = Instant::now();
        let result = if mode == "replay" || mode == "latest" {
            repositories
                .load_model_round_acceptance(key)
                .await?
                .ok_or("missing accepted row")?
        } else {
            let mut result = if mode == "seed" && round > 0 {
                driver::seed(seed_result.as_ref().ok_or("missing seed result")?, round)?
            } else {
                driver::request(&provider, model, &messages, continuation.as_ref()).await?
            };
            if mode == "write" && round == 4 {
                driver::reorder_item(&mut result)?;
                driver::literal_item(&mut result)?;
            }
            if mode == "seed" {
                seed_result = Some(result.clone());
            }
            let write = ModelRoundAcceptanceWrite {
                binding: ModelRouteWrite {
                    turn_id: turn.turn_id.clone(),
                    expected_revision: turn.revision,
                    execution_fence: turn.execution_fence,
                    claim_id: claim.claim_id.clone(),
                    route: None,
                },
                key,
                transport_attempt: 1,
                result: Box::new(result.clone()),
            };
            let begin_write = Instant::now();
            repositories
                .record_model_round_acceptance(write.clone())
                .await?;
            write_times.push(begin_write.elapsed().as_secs_f64() * 1000.0);
            if mode == "write" && round == 2 {
                driver::duplicate(&repositories, write).await?;
            }
            result
        };
        times.push(begin.elapsed().as_secs_f64() * 1000.0);
        let raw = butler_core::json::stringify(&serde_json::to_value(&result)?)?;
        hashes.push(format!("{:x}", Sha256::digest(raw.as_bytes())));
        if mode == "seed" {
            full_rows.clear();
        }
        if mode == "seed" || mode == "write" {
            full_rows.push(raw);
        }
        continuation = result.continuation;
        driver::outputs(&mut messages, round..round + 1);
    }
    let report = json!({"open_ms":open_ms,"rounds_ms":start.elapsed().as_secs_f64()*1000.0,"round_ms":times,"write_ms":write_times,"hashes":hashes,"full_rows":full_rows});
    std::fs::write(
        Path::new(path).with_extension(format!("{mode}.json")),
        serde_json::to_vec(&report)?,
    )?;
    driver::request(&provider, model, &messages, continuation.as_ref()).await?;
    repositories.close().await?;
    Ok(())
}
