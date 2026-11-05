//! Generate checked-in Rust token data from the canonical CSS token source.
mod color;
mod css;
mod easing;
mod length;
mod output;
mod resolve;
mod value;

use std::{collections::BTreeSet, path::Path, process::ExitCode};

fn run() -> Result<bool, String> {
    let mut args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let check = args.first().is_some_and(|a| a == "--check");
    if check {
        args.remove(0);
    }
    if args.len() != 2 {
        return Err("usage: ds-tokens [--check] <tokens.css> <out-dir>".into());
    }
    let source = std::fs::read_to_string(&args[0]).map_err(|e| e.to_string())?;
    let files = output::generate(&css::read(&source)?)?;
    let out = Path::new(&args[1]);
    if !check {
        std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    }
    let existing = if out.exists() {
        std::fs::read_dir(out)
            .map_err(|e| e.to_string())?
            .map(|entry| {
                entry
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<BTreeSet<_>, _>>()?
    } else {
        BTreeSet::new()
    };
    let mut same = true;
    for name in existing.iter().chain(files.keys()).collect::<BTreeSet<_>>() {
        let path = out.join(name);
        match files.get(name) {
            Some(text) if std::fs::read_to_string(&path).ok().as_ref() == Some(text) => {}
            Some(text) => {
                same = false;
                if check {
                    eprintln!("{name}");
                } else {
                    std::fs::write(path, text).map_err(|e| e.to_string())?;
                }
            }
            None => {
                same = false;
                if check {
                    eprintln!("{name}");
                } else {
                    std::fs::remove_file(path).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(!check || same)
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("ds-tokens: {error}");
            ExitCode::FAILURE
        }
    }
}
