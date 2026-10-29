//! W3's live harness protocol. W5 can drive these same public UI actions.
use super::{Harness, ui};
use anyhow::{Context as _, anyhow, bail};
use std::{
    io::{self, BufRead as _, Write as _},
    path::Path,
    time::{Duration, Instant},
};
use ui::source::{Decision, agent::Attachment};

fn wait(
    h: &mut Harness,
    check: impl Fn(&ui::shell::Shell, &gpui::App) -> bool,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        super::settle(&mut h.cx, h.handle);
        if h.cx
            .update(|app| h.window.read(app).map(|s| check(s, app)))?
        {
            return Ok(());
        }
        if Instant::now() > deadline {
            bail!("live shell state deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn command(h: &mut Harness, dir: &Path, line: &str) -> anyhow::Result<()> {
    let (command, arg) = line.split_once(' ').unwrap_or((line, ""));
    match command {
        "connected" => wait(h, |s, _| {
            s.disconnected().is_none() && s.store.cursor.is_some() && !s.store.chats.is_empty()
        }),
        "left" => left(h, arg),
        "before" => before(h, arg),
        "stable" => stable(h),
        "attached" => attached(h),
        "controls" => wait(h, |s, app| {
            s.composer
                .read(app)
                .context
                .as_ref()
                .is_some_and(|context| {
                    let loaded = context.state == ui::source::model::Controls::Loaded;
                    loaded == (arg == "loaded")
                })
        }),
        "cursor" => {
            let cursor: u64 = arg.parse()?;
            wait(h, |s, _| s.store.cursor.is_some_and(|c| c.0 == cursor))
        }
        "disconnected" => wait(h, |s, _| s.disconnected().is_some()),
        "open" => h.update(|s, w, cx| super::open_chat(s, arg, w, cx)),
        "close" => h.update(|s, w, cx| s.open_chat(s.store.selected().cloned(), w, cx)),
        "new" => h.update(|s, w, cx| s.open_chat(None, w, cx)),
        "send" => h.update(|s, _, cx| s.send(arg.to_owned(), cx)),
        "answer" | "streaming" => wait(h, |s, app| {
            s.chat.read(app).messages.iter().any(|m| {
                m.role == ui::source::Role::Assistant
                    && m.text == arg
                    && m.streaming == (command == "streaming")
            })
        }),
        "roles" => wait(h, |s, app| {
            ["automation", "system"].iter().all(|role| {
                s.chat
                    .read(app)
                    .messages
                    .iter()
                    .any(|m| m.role == ui::source::Role::Other((*role).into()))
            })
        }),
        "approval" => wait(h, |s, _| s.store.approval().is_some()),
        "exact" => exact(h, arg),
        "allow" | "deny" => {
            h.update(|s, _, cx| {
                if let Some(card) = s.store.approval().cloned() {
                    s.answer(
                        &card.request,
                        if command == "allow" {
                            Decision::AllowOnce
                        } else {
                            Decision::Deny
                        },
                        cx,
                    );
                }
            })?;
            wait(h, |s, _| {
                s.store.approval().is_none() && (command == "allow" || s.store.running().is_none())
            })
        }
        "modify" => h.update(|s, w, cx| {
            if let Some(c) = s.store.approval().cloned() {
                s.open_modify(&c, w, cx);
            }
        }),
        "cancel" => {
            h.update(|s, _, cx| s.stop(cx))?;
            wait(h, |s, _| s.store.running().is_none())
        }
        "shot" => h.shot(dir, arg),
        _ => Err(anyhow!("unknown live harness command")),
    }
}
pub(super) fn run(dir: &Path, data: std::path::PathBuf, dark: bool) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut h = Harness::open(None, dark)?;
    let attachment = Attachment::start(Some(data));
    h.update(|s, _, cx| s.attach(attachment, cx))?;
    println!("LIVE READY");
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line == "quit" {
            return Ok(());
        }
        if let Err(error) = command(&mut h, dir, &line) {
            let _ = h.shot(dir, "failure");
            let state = h.cx.update(|app| h.window.read(app).map(|shell| {
                serde_json::json!({"disconnected":shell.disconnected().is_some(),
                    "running":shell.store.running().is_some(), "approval":shell.store.approval().is_some(),
                    "messages":shell.chat.read(app).messages.iter().map(|m| serde_json::json!({"id":m.id.as_ref(),"text":m.text,"streaming":m.streaming})).collect::<Vec<_>>()})
            }))?;
            std::fs::write(
                dir.join("failure-ui.json"),
                serde_json::to_vec_pretty(&state)?,
            )?;
            return Err(error).with_context(|| format!("command {line}"));
        }
        println!("LIVE OK");
        io::stdout().flush()?;
    }
    Ok(())
}

/// Both rows must be present, in the requested sidebar order.
fn before(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let (first, second) = arg.split_once(' ').context("before <first> <second>")?;
    wait(h, |s, _| {
        let position = |id: &str| {
            s.store
                .chats
                .iter()
                .position(|row| row.chat.chat.0.as_ref() == id)
        };
        matches!((position(first), position(second)), (Some(a), Some(b)) if a < b)
    })
}

/// Observe beyond the former five-second reconnect cycle after another client deletes.
fn left(h: &mut Harness, deleted: &str) -> anyhow::Result<()> {
    wait(h, |s, _| {
        s.store.selected().is_none()
            && !s
                .store
                .chats
                .iter()
                .any(|row| row.chat.chat.0.as_ref() == deleted)
    })?;
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        super::settle(&mut h.cx, h.handle);
        let attached = h.cx.update(|app| {
            h.window.read(app).map(|s| {
                s.disconnected().is_none()
                    && s.store.selected().is_none()
                    && s.chat.read(app).messages.is_empty()
            })
        })?;
        if !attached {
            bail!("deleted chat remained open or connection was lost");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn exact(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let found = h.cx.update(|app| {
        h.window.read(app).map(|s| {
            s.store
                .approval()
                .and_then(|c| c.approval.as_ref())
                .and_then(ui::source::Approval::action)
                .is_some_and(|text| text.as_ref() == arg)
        })
    })?;
    if !found {
        bail!("exact action missing");
    }
    Ok(())
}

/// A request failure must preserve the open chat and stream epoch throughout recovery.
fn stable(h: &mut Harness) -> anyhow::Result<()> {
    let (epoch, selected) = h.cx.update(|app| {
        h.window
            .read(app)
            .map(|s| (s.store.epoch(), s.store.selected().cloned()))
    })?;
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        super::settle(&mut h.cx, h.handle);
        let unchanged = h.cx.update(|app| {
            h.window.read(app).map(|s| {
                s.disconnected().is_none()
                    && s.store.epoch() == epoch
                    && s.store.selected() == selected.as_ref()
            })
        })?;
        if !unchanged {
            bail!("request failure changed selection or connection epoch");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn attached(h: &mut Harness) -> anyhow::Result<()> {
    let attached = h.cx.update(|app| {
        h.window
            .read(app)
            .map(|s| s.disconnected().is_none() && s.store.cursor.is_some())
    })?;
    if !attached {
        bail!("request failure disconnected the shell");
    }
    Ok(())
}
