use super::{Message, Shared};
use std::io;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
type Socket = BufReader<TcpStream>;
async fn write(socket: &mut Socket, text: &str) -> io::Result<()> {
    socket.write_all(text.as_bytes()).await
}
fn tokens(line: &str) -> Vec<String> {
    let mut result = vec![];
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for c in line.trim().chars() {
        if escaped {
            token.push(c);
            escaped = false;
        } else if quoted && c == '\\' {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            if !token.is_empty() {
                result.push(std::mem::take(&mut token));
            }
        } else {
            token.push(c);
        }
    }
    if !token.is_empty() {
        result.push(token);
    }
    result
}
pub(super) async fn connection(stream: TcpStream, shared: Shared) -> io::Result<()> {
    shared
        .state
        .lock()
        .unwrap()
        .connections
        .push(std::time::Instant::now());
    let mut socket = BufReader::new(stream);
    let mut changes = shared.changed.subscribe();
    let mut disconnect = shared.disconnect.subscribe();
    let mut selected = "INBOX".to_owned();
    write(&mut socket, "* OK loopback IMAP ready\r\n").await?;
    loop {
        let mut line = String::new();
        if socket.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let parts = tokens(&line);
        if parts.len() < 2 {
            continue;
        }
        let tag = &parts[0];
        let command = parts[1].to_ascii_uppercase();
        let logged = if command == "LOGIN" {
            format!("{tag} LOGIN [redacted]")
        } else {
            line.trim().to_owned()
        };
        shared.state.lock().unwrap().commands.push(logged);
        let args = &parts[2..];
        let stall = shared.state.lock().unwrap().stall_command.as_deref() == Some(command.as_str());
        if stall {
            let mut byte = [0];
            let _ = socket.read(&mut byte).await?;
            return Ok(());
        }
        match command.as_str() {
            "IDLE" => {
                let flap = {
                    let mut state = shared.state.lock().unwrap();
                    let flap = state.flap > 0;
                    state.flap = state.flap.saturating_sub(1);
                    flap
                };
                if flap {
                    return Ok(());
                }
                write(&mut socket, "+ idling\r\n").await?;
                loop {
                    let mut done = String::new();
                    tokio::select! {
                        line=socket.read_line(&mut done)=> { if line? == 0 { return Ok(()); } shared.state.lock().unwrap().commands.push(done.trim().into()); break; }
                        _=disconnect.recv()=> return Ok(()),
                        update=changes.recv()=> {
                            if update.is_ok_and(|m|m == selected) {
                                let count=shared.state.lock().unwrap().boxes[&selected].messages.len();
                                write(&mut socket,&format!("* {count} EXISTS\r\n")).await?;
                            }
                        }
                    }
                }
                let stalled = shared.state.lock().unwrap().stall_done;
                if stalled {
                    // Simulate a half-open peer until the client closes it.
                    let mut byte = [0];
                    let _ = socket.read(&mut byte).await?;
                    return Ok(());
                }
            }
            "APPEND" => append(&mut socket, &shared, args).await?,
            "LOGOUT" => {
                write(
                    &mut socket,
                    &format!("* BYE closing\r\n{tag} OK logout\r\n"),
                )
                .await?;
                return Ok(());
            }
            _ => {
                let response = respond(&shared, &command, args, &mut selected);
                match response {
                    Ok(data) => write(&mut socket, &data).await?,
                    Err(()) => {
                        write(&mut socket, &format!("{tag} NO refused\r\n")).await?;
                        continue;
                    }
                }
            }
        }
        write(&mut socket, &format!("{tag} OK completed\r\n")).await?;
    }
}
async fn append(socket: &mut Socket, shared: &Shared, args: &[String]) -> io::Result<()> {
    let length = args
        .last()
        .and_then(|s| s.trim_matches(['{', '}']).parse::<usize>().ok())
        .ok_or_else(|| io::Error::other("literal missing"))?;
    write(socket, "+ literal ready\r\n").await?;
    let mut raw = vec![0; length];
    socket.read_exact(&mut raw).await?;
    let mut end = String::new();
    socket.read_line(&mut end).await?;
    let uid = shared.deliver(&args[0], &String::from_utf8_lossy(&raw));
    if args.iter().any(|s| s.contains("\\Draft")) {
        let mut state = shared.state.lock().unwrap();
        state
            .boxes
            .get_mut(&args[0])
            .unwrap()
            .messages
            .iter_mut()
            .find(|m| m.uid == uid)
            .unwrap()
            .flags
            .push("\\Draft".into());
    }
    Ok(())
}
fn respond(
    shared: &Shared,
    command: &str,
    args: &[String],
    selected: &mut String,
) -> Result<String, ()> {
    let mut state = shared.state.lock().unwrap();
    match command {
        "LOGIN" if state.reject_login => Err(()),
        "LOGIN" | "NOOP" => Ok(String::new()),
        "CAPABILITY" => Ok(format!(
            "* CAPABILITY IMAP4rev1{}{}{}{}{}\r\n",
            if state.capabilities.dialect == super::Dialect::Gmail {
                " X-GM-EXT-1"
            } else {
                ""
            },
            if state.capabilities.idle { " IDLE" } else { "" },
            if state.listing.special_use {
                " SPECIAL-USE"
            } else {
                ""
            },
            if state.capabilities.move_cap {
                " MOVE"
            } else {
                ""
            },
            if state.capabilities.uidplus {
                " UIDPLUS"
            } else {
                ""
            }
        )),
        "LIST" => {
            let mut response = String::new();
            for (name, b) in &state.boxes {
                response.push_str(&format!(
                    "* LIST ({}) \"/\" \"{name}\"\r\n",
                    if !state.listing.extended_roles
                        || (state.listing.special_use && args.iter().any(|a| a == "(SPECIAL-USE)"))
                    {
                        b.roles.join(" ")
                    } else {
                        String::new()
                    }
                ));
            }
            Ok(response)
        }
        "SELECT" | "EXAMINE" => {
            let mailbox = state.boxes.get(&args[0]).ok_or(())?;
            *selected = args[0].clone();
            Ok(format!(
                "* FLAGS (\\Seen \\Draft \\Deleted)\r\n* {} EXISTS\r\n* OK [UIDVALIDITY {}] valid\r\n* OK [UIDNEXT {}] next\r\n",
                mailbox.messages.len(),
                mailbox.validity,
                mailbox.next
            ))
        }
        "UID" => uid(&mut state, args, selected, shared),
        _ => Err(()),
    }
}
fn uid(
    state: &mut super::State,
    args: &[String],
    selected: &str,
    shared: &Shared,
) -> Result<String, ()> {
    if args.len() < 2 {
        return Err(());
    }
    let operation = args[0].to_ascii_uppercase();
    if operation == "SEARCH" {
        let start = args
            .iter()
            .position(|s| s.eq_ignore_ascii_case("UID"))
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.split(':').next())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(1);
        let result = state.boxes[selected]
            .messages
            .iter()
            .filter(|m| m.uid >= start)
            .map(|m| m.uid.to_string())
            .collect::<Vec<_>>();
        return Ok(format!("* SEARCH {}\r\n", result.join(" ")));
    }
    let target = args[1].parse::<u32>().map_err(|_| ())?;
    if state.capabilities.dialect == super::Dialect::Gmail
        && operation == "STORE"
        && args.get(2).is_some_and(|s| s.ends_with("X-GM-LABELS"))
    {
        return super::gmail::store(state, args, selected, shared);
    }
    let labels = (state.capabilities.dialect == super::Dialect::Gmail)
        .then(|| super::gmail::labels(state, selected, target));
    let mailbox = state.boxes.get_mut(selected).ok_or(())?;
    let index = mailbox
        .messages
        .iter()
        .position(|m| m.uid == target)
        .ok_or(())?;
    match operation.as_str() {
        "FETCH" => Ok(fetch(
            &mailbox.messages[index],
            index + 1,
            &args[2..].join(" "),
            labels.as_deref(),
        )),
        "STORE" => {
            let flags = args[3..]
                .join(" ")
                .trim_matches(['(', ')'])
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            for flag in flags {
                if args[2].starts_with('+') {
                    if !mailbox.messages[index].flags.contains(&flag) {
                        mailbox.messages[index].flags.push(flag);
                    }
                } else {
                    mailbox.messages[index].flags.retain(|f| *f != flag);
                }
            }
            Ok(String::new())
        }
        "MOVE" | "COPY" => {
            let destination = args.get(2).ok_or(())?;
            let message = if operation == "MOVE" {
                mailbox.messages.remove(index)
            } else {
                mailbox.messages[index].clone()
            };
            let dest = state.boxes.get_mut(destination).ok_or(())?;
            let mut message = message;
            message.uid = dest.next;
            dest.next += 1;
            dest.messages.push(message);
            let _ = shared.changed.send(destination.clone());
            Ok(String::new())
        }
        "EXPUNGE" => {
            mailbox.messages.remove(index);
            Ok(format!("* {} EXPUNGE\r\n", index + 1))
        }
        _ => Err(()),
    }
}
fn fetch(message: &Message, sequence: usize, query: &str, labels: Option<&str>) -> String {
    let raw = message.raw.as_str();
    let (headers, text) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let headers = format!("{headers}\r\n\r\n");
    let mut response = format!(
        "* {sequence} FETCH (UID {} FLAGS ({}) INTERNALDATE \"{}\" RFC822.SIZE {}",
        message.uid,
        message.flags.join(" "),
        chrono::Utc::now().format("%d-%b-%Y %H:%M:%S %z"),
        raw.len()
    );
    if query.contains("X-GM-LABELS")
        && let Some(labels) = labels
    {
        response.push_str(&format!(" X-GM-LABELS ({labels})"));
    }
    if query.contains("BODY.PEEK[]") {
        response.push_str(&format!(" BODY[] {{{}}}\r\n{raw}", raw.len()));
    } else {
        if query.contains("HEADER") {
            response.push_str(&format!(" BODY[HEADER] {{{}}}\r\n{headers}", headers.len()));
        }
        if query.contains("TEXT") {
            let text = &text.as_bytes()[..text.len().min(65536)];
            response.push_str(&format!(
                " BODY[TEXT]<0> {{{}}}\r\n{}",
                text.len(),
                String::from_utf8_lossy(text)
            ));
        }
    }
    response.push_str(")\r\n");
    response
}
