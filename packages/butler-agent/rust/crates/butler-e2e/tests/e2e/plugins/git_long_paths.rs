//! Plugin git checkouts under long data paths: files deeper than MAX_PATH
//! check out, and a checkout folder too long to run git in is named as such.
use super::{git_support::*, *};

/// Points the data folder at `sandbox.root` plus `extra` (at least 2)
/// characters of 8.3 names, which have no shorter Windows alias.
fn long_data(setup: &mut Setup, extra: usize) -> Result<(), HarnessError> {
    let name = |n: usize| match n {
        ..=8 => "a".repeat(n),
        _ => format!("{}.txt", "a".repeat(n - 4)),
    };
    let mut data = setup.sandbox.root.clone();
    let mut left = extra;
    while left > 13 {
        data = data.join(name(8));
        left -= 9;
    }
    data = data.join(name(left - 1));
    fs::create_dir_all(&data)?;
    setup.sandbox.data = data;
    Ok(())
}

fn length(path: &Path) -> usize {
    path.as_os_str().to_string_lossy().chars().count()
}

#[tokio::test]
async fn git_checkout_files_beyond_max_path_install() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = git_setup("PG-LONG")?;
    // Checkout files sit about 180 characters below the data folder, the
    // checkout folder itself about 125: at 125 the files pass MAX_PATH (260)
    // while git can still start in the folder.
    let root = length(&setup.sandbox.root);
    assert!(root < 120, "sandbox root too long: {root}");
    long_data(&mut setup, 125 - root)?;
    assert_eq!(length(&setup.sandbox.data), 125);
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

#[tokio::test]
async fn git_checkout_folder_too_long_to_start_in_is_named() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Only Windows limits the folder a process starts in.
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows working-directory limit"
    );
    let mut setup = git_setup("PG-TOO-LONG")?;
    // 240 characters without short aliases put the checkout folder past
    // where a Windows process may start, even in its short-name form.
    long_data(&mut setup, 240)?;
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    let sha = repo.publish();
    let s = setup.start().await?;
    // The checkout folder (`work/<id>/sources/<hash>`) is created first; none may remain.
    let work = s.sandbox.data.join("plugins/work");
    let r = api(
        &s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"git":repo.url,"commit":sha})),
    )
    .await?;
    assert_eq!(r.status, 400, "{r:?}");
    assert!(r.text.contains("plugin_path_too_long"), "{r:?}");
    assert!(empty(&work), "checkout folder left behind");
    s.finish().await
}
