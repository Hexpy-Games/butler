mod architecture;

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const REVIEW_MIN_LINES: usize = 400;
const MAX_LINES: usize = 500;

fn main() -> ExitCode {
    match parse_root().and_then(|root| scan(&root)) {
        Ok(has_violations) if has_violations => ExitCode::FAILURE,
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("source-check: {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse_root() -> Result<PathBuf, String> {
    let mut arguments = env::args_os().skip(1);
    let root = arguments.next().unwrap_or_else(|| ".".into());
    if arguments.next().is_some() {
        return Err("usage: butler-source-check [ROOT]".to_owned());
    }
    Ok(PathBuf::from(root))
}

fn scan(root: &Path) -> Result<bool, String> {
    ensure_directory_root(root)?;
    let mut sources = Vec::new();
    collect_sources(root, &mut sources).map_err(|error| format_io(root, &error))?;
    sources.sort();

    if sources.is_empty() {
        return Err(format!("no Rust files found under {}", display_path(root)));
    }

    let mut has_violations = false;
    for source in &sources {
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", display_path(source)))?;
        let lines = physical_line_count(&contents);
        let relative = source.strip_prefix(root).unwrap_or(source);
        let displayed = display_path(relative);

        if lines > MAX_LINES {
            eprintln!("ERROR {displayed} lines={lines} exceeds {MAX_LINES}-line limit");
            has_violations = true;
        } else if lines >= REVIEW_MIN_LINES {
            println!("REVIEW {displayed} lines={lines} responsibility review required");
        } else {
            println!("SOURCE {displayed} lines={lines}");
        }
    }

    println!("SCANNED files={}", sources.len());
    has_violations |= architecture::check(root)?;
    Ok(has_violations)
}

fn ensure_directory_root(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("cannot inspect {}: {error}", display_path(root)))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("scan root is a symlink: {}", display_path(root)));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "scan root is not a directory: {}",
            display_path(root)
        ));
    }
    Ok(())
}

fn collect_sources(directory: &Path, sources: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            reject_relevant_symlink(&path)?;
            continue;
        }
        if file_type.is_dir() {
            if should_skip_directory(&path) {
                continue;
            }
            collect_sources(&path, sources)?;
        } else if file_type.is_file() && path.extension() == Some(OsStr::new("rs")) {
            sources.push(path);
        }
    }

    Ok(())
}

fn reject_relevant_symlink(path: &Path) -> io::Result<()> {
    let target = fs::metadata(path)?;
    if target.is_dir() || path.extension() == Some(OsStr::new("rs")) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "source or directory symlink is not allowed: {}",
                display_path(path)
            ),
        ));
    }
    Ok(())
}

fn should_skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "target")
    )
}

fn physical_line_count(contents: &str) -> usize {
    let newline_count = contents.bytes().filter(|byte| *byte == b'\n').count();
    newline_count + usize::from(!contents.is_empty() && !contents.ends_with('\n'))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn format_io(path: &Path, error: &io::Error) -> String {
    format!("cannot scan {}: {error}", display_path(path))
}
