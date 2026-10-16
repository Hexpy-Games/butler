//! Exercise replacement with a reader held across publication, without sleeps.
use super::*;
use std::io::Read;

#[tokio::test]
async fn replacements_preserve_open_readers_and_list_current_bytes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::AskAlways, Access::FullAccess] {
        let (s, chat, script, server) = setup(access).await?;
        let path = "home/Downloads/open-reader.txt";
        let absolute = s.sandbox.root.join(path);
        let mut content = String::from("initial\n");
        let create = Case {
            tool: "write_file",
            args: json!({"path":path,"content":content,"overwrite":false}),
            refused: false,
        };
        operation(&s, &chat, &script, &create, access).await?;
        for index in 0..8 {
            // Creation publishes a hard link, then removes the staging name.
            // Also cover a reader that opened that name before its removal.
            let alias = s.sandbox.home.join("Downloads/reader-alias.txt");
            let mut reader = if index % 2 == 0 {
                std::fs::File::open(&absolute)?
            } else {
                std::fs::hard_link(&absolute, &alias)?;
                let reader = std::fs::File::open(&alias)?;
                std::fs::remove_file(&alias)?;
                reader
            };
            let next = format!("revision {index}: {}\n", "한글".repeat(index + 1));
            let edit = Case {
                tool: "edit_file",
                args: json!({"path":path,"old_text":content,"new_text":next}),
                refused: false,
            };
            operation(&s, &chat, &script, &edit, access).await?;
            let mut previous = String::new();
            reader.read_to_string(&mut previous)?;
            assert_eq!(previous, content, "open reader keeps the original file");
            assert_eq!(std::fs::read_to_string(&absolute)?, next);
            content = next;
        }
        let list = Case {
            tool: "list_files",
            args: json!({"root":"home/Downloads","max_depth":1,"max_results":100}),
            refused: false,
        };
        let (output, _) = operation(&s, &chat, &script, &list, access).await?;
        assert_eq!(output["truncated"], false);
        assert_eq!(output["io_errors"], 0);
        assert_eq!(output["files_considered"], 2);
        assert_eq!(output["dirs_visited"], 2);
        assert_eq!(
            output["files"],
            json!([
                {"path":path,"bytes":content.len()},
                {"path":"home/Downloads/보고서.txt","bytes":13}
            ])
        );
        eprintln!("OPEN-READER {access:?}: 8 replacements, complete current listing");
        s.finish().await?;
        server.abort();
    }
    Ok(())
}
