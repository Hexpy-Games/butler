use std::ffi::OsString;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default, Debug)]
pub(super) struct Options {
    pub(super) data: Option<String>,
    pub(super) json: bool,
    pub(super) quiet: bool,
    pub(super) help: bool,
    pub(super) positionals: Vec<String>,
    pub(super) host: Option<String>,
    pub(super) port: Option<u16>,
    pub(super) db_path: Option<String>,
    pub(super) lines: Option<usize>,
    pub(super) follow: bool,
}

#[derive(Clone, Copy)]
pub(super) enum Action {
    List,
    Status,
    Inspect,
    Enable,
    Disable,
    Configure,
    Test,
    Start,
    Stop,
    Restart,
    Logs,
    App,
    Run,
}

pub(super) fn recognizes(args: &[OsString]) -> bool {
    let mut index = 0;
    let mut positional = Vec::new();
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--host" | "--port" | "--db" | "--lines" => index += 2,
            "--json" | "--verbose" | "--quiet" | "--silent" | "--yes" | "--non-interactive"
            | "--help" | "-h" | "--follow" => index += 1,
            value if value.starts_with('-') => return false,
            _ => {
                positional.push(value.into_owned());
                index += 1;
            }
        }
    }
    positional.first().is_some_and(|value| value == "gateway")
}

pub(super) fn parse(args: &[OsString]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut lines_seen = false;
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        match value.as_ref() {
            "--data" | "--host" | "--port" | "--db" => {
                let option = value.to_string();
                let argument = args
                    .get(index + 1)
                    .filter(|argument| !argument.to_string_lossy().starts_with('-'))
                    .ok_or_else(|| format!("{option} requires a value"))?;
                let argument = argument.to_string_lossy().into_owned();
                match option.as_str() {
                    "--data" => options.data = Some(argument),
                    "--host" => options.host = Some(argument),
                    "--db" => options.db_path = Some(argument),
                    "--port" => {
                        options.port = Some(
                            argument
                                .parse::<u16>()
                                .ok()
                                .filter(|port| *port > 0)
                                .ok_or_else(|| {
                                    "--port must be a number between 1 and 65535".to_owned()
                                })?,
                        );
                    }
                    _ => return Err(format!("unknown option: {option}")),
                }
                index += 2;
            }
            "--lines" => {
                if let Some(argument) = args
                    .get(index + 1)
                    .filter(|argument| !argument.to_string_lossy().starts_with("--"))
                {
                    if !lines_seen {
                        options.lines = argument
                            .to_string_lossy()
                            .parse::<usize>()
                            .ok()
                            .map(|lines| lines.min(1_000));
                    }
                    lines_seen = true;
                    index += 2;
                } else {
                    lines_seen = true;
                    index += 1;
                }
            }
            "--home" => {
                return Err("--home is unsupported; use --data for writable state".into());
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--follow" => options.follow = true,
            "--verbose" | "--yes" | "--non-interactive" => {}
            "--help" | "-h" => options.help = true,
            value if value.starts_with('-') => {
                return Err(format!("unsupported gateway option: {value}"));
            }
            _ => options.positionals.push(value.to_string()),
        }
        if !matches!(
            value.as_ref(),
            "--data" | "--host" | "--port" | "--db" | "--lines"
        ) {
            index += 1;
        }
    }
    Ok(options)
}

pub(super) fn action(positionals: &[String]) -> Result<Action, String> {
    match positionals {
        [gateway, command] if gateway == "gateway" && command == "list" => Ok(Action::List),
        [gateway, app] if gateway == "gateway" && app == "app" => Ok(Action::App),
        [gateway, command] if gateway == "gateway" && command == "status" => Ok(Action::Status),
        [gateway, command, app]
            if gateway == "gateway" && command == "status" && app == "app" =>
        {
            Ok(Action::Status)
        }
        [gateway, command, app]
            if gateway == "gateway" && command == "inspect" && app == "app" =>
        {
            Ok(Action::Inspect)
        }
        [gateway, command, app]
            if gateway == "gateway" && command == "enable" && app == "app" =>
        {
            Ok(Action::Enable)
        }
        [gateway, command, app]
            if gateway == "gateway" && command == "disable" && app == "app" =>
        {
            Ok(Action::Disable)
        }
        [gateway, command, app]
            if gateway == "gateway" && command == "configure" && app == "app" =>
        {
            Ok(Action::Configure)
        }
        [gateway, command, app] if gateway == "gateway" && command == "test" && app == "app" => {
            Ok(Action::Test)
        }
        [gateway, command, app] if gateway == "gateway" && command == "start" && app == "app" => {
            Ok(Action::Start)
        }
        [gateway, command, app] if gateway == "gateway" && command == "stop" && app == "app" => {
            Ok(Action::Stop)
        }
        [gateway, command, app]
            if gateway == "gateway" && command == "restart" && app == "app" =>
        {
            Ok(Action::Restart)
        }
        [gateway, command, app] if gateway == "gateway" && command == "run" && app == "app" => {
            Ok(Action::Run)
        }
        [gateway, command, app] if gateway == "gateway" && command == "logs" && app == "app" => {
            Ok(Action::Logs)
        }
        _ => Err("supported commands: gateway app|list|status [app]|inspect|enable|disable|configure|test|start|stop|restart|run app|logs app".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parser_rejects_home_authority() {
        assert!(
            parse(&args(&["gateway", "status", "--home", "/tmp/home"]))
                .unwrap_err()
                .contains("--home is unsupported")
        );
    }
}
