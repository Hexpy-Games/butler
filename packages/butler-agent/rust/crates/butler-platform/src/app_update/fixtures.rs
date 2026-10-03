#[path = "hostile.rs"]
mod hostile;
pub use hostile::build as hostile_zip;
// Locally signed temporary bundles for native update E2Es.
use std::path::Path;

/// Build an ad-hoc signed runnable bundle under a temporary root.
pub fn signed_bundle(root: &Path, version: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::{fs, process::Command};
        fs::create_dir_all(root.join("Contents/MacOS"))?;
        fs::write(
            root.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.hexpy.butler.fixture</string><key>CFBundleExecutable</key><string>Butler</string><key>CFBundleVersion</key><string>{version}</string></dict></plist>"#
            ),
        )?;
        let source = root.with_extension("fixture.c");
        fs::write(
            &source,
            format!("#include <stdio.h>\nint main(void) {{ puts(\"{version}\"); return 0; }}\n"),
        )?;
        let compile = Command::new("cc")
            .arg(&source)
            .arg("-o")
            .arg(root.join("Contents/MacOS/Butler"))
            .output()?;
        fs::remove_file(source)?;
        if !compile.status.success() {
            return Err(std::io::Error::other(
                String::from_utf8_lossy(&compile.stderr).into_owned(),
            ));
        }
        fs::create_dir_all(root.join("Contents/Resources"))?;
        fs::write(root.join("Contents/Resources/link-target"), b"fixture")?;
        std::os::unix::fs::symlink("link-target", root.join("Contents/Resources/current"))?;
        let binary = root.join("Contents/Resources/bundled-agent/bin/butler-agent");
        fs::create_dir_all(
            binary
                .parent()
                .ok_or_else(|| std::io::Error::other("fixture parent"))?,
        )?;
        fs::copy("/usr/bin/true", &binary)?;
        crate::process_names::prepare(&binary)?;
        let output = Command::new("codesign")
            .args(["--force", "--deep", "--sign", "-"])
            .arg(root)
            .output()?;
        if !output.status.success() {
            return Err(std::io::Error::other(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        let verified = Command::new("codesign")
            .args(["--verify", "--deep", "--strict", "--verbose=4"])
            .arg(root)
            .output()?;
        if !verified.status.success() {
            return Err(std::io::Error::other(
                String::from_utf8_lossy(&verified.stderr).into_owned(),
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, version);
        Err(std::io::Error::other("macOS fixture unavailable"))
    }
}

/// Build a local ditto archive with the bundle as its root.
pub fn bundle_zip(bundle: &Path, archive: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("ditto")
            .args(["-c", "-k", "--keepParent"])
            .arg(bundle)
            .arg(archive)
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bundle, archive);
        Err(std::io::Error::other("macOS fixture unavailable"))
    }
}

/// Exercise the production entry validator/extractor on local E2E fixtures.
pub fn extract_fixture(archive: &Path, staging: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::fs::create_dir_all(staging).map_err(|e| e.to_string())?;
        super::mac::archive::extract(archive, staging)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (archive, staging);
        Err("macOS fixture unavailable".into())
    }
}

/// Show byte differences in a local signed fixture's ZIP round trip.
pub fn fixture_differences(source: &Path, extracted: &Path) -> std::io::Result<Vec<String>> {
    let mut differences = Vec::new();
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = extracted.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            differences.extend(fixture_differences(&entry.path(), &target)?);
        } else if std::fs::read(entry.path())? != std::fs::read(&target)? {
            differences.push(target.display().to_string());
        }
    }
    Ok(differences)
}

/// Remove the launch permission without changing the sealed executable bytes.
pub fn remove_launch_permission(bundle: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            bundle.join("Contents/MacOS/Butler"),
            std::fs::Permissions::from_mode(0o644),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle;
        Err(std::io::Error::other("macOS fixture unavailable"))
    }
}
