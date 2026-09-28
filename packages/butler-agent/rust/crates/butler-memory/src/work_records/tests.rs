use super::*;
use serde_json::Value;

struct TemporaryRoot(PathBuf);
impl Drop for TemporaryRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("source-bun.json")).unwrap()
}

pub(crate) fn original_writer_and_reader_goldens_preserve_hashes_review_gates_and_read_errors() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().unwrap() {
        let root = TemporaryRoot(std::env::temp_dir().join(format!(
            "butler-native-work-report-{}",
            uuid::Uuid::new_v4()
        )));
        let task_id = case["task_id"].as_str().unwrap();
        let directory = root.0.join("tasks").join(task_id);
        for (relative, value) in case["files"].as_object().unwrap() {
            let path = directory.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, value.as_str().unwrap()).unwrap();
        }
        let reader = WorkRecordReader::new(&root.0);
        for (key, availability) in [
            ("strict", ReadAvailability::Strict),
            ("best_effort", ReadAvailability::BestEffort),
        ] {
            let actual = reader.read_memory_report(task_id, availability);
            if case[key].get("error").is_some() {
                assert!(actual.is_err(), "{} {key}: {actual:?}", case["name"]);
            } else {
                let actual = serde_json::to_value(actual.unwrap()).unwrap();
                let actual: Value =
                    serde_json::from_str(&butler_core::json::stringify(&actual).unwrap()).unwrap();
                assert_eq!(actual, case[key]["value"], "{} {key}", case["name"]);
            }
        }
        let planned = reader.has_planned_task(task_id);
        if case["planned"].get("error").is_some() {
            assert!(planned.is_err());
        } else {
            assert_eq!(
                planned.unwrap(),
                case["planned"]["value"].as_bool().unwrap()
            );
        }
        let mut ids = reader.task_ids().unwrap();
        ids.sort();
        assert_eq!(ids, vec![task_id]);
    }
}
