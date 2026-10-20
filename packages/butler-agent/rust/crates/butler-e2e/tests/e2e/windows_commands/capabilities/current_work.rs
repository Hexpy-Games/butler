//! Sequential capabilities retain the current Work binding without growing publication I/O.
use super::{Access, Case, HarnessError, json, operation, setup};

#[tokio::test]
async fn sequential_file_capabilities_close_the_current_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    sequential_works(8, false).await
}

#[tokio::test]
async fn publication_filesystem_operations_depend_only_on_changed_records()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    sequential_works(21, true).await
}

async fn sequential_works(count: usize, measure: bool) -> Result<(), HarnessError> {
    let (s, chat, script, server) = setup(Access::FullAccess).await?;
    script.work.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut publications = Vec::new();
    let mut work_ids = std::collections::HashSet::new();
    for index in 0..count {
        let before = if measure { s.agent.logs().len() } else { 0 };
        let name = format!("report-{index}.txt");
        let content = format!("complete current report {index}");
        std::fs::write(s.sandbox.home.join("Downloads").join(&name), &content)?;
        let case = Case {
            tool: "read_file",
            args: json!({"requests":[{"path":format!("home/Downloads/{name}")}]}),
            refused: false,
        };
        let (output, _) = operation(&s, &chat, &script, &case, Access::FullAccess).await?;
        assert_eq!(output["files"][0]["content"], content);
        assert_eq!(output["files_read"], 1);
        assert_eq!(output["truncated"], false);
        let disposition = script.disposition.lock().unwrap().clone().unwrap();
        assert_eq!(
            disposition["ok"], true,
            "current Work disposition: {disposition}"
        );
        assert_eq!(disposition["work"]["status"], "completed");
        let work_id = disposition["work"]["work_id"].as_str().unwrap();
        assert!(
            work_ids.insert(work_id.to_owned()),
            "each turn must complete a distinct Work"
        );
        if measure {
            let logs = s.agent.logs();
            let lines = logs.get(before..).unwrap();
            if matches!(index, 1 | 5 | 20) {
                for line in lines.lines().filter(|line| {
                    line.contains("command_file_timing") && line.contains("publication")
                }) {
                    eprintln!("existing_works={index} {line}");
                }
            }
            publications.push(publication_operations(lines));
        }
    }
    s.finish().await?;
    server.abort();
    if measure {
        // The first Work has no previous session head to update. Every later
        // start changes that head plus the new Work; other tools have equal shapes.
        let baseline = publications.get(1).unwrap();
        assert_eq!(
            baseline.len(),
            4,
            "start, plan, review, disposition: {baseline:?}"
        );
        assert!(baseline.iter().all(|count| *count > 0 && *count < 4096));
        for (index, operations) in publications.iter().enumerate().skip(1) {
            assert_eq!(operations, baseline, "publication I/O grew at Work {index}");
        }
    }
    Ok(())
}

fn publication_operations(logs: &str) -> Vec<u64> {
    let field = |line: &str, prefix: &str| {
        line.split_whitespace()
            .find_map(|item| item.strip_prefix(prefix))
            .unwrap()
            .parse::<u64>()
            .unwrap()
    };
    let applied = logs
        .lines()
        .filter(|line| line.contains("command_file_timing phase=publication_apply "))
        .map(|line| field(line, "id="))
        .collect::<std::collections::HashSet<_>>();
    logs.lines()
        .filter(|line| line.contains("command_file_timing phase=work_publication "))
        .filter(|line| applied.contains(&field(line, "id=")))
        .map(|line| field(line, "fs_operations="))
        .collect()
}
