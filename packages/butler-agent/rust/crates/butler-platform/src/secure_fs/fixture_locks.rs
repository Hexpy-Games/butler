//! Disposable native filesystem locks for cross-process E2E checks.
use std::{fs::File, io, path::Path};

/// Hold a file without delete sharing on Windows, allowing concurrent reads
/// and writes. Other hosts keep a read handle; callers probe unlink support.
pub fn deny_delete(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        File::options().read(true).share_mode(3).open(path)
    }
    #[cfg(not(windows))]
    File::open(path)
}

/// A disposable child holding a mapped view with all file sharing enabled.
pub struct MappedView {
    child: std::process::Child,
}

impl Drop for MappedView {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Wait for an explicit readiness handshake. Output goes to a fixture file;
/// every exit path kills and reaps only the child started here.
pub fn mapped_view(path: &Path, control: &Path) -> io::Result<MappedView> {
    #[cfg(windows)]
    {
        use std::{
            process::Command,
            time::{Duration, Instant},
        };
        let ready = control.join("ready");
        let log = File::create(control.join("holder.log"))?;
        let child = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"
$ErrorActionPreference = 'Stop'
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
$file = [IO.File]::Open($env:BUTLER_MAPPING_FILE, 'Open', 'Read', $share)
$map = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile(
    $file, $null, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read,
    [IO.HandleInheritability]::None, $true)
$view = $map.CreateViewAccessor(0, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
[IO.File]::WriteAllText($env:BUTLER_MAPPING_READY, 'ready')
[Threading.Thread]::Sleep(-1)
"#,
            ])
            .env("BUTLER_MAPPING_FILE", path)
            .env("BUTLER_MAPPING_READY", &ready)
            .stdin(std::process::Stdio::null())
            .stderr(log.try_clone()?)
            .stdout(log)
            .spawn()?;
        let mut holder = MappedView { child };
        let started = Instant::now();
        while !ready.exists() {
            if holder.child.try_wait()?.is_some() {
                return Err(io::Error::other(
                    "mapped-view holder exited before readiness",
                ));
            }
            if started.elapsed() >= Duration::from_secs(5) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "mapped-view readiness",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        std::fs::remove_file(ready)?;
        Ok(holder)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, control);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native mapped view required",
        ))
    }
}
