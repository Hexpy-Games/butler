//! Filesystem boundary contract for the portable post-run sweep.
use super::{fs, scratch};
use butler_platform::command_sandbox::{
    discover_project_secrets, project_write_mechanism, sweep_new_secrets,
};

pub(super) fn verify() {
    let temp = scratch("secret-sweep");
    let project = temp.join("project");
    let outside = temp.join("outside");
    let data = temp.join("data");
    fs::create_dir_all(project.join("sub")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join(".env"), "outside").unwrap();
    fs::write(project.join(".env"), "existing").unwrap();
    let link = project.join("alias");
    make_alias(&outside, &link);
    let before = discover_project_secrets(&project).unwrap();
    fs::write(project.join("sub/.env.local"), "new").unwrap();
    let swept = sweep_new_secrets(&project, &before, &data).unwrap();
    if ["landlock", "mxc_base_container"].contains(&project_write_mechanism()) {
        assert_eq!(before, [project.join(".env")]);
        assert_eq!(swept, [project.join("sub/.env.local")]);
        assert!(!project.join("sub/.env.local").exists());
        let run = fs::read_dir(data.join("sandbox-quarantine"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(run.join("sub/.env.local")).unwrap(),
            "new"
        );
        assert_eq!(
            sweep_new_secrets(&project, &before, &data).unwrap(),
            [] as [std::path::PathBuf; 0]
        );
    } else {
        assert_eq!(before, [] as [std::path::PathBuf; 0]);
        assert_eq!(swept, [] as [std::path::PathBuf; 0]);
    }
    assert_eq!(fs::read_to_string(outside.join(".env")).unwrap(), "outside");
    assert_eq!(
        fs::read_to_string(project.join(".env")).unwrap(),
        "existing"
    );
    // Remove the alias itself before recursive scratch cleanup.
    remove_alias(&link);
    fs::remove_dir_all(temp).unwrap();
}
#[cfg(unix)]
fn make_alias(target: &std::path::Path, link: &std::path::Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
#[cfg(windows)]
fn make_alias(target: &std::path::Path, link: &std::path::Path) {
    // Junctions require no elevation or developer-mode setting; all effects are scratch-local.
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(output.status.success(), "junction creation failed");
}
#[cfg(unix)]
fn remove_alias(link: &std::path::Path) {
    fs::remove_file(link).unwrap();
}
#[cfg(windows)]
fn remove_alias(link: &std::path::Path) {
    fs::remove_dir(link).unwrap();
}
