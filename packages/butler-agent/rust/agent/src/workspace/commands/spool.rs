use std::path::{Path, PathBuf};

use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdout};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{CommandError, GuidedSummary, SpooledPayload};

pub(super) struct Spool {
    stdout_path: PathBuf,
    stderr_path: PathBuf,
    payload_path: PathBuf,
    stdout_file: File,
    stderr_file: File,
}

pub(super) struct Capture {
    stdout: JoinHandle<std::io::Result<()>>,
    stderr: JoinHandle<std::io::Result<()>>,
    failure: mpsc::Receiver<CommandError>,
    stop: CancellationToken,
}

impl Spool {
    pub(super) async fn create(butler_data: &Path) -> Result<Self, CommandError> {
        let root = butler_data.join("runtime/btcc/command-spool");
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(CommandError::io)?;
        let id = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4());
        let stdout_path = root.join(format!("{id}.stdout"));
        let stderr_path = root.join(format!("{id}.stderr"));
        let payload_path = root.join(format!("{id}.payload"));
        let stdout_file = exclusive(&stdout_path).await?;
        let stderr_file = match exclusive(&stderr_path).await {
            Ok(file) => file,
            Err(error) => {
                let _ = tokio::fs::remove_file(&stdout_path).await;
                return Err(error);
            }
        };
        Ok(Self {
            stdout_path,
            stderr_path,
            payload_path,
            stdout_file,
            stderr_file,
        })
    }

    pub(super) fn capture(
        self,
        stdout: ChildStdout,
        stderr: ChildStderr,
        fail_after_first_chunk: bool,
    ) -> (SpoolPaths, Capture) {
        let paths = SpoolPaths {
            stdout: self.stdout_path,
            stderr: self.stderr_path,
            payload: self.payload_path,
        };
        let (failure_tx, failure) = mpsc::channel(2);
        let stop = CancellationToken::new();
        let stdout_task = tokio::spawn(report_copy(
            stdout,
            self.stdout_file,
            failure_tx.clone(),
            stop.clone(),
            fail_after_first_chunk,
        ));
        let stderr_task = tokio::spawn(report_copy(
            stderr,
            self.stderr_file,
            failure_tx,
            stop.clone(),
            false,
        ));
        (
            paths,
            Capture {
                stdout: stdout_task,
                stderr: stderr_task,
                failure,
                stop,
            },
        )
    }

    pub(super) async fn discard(self) {
        drop(self.stdout_file);
        drop(self.stderr_file);
        for path in [&self.stdout_path, &self.stderr_path, &self.payload_path] {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

pub(super) struct SpoolPaths {
    stdout: PathBuf,
    stderr: PathBuf,
    payload: PathBuf,
}

impl Capture {
    pub(super) async fn failure(&mut self) -> CommandError {
        match self.failure.recv().await {
            Some(error) => error,
            None => std::future::pending().await,
        }
    }
    pub(super) fn stop(&self) {
        self.stop.cancel();
    }
    pub(super) async fn finish(self, stopped: bool) -> Result<(), CommandError> {
        let mut first_error = None;
        for task in [self.stdout, self.stderr] {
            match task.await {
                Ok(Ok(())) => {}
                Err(error) if stopped && error.is_cancelled() => {}
                Ok(Err(error)) => {
                    if first_error.is_none() {
                        first_error = Some(CommandError::io(error));
                    }
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(CommandError::new(
                            "command_capture_failed",
                            error.to_string(),
                        ));
                    }
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl SpoolPaths {
    pub(super) async fn complete(
        self,
        capture: Capture,
        summary: &GuidedSummary,
        stopped: bool,
    ) -> Result<SpooledPayload, CommandError> {
        if let Err(error) = capture.finish(stopped).await {
            self.discard().await;
            return Err(error);
        }
        let result = self.write_payload(summary).await;
        if result.is_err() {
            self.discard().await;
            return result;
        }
        let (stdout_cleanup, stderr_cleanup) = tokio::join!(
            tokio::fs::remove_file(&self.stdout),
            tokio::fs::remove_file(&self.stderr),
        );
        if let Some(error) = stdout_cleanup.err().or_else(|| stderr_cleanup.err()) {
            self.discard().await;
            return Err(CommandError::io(error));
        }
        result
    }

    async fn write_payload(&self, summary: &GuidedSummary) -> Result<SpooledPayload, CommandError> {
        let mut payload = exclusive(&self.payload).await?;
        let mut size = 0_u64;
        let header = serde_json::to_vec(summary)
            .map_err(|error| CommandError::new("command_json_failed", error.to_string()))?;
        write_chunk(&mut payload, &mut size, &header).await?;
        write_chunk(&mut payload, &mut size, b"\n--- stdout ---\n").await?;
        let stdout_start = size;
        copy_payload(&self.stdout, &mut payload, &mut size).await?;
        let stdout_len = size - stdout_start;
        write_chunk(&mut payload, &mut size, b"\n--- stderr ---\n").await?;
        let stderr_start = size;
        copy_payload(&self.stderr, &mut payload, &mut size).await?;
        let stderr_len = size - stderr_start;
        payload.flush().await.map_err(CommandError::io)?;
        drop(payload);
        Ok(SpooledPayload {
            path: self.payload.clone(),
            stdout_start,
            stdout_len,
            stderr_start,
            stderr_len,
        })
    }

    pub(super) async fn discard(&self) {
        for path in [&self.stdout, &self.stderr, &self.payload] {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

async fn exclusive(path: &Path) -> Result<File, CommandError> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(CommandError::io)
}

async fn copy_pipe<R: AsyncRead + Unpin>(
    mut reader: R,
    mut writer: File,
    stop: CancellationToken,
) -> std::io::Result<()> {
    let mut bytes = [0_u8; 8192];
    loop {
        let count = tokio::select! {
            count = reader.read(&mut bytes) => count?,
            _ = stop.cancelled() => break,
        };
        if count == 0 {
            break;
        }
        writer.write_all(&bytes[..count]).await?;
    }
    writer.flush().await
}

async fn report_copy<R: AsyncRead + Unpin>(
    reader: R,
    writer: File,
    failure: mpsc::Sender<CommandError>,
    stop: CancellationToken,
    fail_after_first_chunk: bool,
) -> std::io::Result<()> {
    #[cfg(test)]
    let result = if fail_after_first_chunk {
        copy_pipe_with_fault(reader, writer).await
    } else {
        copy_pipe(reader, writer, stop).await
    };
    #[cfg(not(test))]
    let result = {
        let _ = fail_after_first_chunk;
        copy_pipe(reader, writer, stop).await
    };
    if let Err(error) = &result {
        let _ = failure
            .send(CommandError::new(
                "command_capture_failed",
                error.to_string(),
            ))
            .await;
    }
    result
}

#[cfg(test)]
async fn copy_pipe_with_fault<R: AsyncRead + Unpin>(
    mut reader: R,
    mut writer: File,
) -> std::io::Result<()> {
    let mut bytes = [0_u8; 8192];
    let count = reader.read(&mut bytes).await?;
    if count != 0 {
        writer.write_all(&bytes[..count]).await?;
    }
    Err(std::io::Error::other(
        "injected command capture write failure",
    ))
}

async fn copy_payload(path: &Path, payload: &mut File, size: &mut u64) -> Result<(), CommandError> {
    let mut source = File::open(path).await.map_err(CommandError::io)?;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = source.read(&mut buffer).await.map_err(CommandError::io)?;
        if count == 0 {
            return Ok(());
        }
        write_chunk(payload, size, &buffer[..count]).await?;
    }
}

async fn write_chunk(payload: &mut File, size: &mut u64, bytes: &[u8]) -> Result<(), CommandError> {
    payload.write_all(bytes).await.map_err(CommandError::io)?;
    *size = size.checked_add(bytes.len() as u64).ok_or_else(|| {
        CommandError::new(
            "command_output_overflow",
            "Command output length overflowed",
        )
    })?;
    Ok(())
}
