use super::*;
use std::io::Write;

#[test]
fn app_index_skips_oversized_lines_without_duplicates() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let dir = root.join("logs/app/main");
    fs::create_dir_all(&dir)?;
    let path = dir.join("20261019T000000Z-0001.jsonl");
    let mut file = fs::File::create(&path)?;
    let query = Query {
        source: "app".into(),
        ..Query::default()
    };
    for n in 0..3 {
        file.write_all(&vec![b'x'; 1024 * 1024 + 1])?;
        file.write_all(b"\n")?;
        let mut row = record(n, "INFO");
        row.process = "app.main".into();
        serde_json::to_writer(&file, &row)?;
        file.write_all(b"\n")?;
        let rows = log.query(&query)?.rows;
        assert_eq!(rows.len(), n + 1);
        assert_eq!(
            rows.iter().map(|r| r.msg.clone()).collect::<Vec<_>>(),
            (0..=n)
                .rev()
                .map(|i| format!("row {i}"))
                .collect::<Vec<_>>()
        );
    }
    assert!(!path.with_extension("idx").exists());
    fs::remove_file(&path)?;
    assert!(log.query(&query)?.rows.is_empty());
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn agent_never_cleans_app_directories() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    for lane in ["main", "debug", "bodies"] {
        let dir = root.join("logs/app").join(lane);
        fs::create_dir_all(&dir)?;
        fs::write(dir.join("20000101T000000Z-0001.jsonl"), b"\n")?;
    }
    let log = Logger::open(&root, Config::default())?;
    log.clear()?;
    log.shutdown()?;
    for lane in ["main", "debug", "bodies"] {
        assert!(
            root.join("logs/app")
                .join(lane)
                .join("20000101T000000Z-0001.jsonl")
                .exists()
        );
    }
    fs::remove_dir_all(root)?;
    Ok(())
}
