//! Explicit, command-scoped historical Conversation import.

use std::{ffi::OsString, fs, path::PathBuf, process::ExitCode, sync::Arc};

use super::{NativeDateParser, ResolvedInstallation, SystemIdentity, settings_cli};
use crate::{
    conversation::{
        AgentConversationStore, ConversationSourceReader, ConversationStoreConfig,
        HistoricalRecoveryInput, conversation_store_path, plan_historical_recovery,
        read_historical_app_rows, read_historical_transcript_rows,
    },
    locale::LocaleCollation,
};

const USAGE: &str = "Usage: butler conversation historical-recovery [--data PATH] [--transcript-file PATH] [--app-db PATH] [--write]\nDefault mode is dry-run. Reports counts, ids, reasons, and canonical mappings without raw conversation text.";

#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    transcript_file: Option<PathBuf>,
    app_db: Option<PathBuf>,
    write: bool,
}

pub fn recognizes(args: &[OsString]) -> bool {
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

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
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

fn parse(args: &[OsString]) -> Result<Option<Options>, String> {
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
                    return Err(format!("{argument} requires a path"));
                }
                let path = PathBuf::from(value);
                match argument.as_ref() {
                    "--data" => options.data = Some(path),
                    "--transcript-file" => options.transcript_file = Some(path),
                    _ => options.app_db = Some(path),
                }
                index += 1;
            }
            value if value.starts_with('-') => return Err(format!("unknown option: {value}")),
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

async fn execute(installation: ResolvedInstallation, options: Options) -> Result<String, String> {
    let data = settings_cli::resolve_data_root_override(options.data, &installation)?;
    let date_parser = NativeDateParser::from_process().map_err(|error| error.to_string())?;
    let parse_timestamp = |value: &str| date_parser.parse(value);
    if options.write {
        settings_cli::validate_data_mutation_paths(
            &data,
            &installation,
            &["runtime", "runtime/conversation-store.sqlite"],
        )?;
    }
    let transcript_rows = match options.transcript_file {
        Some(path) => read_historical_transcript_rows(&path).map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    let app_rows = match options.app_db {
        Some(path) => read_historical_app_rows(&path).map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    let input = HistoricalRecoveryInput {
        transcript_rows,
        app_rows,
        dry_run: !options.write,
    };
    let store_path = conversation_store_path(&data);
    if !options.write {
        let reader = match fs::metadata(&store_path) {
            Ok(_) => Some(
                ConversationSourceReader::open(&store_path).map_err(|error| error.to_string())?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let planned = plan_historical_recovery(reader.as_ref(), &parse_timestamp, &input);
        if let Some(reader) = reader {
            reader.close().map_err(|error| error.to_string())?;
        }
        return serde_json::to_string_pretty(&planned.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string());
    }
    let collation = Arc::new(LocaleCollation::new("en-US").map_err(|error| error.to_string())?);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: store_path,
        identity_clock: Arc::new(SystemIdentity),
        collation,
    })
    .await
    .map_err(|error| error.to_string())?;
    let result = store.run_historical_recovery(input, &parse_timestamp).await;
    let close = store.close().await;
    let report = result.map_err(|error| error.to_string())?;
    close.map_err(|error| error.to_string())?;
    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())
}
