//! Complete-content timing for fd opens and the public file/grep readers.
use super::*;
use butler_platform::{secure_fs, secure_fs::SecretInventory};
use butler_turn::workspace::{GrepCandidate, PathForm, WorkspaceFiles};
use std::{io::Read, sync::Arc, time::Instant};

#[tokio::test]
async fn perf_contained_opens_and_5000_file_readers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::secure_fs::FILE_IDS, "Unix reader timing");
    let mut s = Setup::new("LINUX-CONTAINED-PERF")?;
    let root = &s.sandbox.workspace;
    let inventory = SecretInventory::cached(&s.sandbox.data);
    let _pin = inventory.pin_root(root)?;
    for depth in [1, 5, 10] {
        let path = PathBuf::from_iter(std::iter::repeat_n("d", depth - 1)).join("file");
        std::fs::create_dir_all(root.join(&path).parent().unwrap())?;
        std::fs::write(root.join(&path), "complete-public")?;
        let started = Instant::now();
        for _ in 0..1000 {
            let mut text = String::new();
            secure_fs::open_contained(root, &path, &inventory)?.read_to_string(&mut text)?;
            assert_eq!(text, "complete-public");
        }
        eprintln!(
            "CONTAINED-OPEN components={depth} mean_us={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    for index in 0..5000 {
        let dir = root.join(format!("tree/d{}", index / 100));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(format!("f{index}")), format!("complete-{index}\n"))?;
    }
    for linked in [false, true] {
        if linked {
            for index in 0..5000 {
                std::fs::hard_link(
                    root.join(format!("tree/d{}/f{index}", index / 100)),
                    root.join(format!("copy-{index}")),
                )?;
            }
        }
        measure_readers(root, &s.sandbox.data, linked).await?;
    }
    s.sandbox.mark_success();
    Ok(())
}

async fn measure_readers(root: &Path, data: &Path, linked: bool) -> Result<(), HarnessError> {
    let owner = WorkspaceFiles::new(1);
    let started = Instant::now();
    let mut read_bytes = 0;
    for batch in 0..250 {
        let request = owner.request();
        for index in batch * 20..(batch + 1) * 20 {
            let path = format!("tree/d{}/f{index}", index / 100);
            let result = request
                .read_one(butler_turn::workspace::ReadFileInput {
                    butler_data: data.to_path_buf(),
                    root: root.to_path_buf(),
                    path,
                    path_form: PathForm::Contained,
                    protected_roots: Vec::new(),
                    start_line: None,
                    limit_lines: None,
                    max_bytes: 262_144,
                    offset_bytes: None,
                })
                .await
                .unwrap()?
                .result;
            let expected = format!("complete-{index}\n");
            assert_eq!(result["content"], expected);
            assert_eq!(result["bytes"], expected.len());
            read_bytes += expected.len();
        }
    }
    eprintln!(
        "CONTAINED-READ files=5000 nlink={} bytes={read_bytes} elapsed_ms={:.3}",
        if linked { 2 } else { 1 },
        started.elapsed().as_secs_f64() * 1000.0
    );
    let matcher = Arc::new(regress::Regex::new("complete").unwrap());
    let request = owner.request();
    let started = Instant::now();
    let mut matches = 0;
    for index in 0..5000 {
        let path = format!("tree/d{}/f{index}", index / 100);
        let expected = format!("complete-{index}");
        let result = request
            .grep_candidate(GrepCandidate {
                butler_data: data.to_path_buf(),
                root: root.to_path_buf(),
                path_form: PathForm::Contained,
                protected_roots: Vec::new(),
                path: path.clone(),
                bytes: expected.len() as u64 + 1,
                matcher: matcher.clone(),
                context_lines: 0,
                max_bytes_per_file: 1024,
                max_matches: 10,
                max_output_bytes: 1024,
                after_line: None,
                deadline: Instant::now() + Duration::from_secs(60),
            })
            .await
            .unwrap();
        assert!(!result.skipped);
        assert_eq!(result.bytes_read, expected.len() + 1);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, path);
        assert_eq!(result.matches[0].line, 1);
        assert_eq!(result.matches[0].text, expected);
        matches += result.matches.len();
    }
    assert_eq!(matches, 5000);
    eprintln!(
        "CONTAINED-GREP files=5000 nlink={} matches={matches} elapsed_ms={:.3}",
        if linked { 2 } else { 1 },
        started.elapsed().as_secs_f64() * 1000.0
    );
    owner.close().await;
    Ok(())
}
