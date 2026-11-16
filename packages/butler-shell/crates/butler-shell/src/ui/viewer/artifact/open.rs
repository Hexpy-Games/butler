//! `openInApp` and `canOpenInApp` of `artifactActions` with `electron/open-message-file.mjs`: a
//! stored file opens in the computer's own app or shows in its folder. The agent names the
//! target by the file's id; this side checks the path before it is opened or shown.
use std::path::{Path, PathBuf};

use butler_ds::ui::toast::{self, Toast};
use butler_platform::data_paths::TEMPORARY;
use butler_platform::secure_fs::{canonicalize, is_within, same_path};
use butler_shell_client::Error;
use gpui::App;
use serde_json::{Value, json};

use crate::ui::i18n::artifact_viewer::ArtifactViewerCopy;
use crate::ui::i18n::file_viewer::FileViewerStrings;
use crate::ui::source::agent::Jobs;

/// Name hint only; the gateway verifies content and may downgrade to reveal.
const OPEN_IN_APP_EXTENSIONS: [&str; 15] = [
    "pdf", "docx", "xlsx", "pptx", "hwp", "hwpx", "png", "jpg", "jpeg", "gif", "webp", "md",
    "markdown", "txt", "csv",
];

/// `canOpenInApp`: the name's extension (after its last dot, with no `/` or `\`) is one that
/// opens in an app.
pub(super) fn can_open_in_app(name: &str) -> bool {
    name.trim()
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .filter(|extension| !extension.is_empty() && !extension.contains(['/', '\\']))
        .is_some_and(|extension| {
            OPEN_IN_APP_EXTENSIONS.contains(&extension.to_lowercase().as_str())
        })
}

/// What the agent answered: the checked path and whether it opens (else it is shown).
enum Answer {
    Target(PathBuf, bool),
    OriginalNotFound,
    Failed,
}

/// `openInApp`: the file opens in its app or shows in its folder; a failure is an error toast.
pub(super) fn open_in_app(file_id: String, cx: &mut App) {
    if !is_file_id(&file_id) {
        return answered(Answer::Failed, cx);
    }
    let root = crate::lifecycle::data_root(&std::env::args_os().collect::<Vec<_>>())
        .join(TEMPORARY)
        .join("opened-files");
    let request = Jobs::run(cx, move |client| async move {
        client
            .record_opened_file(&json!({ "file_id": file_id }))
            .await
    });
    cx.spawn(async move |cx| {
        let answer = match request.await {
            Some(Ok(data)) => {
                let check = async move { target(&data, &root) };
                cx.background_executor().spawn(check).await
            }
            Some(Err(Error::Http(404))) => Answer::OriginalNotFound,
            _ => Answer::Failed,
        };
        cx.update(|cx| answered(answer, cx));
    })
    .detach();
}

/// The file opens or shows; a failure is the toast `openInApp` shows.
fn answered(answer: Answer, cx: &mut App) {
    let text = match answer {
        Answer::Target(path, true) => return cx.open_with_system(&path),
        Answer::Target(path, false) => return cx.reveal_path(&path),
        Answer::OriginalNotFound => FileViewerStrings::get(cx).original_not_found,
        Answer::Failed => ArtifactViewerCopy::get(cx).open_in_app_failed,
    };
    toast::show(cx, Toast::error(text));
}

/// `fileIdPattern`: `file-` and 36 hex digits or dashes, in either case.
fn is_file_id(id: &str) -> bool {
    let (Some(prefix), Some(rest)) = (id.get(..5), id.get(5..)) else {
        return false;
    };
    prefix.eq_ignore_ascii_case("file-")
        && rest.len() == 36
        && rest.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The answered path once checked: the original exactly as answered, a copy as it resolves.
fn target(data: &Value, root: &Path) -> Answer {
    let Some(path) = data["path"].as_str().map(Path::new) else {
        return Answer::Failed;
    };
    let checked = if data["original"] == true {
        original_path(path)
    } else {
        verified_path(path, root)
    };
    checked.map_or(Answer::Failed, |path| {
        Answer::Target(path, data["open"] == true)
    })
}

/// `originalPath`: an absolute path that is still a regular file, not a link.
fn original_path(path: &Path) -> Option<PathBuf> {
    (path.is_absolute() && regular_file(path)).then(|| path.to_path_buf())
}

/// `verifiedPath`: a regular file that, links resolved, lies inside the opened-files folder
/// (never the folder itself) and is still a regular file there.
fn verified_path(path: &Path, root: &Path) -> Option<PathBuf> {
    if !regular_file(path) {
        return None;
    }
    let (target, base) = (canonicalize(path).ok()?, canonicalize(root).ok()?);
    let inside = is_within(&target, &base) && !same_path(&target, &base);
    (inside && regular_file(&target)).then_some(target)
}

/// `lstat(path).isFile()`: a link is not a file.
fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use butler_platform::secure_fs::{canonicalize, symlink};
    use serde_json::json;

    use super::{Answer, target};

    /// `open-message-file.test.ts`: a copy opens only as a regular file inside the opened-files
    /// folder, resolved; an original only as an absolute regular file.
    // test-category: security
    #[test]
    fn open_target_refuses_links_the_root_and_unflagged_outside_files() {
        let dir = std::env::temp_dir().join(format!("butler-open-target-{}", std::process::id()));
        let root = dir.join("opened-files");
        fs::create_dir_all(&root).unwrap();
        let (copy, outside, link) = (
            root.join("copy.txt"),
            dir.join("outside.txt"),
            root.join("link.txt"),
        );
        fs::write(&copy, "stored bytes").unwrap();
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, &link).unwrap();
        let answer = |path: &Path, original: bool| {
            target(
                &json!({ "path": path, "open": true, "original": original }),
                &root,
            )
        };

        for original in [false, true] {
            assert!(
                matches!(answer(&link, original), Answer::Failed),
                "link {original}"
            );
            assert!(
                matches!(answer(&root, original), Answer::Failed),
                "root {original}"
            );
        }
        assert!(matches!(answer(&outside, false), Answer::Failed));
        assert!(matches!(answer(&outside, true), Answer::Target(path, true) if path == outside));
        assert!(matches!(
            answer(Path::new("outside.txt"), true),
            Answer::Failed
        ));
        let resolved = canonicalize(&copy).unwrap();
        assert!(matches!(answer(&copy, false), Answer::Target(path, true) if path == resolved));

        fs::remove_dir_all(&dir).unwrap();
    }
}
