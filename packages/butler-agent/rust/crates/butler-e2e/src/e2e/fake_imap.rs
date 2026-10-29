//! Push-driven loopback IMAP and SMTP fixtures. Credentials are never logged.
#![allow(clippy::unwrap_used, reason = "harness fixture locks")]
mod gmail;
mod protocol;
mod smtp;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, sync::broadcast, task::JoinHandle};
use tokio_util::sync::CancellationToken;

/// Stored message and server flags, available for acceptance assertions.
#[derive(Clone, Debug)]
pub struct Message {
    key: u64,
    pub uid: u32,
    pub raw: String,
    pub flags: Vec<String>,
}
#[derive(Clone)]
struct Mailbox {
    roles: Vec<String>,
    validity: u32,
    next: u32,
    messages: Vec<Message>,
}
#[derive(Default, PartialEq)]
enum Dialect {
    #[default]
    Imap,
    Gmail,
}
#[derive(Default)]
struct Capabilities {
    move_cap: bool,
    uidplus: bool,
    idle: bool,
    dialect: Dialect,
}
#[derive(Default)]
struct Listing {
    special_use: bool,
    extended_roles: bool,
}
#[derive(Default)]
struct State {
    next_message: u64,
    boxes: BTreeMap<String, Mailbox>,
    commands: Vec<String>,
    smtp_messages: Vec<String>,
    smtp_commands: Vec<String>,
    capabilities: Capabilities,
    listing: Listing,
    reject_login: bool,
    stall_done: bool,
    stall_command: Option<String>,
    flap: usize,
    connections: Vec<std::time::Instant>,
}
#[derive(Clone)]
struct Shared {
    state: Arc<Mutex<State>>,
    changed: broadcast::Sender<String>,
    disconnect: broadcast::Sender<()>,
}
/// Owns all fake listener and connection tasks; dropping it aborts the listeners.
pub struct FakeImap {
    pub imap_port: u16,
    pub smtp_port: u16,
    shared: Shared,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl FakeImap {
    pub async fn start() -> std::io::Result<Self> {
        let imap = TcpListener::bind("127.0.0.1:0").await?;
        let smtp = TcpListener::bind("127.0.0.1:0").await?;
        let imap_port = imap.local_addr()?.port();
        let smtp_port = smtp.local_addr()?.port();
        let (changed, _) = broadcast::channel(1024);
        let mut state = State {
            capabilities: Capabilities {
                move_cap: true,
                uidplus: true,
                idle: true,
                dialect: Dialect::Imap,
            },
            listing: Listing {
                special_use: true,
                extended_roles: false,
            },
            ..Default::default()
        };
        for (name, roles) in [
            ("INBOX", vec![]),
            ("Filed", vec![]),
            ("All", vec!["\\All"]),
            ("Unknown", vec![]),
            ("Archive", vec!["\\Archive"]),
            ("Drafts", vec!["\\Drafts"]),
            ("Bin", vec!["\\Trash"]),
            ("Spam", vec!["\\Junk"]),
        ] {
            state.boxes.insert(
                name.into(),
                Mailbox {
                    roles: roles.into_iter().map(str::to_owned).collect(),
                    validity: 1,
                    next: 1,
                    messages: vec![],
                },
            );
        }
        let shared = Shared {
            state: Arc::new(Mutex::new(state)),
            changed,
            disconnect: broadcast::channel(16).0,
        };
        let stop = CancellationToken::new();
        let task = tokio::spawn(listen(imap, smtp, shared.clone(), stop.clone()));
        Ok(Self {
            imap_port,
            smtp_port,
            shared,
            stop,
            task,
        })
    }
    pub fn gmail(&self) {
        self.shared.state.lock().unwrap().capabilities.dialect = Dialect::Gmail;
    }
    pub fn special_use(&self, advertised: bool, extended_only: bool) {
        let mut state = self.shared.state.lock().unwrap();
        state.listing.special_use = advertised;
        state.listing.extended_roles = extended_only;
    }
    pub fn stall_command(&self, command: Option<&str>) {
        self.shared.state.lock().unwrap().stall_command = command.map(str::to_owned);
    }
    pub fn idle_supported(&self, supported: bool) {
        self.shared.state.lock().unwrap().capabilities.idle = supported;
    }
    pub fn stall_done(&self, stall: bool) {
        self.shared.state.lock().unwrap().stall_done = stall;
    }
    pub fn flap(&self, attempts: usize) {
        self.shared.state.lock().unwrap().flap = attempts;
    }
    pub fn disconnect(&self) {
        let _ = self.shared.disconnect.send(());
    }
    pub fn connections(&self) -> Vec<std::time::Instant> {
        self.shared.state.lock().unwrap().connections.clone()
    }
    pub fn capabilities(&self, move_cap: bool, uidplus: bool) {
        let mut state = self.shared.state.lock().unwrap();
        state.capabilities.move_cap = move_cap;
        state.capabilities.uidplus = uidplus;
    }
    pub fn reject_login(&self, reject: bool) {
        self.shared.state.lock().unwrap().reject_login = reject;
    }
    pub fn deliver(&self, mailbox: &str, raw: &str) -> u32 {
        self.shared.deliver(mailbox, raw)
    }
    pub fn move_by_user(&self, message_id: &str, to: &str) {
        let mut state = self.shared.state.lock().unwrap();
        let mut found = None;
        for mailbox in state.boxes.values_mut() {
            if let Some(index) = mailbox.messages.iter().position(|m| {
                m.raw
                    .lines()
                    .any(|l| l.eq_ignore_ascii_case(&format!("Message-ID: <{message_id}>")))
            }) {
                found = Some(mailbox.messages.remove(index));
                break;
            }
        }
        if let Some(mut message) = found {
            let target = state.boxes.get_mut(to).unwrap();
            message.uid = target.next;
            target.next += 1;
            target.messages.push(message);
        }
        drop(state);
        let _ = self.shared.changed.send(to.into());
    }
    pub fn reset_validity(&self) {
        let mut state = self.shared.state.lock().unwrap();
        let inbox = state.boxes.get_mut("INBOX").unwrap();
        inbox.validity += 1;
    }
    pub fn snapshot(&self) -> BTreeMap<String, Vec<Message>> {
        self.shared
            .state
            .lock()
            .unwrap()
            .boxes
            .iter()
            .map(|(k, b)| (k.clone(), b.messages.clone()))
            .collect()
    }
    pub fn commands(&self) -> Vec<String> {
        self.shared.state.lock().unwrap().commands.clone()
    }
    pub fn smtp_messages(&self) -> Vec<String> {
        self.shared.state.lock().unwrap().smtp_messages.clone()
    }
    pub fn smtp_commands(&self) -> Vec<String> {
        self.shared.state.lock().unwrap().smtp_commands.clone()
    }
    pub fn assert_no_forbidden_destinations(&self) {
        for mailbox in self.shared.state.lock().unwrap().boxes.values() {
            if mailbox
                .roles
                .iter()
                .any(|r| r == "\\Trash" || r == "\\Junk")
            {
                assert!(mailbox.messages.is_empty());
            }
        }
    }
}
impl Drop for FakeImap {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}
impl Shared {
    fn deliver(&self, mailbox: &str, raw: &str) -> u32 {
        let mut state = self.state.lock().unwrap();
        state.next_message += 1;
        let key = state.next_message;
        let target = state.boxes.get_mut(mailbox).unwrap();
        let uid = target.next;
        target.next += 1;
        target.messages.push(Message {
            key,
            uid,
            raw: raw.into(),
            flags: vec![],
        });
        if state.capabilities.dialect == Dialect::Gmail {
            gmail::include_all(&mut state, mailbox, uid);
        }
        drop(state);
        let _ = self.changed.send(mailbox.into());
        uid
    }
}
async fn listen(imap: TcpListener, smtp: TcpListener, shared: Shared, stop: CancellationToken) {
    let mut children = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            ()=stop.cancelled()=>break,
            Some(_)=children.join_next(), if !children.is_empty()=>(),
            Ok((stream,_))=imap.accept()=> { let shared=shared.clone(); children.spawn(async move { let _=protocol::connection(stream,shared).await; }); }
            Ok((stream,_))=smtp.accept()=> { let shared=shared.clone(); children.spawn(async move { let _=smtp::connection(stream,shared).await; }); }
        }
    }
    children.abort_all();
    while children.join_next().await.is_some() {}
}
