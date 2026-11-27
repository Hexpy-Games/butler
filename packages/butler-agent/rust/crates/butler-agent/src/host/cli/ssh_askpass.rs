use std::{ffi::OsString, io::Write, process::ExitCode, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    runtime::Builder,
    time::timeout,
};
use zeroize::Zeroizing;

pub fn run(channel: OsString) -> ExitCode {
    let Ok(channel) = channel.into_string() else {
        return ExitCode::FAILURE;
    };
    let channel = Zeroizing::new(channel);
    let Some((port, token)) = channel.split_once(':') else {
        return ExitCode::FAILURE;
    };
    let Ok(port) = port.parse::<u16>() else {
        return ExitCode::FAILURE;
    };
    if port == 0 || token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return ExitCode::FAILURE;
    }
    let Ok(runtime) = Builder::new_current_thread().enable_all().build() else {
        return ExitCode::FAILURE;
    };

    let mut reply = Zeroizing::new([0; 4096 + 1]);
    let result = runtime.block_on(async {
        timeout(Duration::from_secs(10), async {
            #[allow(
                clippy::disallowed_methods,
                reason = "single-use loopback askpass channel that must stay out of HTTP logs"
            )]
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
            stream.write_all(token.as_bytes()).await.ok()?;
            stream.write_all(b"\n").await.ok()?;

            let mut filled = 0;
            while filled < reply.len() {
                let read = stream.read(&mut reply[filled..]).await.ok()?;
                if read == 0 {
                    return None;
                }
                if let Some(end) = reply[filled..filled + read]
                    .iter()
                    .position(|&byte| byte == b'\n')
                {
                    return Some(filled + end + 1);
                }
                filled += read;
            }
            None
        })
        .await
    });
    let Ok(Some(length)) = result else {
        return ExitCode::FAILURE;
    };
    let mut stdout = std::io::stdout().lock();
    match stdout
        .write_all(&reply[..length])
        .and_then(|()| stdout.flush())
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
