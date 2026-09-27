//! Explicit, command-scoped historical Conversation import.

use std::{ffi::OsString, path::PathBuf, process::ExitCode, sync::Arc};

use crate::conversation::AgentConversationStore;
use crate::conversation::ConversationSourceReader;
use crate::conversation::ConversationStoreConfig;
use crate::conversation::HistoricalRecoveryInput;
use crate::conversation::conversation_store_path;
use crate::conversation::plan_historical_recovery;
use crate::conversation::read_historical_app_rows;
use crate::conversation::read_historical_transcript_rows;
use crate::host::cli::settings as settings_cli;
use crate::host::{DateParser, ResolvedInstallation, SystemIdentity};
use butler_core::locale::LocaleCollation;

const USAGE: &str = "Usage: butler conversation historical-recovery [--data PATH] [--transcript-file PATH] [--app-db PATH] [--write]\nDefault mode is dry-run. Reports counts, ids, reasons, and canonical mappings without raw conversation text.";

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    transcript_file: Option<PathBuf>,
    app_db: Option<PathBuf>,
    write: bool,
}

pub(crate) fn recognizes(args: &[OsString]) -> bool {
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].to_string_lossy().as_ref() {
            "--data" | "--transcript-file" | "--app-db" | "--home" => index += 2,
            option if option.starts_with('-') => index += 1,
            value => {
                positionals.push(value.to_owned());
                index += 1;
            }
        }
    }
    matches!(positionals.as_slice(), [conversation, recovery, ..] if conversation == "conversation" && recovery == "historical-recovery")
}

pub(crate) async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let options = match parse(&args) {
        Ok(Some(options)) => options,
        Ok(None) => {
            eprintln!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match execute(installation, options).await {
        Ok(report) => {
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn parse(args: &[OsString]) -> Result<Option<Options>, crate::host::HostError> {
    let mut options = Options::default();
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].to_string_lossy();
        match argument.as_ref() {
            "--help" | "-h" => return Ok(None),
            "--write" => options.write = true,
            "--data" | "--transcript-file" | "--app-db" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("{argument} requires a path"))?;
                if value.is_empty() || value.to_string_lossy().starts_with('-') {
                    return Err(format!("{argument} requires a path").into());
                }
                let path = PathBuf::from(value);
                match argument.as_ref() {
                    "--data" => options.data = Some(path),
                    "--transcript-file" => options.transcript_file = Some(path),
                    _ => options.app_db = Some(path),
                }
                index += 1;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown option: {value}").into());
            }
            value => positionals.push(value.to_owned()),
        }
        index += 1;
    }
    if positionals != ["conversation", "historical-recovery"] {
        return Err("expected conversation historical-recovery".into());
    }
    if options.transcript_file.is_none() && options.app_db.is_none() {
        return Err("--transcript-file or --app-db is required".into());
    }
    Ok(Some(options))
}

async fn execute(
    installation: ResolvedInstallation,
    options: Options,
) -> Result<String, crate::host::HostError> {
    let data = settings_cli::resolve_data_root_override(options.data, &installation)?;
    let date_parser = DateParser::from_process().map_err(crate::host::HostError::from_error)?;
    let parse_timestamp = |value: &str| date_parser.parse(value);
    if options.write {
        settings_cli::validate_data_mutation_paths(
            &data,
            &installation,
            &["runtime", "runtime/conversation-store.sqlite"],
        )?;
    }
    let transcript_rows = match options.transcript_file {
        Some(path) => {
            read_historical_transcript_rows(&path).map_err(crate::host::HostError::from_error)?
        }
        None => Vec::new(),
    };
    let app_rows = match options.app_db {
        Some(path) => {
            read_historical_app_rows(&path).map_err(crate::host::HostError::from_error)?
        }
        None => Vec::new(),
    };
    let input = HistoricalRecoveryInput {
        transcript_rows,
        app_rows,
        dry_run: !options.write,
    };
    let store_path = conversation_store_path(&data);
    if !options.write {
        let reader = match tokio::fs::metadata(&store_path).await {
            Ok(_) => Some(
                ConversationSourceReader::open(&store_path)
                    .map_err(crate::host::HostError::from_error)?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string().into()),
        };
        let planned = plan_historical_recovery(reader.as_ref(), &parse_timestamp, &input);
        if let Some(reader) = reader {
            reader.close().map_err(crate::host::HostError::from_error)?;
        }
        return serde_json::to_string_pretty(&planned.map_err(crate::host::HostError::from_error)?)
            .map_err(crate::host::HostError::from_error);
    }
    let collation =
        Arc::new(LocaleCollation::new("en-US").map_err(crate::host::HostError::from_error)?);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: store_path,
        identity_clock: Arc::new(SystemIdentity),
        collation,
    })
    .await
    .map_err(crate::host::HostError::from_error)?;
    let result = store.run_historical_recovery(input, &parse_timestamp).await;
    let close = store.close().await;
    let report = result.map_err(crate::host::HostError::from_error)?;
    close.map_err(crate::host::HostError::from_error)?;
    serde_json::to_string_pretty(&report).map_err(crate::host::HostError::from_error)
}
