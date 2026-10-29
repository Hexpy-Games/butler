use super::Shared;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
pub(super) async fn connection(stream: TcpStream, shared: Shared) -> std::io::Result<()> {
    let mut socket = BufReader::new(stream);
    socket.write_all(b"220 loopback SMTP ready\r\n").await?;
    loop {
        let mut line = String::new();
        if socket.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let command = line
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        shared
            .state
            .lock()
            .unwrap()
            .smtp_commands
            .push(if command == "AUTH" {
                "AUTH [redacted]".into()
            } else {
                line.trim().into()
            });
        let response = match command.as_str() {
            "EHLO" => "250-loopback\r\n250 AUTH PLAIN\r\n",
            "AUTH" => "235 authenticated\r\n",
            "MAIL" | "RCPT" | "RSET" => "250 accepted\r\n",
            "DATA" => {
                socket.write_all(b"354 send message\r\n").await?;
                let mut body = String::new();
                loop {
                    let mut part = String::new();
                    if socket.read_line(&mut part).await? == 0 {
                        return Ok(());
                    }
                    if part == ".\r\n" {
                        break;
                    }
                    body.push_str(part.strip_prefix('.').unwrap_or(&part));
                }
                shared.state.lock().unwrap().smtp_messages.push(body);
                "250 queued\r\n"
            }
            "QUIT" => {
                socket.write_all(b"221 closing\r\n").await?;
                return Ok(());
            }
            _ => "500 unsupported\r\n",
        };
        socket.write_all(response.as_bytes()).await?;
    }
}
