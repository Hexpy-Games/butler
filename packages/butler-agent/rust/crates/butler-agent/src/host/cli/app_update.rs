//! Private packaged-App helper. The Electron host supplies a verified staged package.
use std::{ffi::OsString, path::PathBuf, process::ExitCode};

pub(crate) fn run(args: &[OsString]) -> ExitCode {
    let result = (|| {
        if args.len() < 4 {
            return Err("App update requires package, executable and parent.".into());
        }
        let artifact = PathBuf::from(&args[1]);
        let executable = PathBuf::from(&args[2]);
        let parent = args[3]
            .to_string_lossy()
            .parse::<u32>()
            .map_err(|_| "Invalid App parent.")?;
        butler_platform::app_update::install(&artifact, &executable, parent, &args[4..])
    })();
    match result {
        Ok(()) => {
            eprintln!("App package activated.");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
