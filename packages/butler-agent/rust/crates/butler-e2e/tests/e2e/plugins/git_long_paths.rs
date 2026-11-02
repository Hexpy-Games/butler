//! Plugin git checkouts under long data paths: files deeper than MAX_PATH
//! check out, and a checkout git cannot open is named as such.
use super::{git_support::*, *};

/// A short folder under the system temp folder, removed on drop, so the data
/// folder has the intended length whatever the sandbox root's length is.
struct ShortRoot(PathBuf);

impl ShortRoot {
    fn create() -> Result<Self, HarnessError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let path = std::env::temp_dir().join(format!("bpg-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path)?;
        Ok(Self(butler_platform::secure_fs::canonicalize(&path)?))
    }
}

impl Drop for ShortRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn length(path: &Path) -> usize {
    path.as_os_str().to_string_lossy().encode_utf16().count()
}

/// Points the data folder at a new short root plus components, `total`
/// characters long in all; the root stays alive as long as the result.
fn data_folder(setup: &mut Setup, total: usize) -> Result<ShortRoot, HarnessError> {
    let root = ShortRoot::create()?;
    let mut data = root.0.clone();
    let start = length(&data);
    assert!(start + 2 <= total, "temp root too long: {start}");
    let mut left = total - start;
    while left > 41 {
        data.push("x".repeat(39));
        left -= 40;
    }
    data.push("y".repeat(left - 1));
    assert_eq!(length(&data), total, "{}", data.display());
    fs::create_dir_all(&data)?;
    setup.sandbox.data = data;
    Ok(root)
}

/// The checkout folder sits 123 characters below the data folder, its
/// objects about 178. With a 110-character data folder git can open the
/// repository while object files pass MAX_PATH (260).
#[tokio::test]
async fn git_checkout_files_beyond_max_path_install() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = git_setup("PG-LONG")?;
    let _root = data_folder(&mut setup, 110)?;
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    let sha = repo.publish();
    let s = setup.start().await?;
    let installed = install_source(&s, json!({"git":repo.url,"commit":sha})).await?;
    assert_eq!(installed["pin"]["commit"], sha);
    let p = inventory(&s).await?;
    assert_eq!(p["pin"]["commit"], sha);
    assert_eq!(p["content_digest"], git_digest(&repo)?);
    s.finish().await
}

/// With a 130-character data folder the repository's own `.git\config`
/// passes MAX_PATH, which Windows git reads before any `-c` option applies.
#[tokio::test]
async fn git_checkout_git_cannot_open_is_named() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Only Windows limits the paths git opens without the system setting.
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows path limit"
    );
    let mut setup = git_setup("PG-TOO-LONG")?;
    let _root = data_folder(&mut setup, 130)?;
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    let sha = repo.publish();
    let s = setup.start().await?;
    let r = api(
        &s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"git":repo.url,"commit":sha})),
    )
    .await?;
    assert_eq!(r.status, 400, "{r:?}");
    assert!(r.text.contains("plugin_path_too_long"), "{r:?}");
    // The checkout folder (`work/<id>/sources/<hash>`) is created first; none may remain.
    assert!(
        empty(&s.sandbox.data.join("plugins/work")),
        "checkout folder left behind"
    );
    s.finish().await
}
