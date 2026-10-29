//! Interrupted turns cannot permanently consume the process staging quota.
use super::*;
use butler_platform::data_paths::READER_STAGING;

const BYTES: u64 = 100 * 1024 * 1024;

#[tokio::test]
async fn staging_recovers_after_normal_stop_and_kill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for crash in [false, true] {
        let files: Vec<_> = (0..10)
            .map(|n| json!({"path":format!("part-{n}.txt")}))
            .collect();
        let upload = || {
            call(
                "browser_act",
                json!({"tab":"pub","observation":"obs-1",
            "steps":[{"action":"upload","ref":"e1","value":"large.txt"}]}),
            )
        };
        let setup = Setup::new("STAGING-RESTART")?.stub_cassette(host::cassette(&[
            (
                "Interrupted delivery".into(),
                vec![call("deliver_files", json!({"files":files}))],
            ),
            (
                "Fresh upload".into(),
                vec![call("browser_observe", json!({"tab":"pub"})), upload()],
            ),
        ])?);
        let data = setup.sandbox.data.clone();
        let preserved = data.join("preserved");
        std::fs::create_dir(&preserved)?;
        std::fs::write(preserved.join("keep.txt"), "complete-public")?;
        for n in 0..10 {
            std::fs::File::create(data.join(format!("part-{n}.txt")))?.set_len(BYTES / 10)?;
        }
        std::fs::File::create(data.join("large.txt"))?.set_len(BYTES)?;
        let mut s = setup.start().await?;
        // Let tool discovery return, then hold the model reply after delivery.
        // The turn is still executing, with every staged byte owned by it.
        s.provider()?
            .hold_after_tool("Interrupted delivery")
            .release();
        let held = s.provider()?.hold_after_tool("Interrupted delivery");
        let accepted = s.gw.say("general", "Interrupted delivery").await?;
        let turn = s.gw.accepted_turn(&accepted).await?;
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while stage_bytes(&data)? != BYTES {
            assert!(
                std::time::Instant::now() < deadline,
                "all ten deliveries must stage"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let active = s.gw.turn("general", &turn).await?.unwrap();
        assert_ne!(active["state"], "delivered");
        if crash {
            s.agent.kill9()?;
        } else {
            let stop = s.agent.cli(&["stop", "--json"])?;
            assert_eq!(stop.code, Some(0), "normal stop failed: {}", stop.stderr);
            assert!(s.agent.reap().unwrap().success());
            assert_eq!(stage_bytes(&data)?, 0, "normal stop consumes stages");
        }
        held.release();
        // Also exceed the folder quota left by interrupted copies. A startup
        // reset must clear both accounting dimensions, before admission.
        for n in 0..1024 {
            std::fs::create_dir_all(data.join(READER_STAGING).join(format!("stale-{n}")))?;
        }
        if butler_platform::secure_fs::NO_FOLLOW {
            butler_platform::secure_fs::symlink(
                &preserved,
                &data.join(READER_STAGING).join("alias"),
            )?;
        }
        s.gw = s.agent.start_again().await?;
        assert_eq!(
            std::fs::read_to_string(preserved.join("keep.txt"))?,
            "complete-public"
        );
        assert_eq!(stage_bytes(&data)?, 0);
        let base = data.join(READER_STAGING);
        assert!(!base.exists() || std::fs::read_dir(&base)?.next().is_none());
        let host = Host::attach(&s).await?;
        let (turn, card) = ask(&s, "Fresh upload").await?;
        allow(&s, &turn, &card.expect("upload approval")).await?;
        let uploads = host.uploads();
        assert_eq!(uploads.len(), 1);
        assert_eq!(uploads[0].len() as u64, BYTES);
        assert!(
            uploads[0].bytes().all(|byte| byte == 0),
            "complete source bytes"
        );
        assert_eq!(stage_bytes(&data)?, 0);
        eprintln!(
            "staging restart crash={crash}: 100 MiB delivery interrupted, 1024 stale folders cleared, 100 MiB upload complete"
        );
        drop(host);
        if butler_platform::secure_fs::NO_FOLLOW {
            // Test the staging root itself as a link while the Agent is stopped.
            s.agent.terminate().await?;
            if base.exists() {
                std::fs::remove_dir(&base)?;
            }
            butler_platform::secure_fs::symlink(&preserved, &base)?;
            s.gw = s.agent.start_again().await?;
            assert!(!std::fs::symlink_metadata(&base).is_ok_and(|m| m.file_type().is_symlink()));
            assert!(!base.exists() || std::fs::read_dir(&base)?.next().is_none());
            assert_eq!(
                std::fs::read_to_string(preserved.join("keep.txt"))?,
                "complete-public"
            );
        }
        s.finish().await?;
    }
    Ok(())
}

fn stage_bytes(data: &std::path::Path) -> std::io::Result<u64> {
    let base = data.join(READER_STAGING);
    if !base.exists() {
        return Ok(0);
    }
    let mut bytes = 0;
    for directory in std::fs::read_dir(base)? {
        for file in std::fs::read_dir(directory?.path())? {
            bytes += file?.metadata()?.len();
        }
    }
    Ok(bytes)
}
