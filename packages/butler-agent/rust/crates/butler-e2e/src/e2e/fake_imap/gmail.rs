//! Gmail's mailbox views share message identity; labels change view membership.
use super::{Mailbox, Message, Shared, State};

fn insert(mailbox: &mut Mailbox, mut message: Message) {
    if !mailbox.messages.iter().any(|m| m.key == message.key) {
        message.uid = mailbox.next;
        mailbox.next += 1;
        mailbox.messages.push(message);
    }
}
pub(super) fn include_all(state: &mut State, selected: &str, uid: u32) {
    let message = state.boxes[selected]
        .messages
        .iter()
        .find(|m| m.uid == uid)
        .unwrap()
        .clone();
    for mailbox in state
        .boxes
        .values_mut()
        .filter(|b| b.roles.iter().any(|r| r == "\\All"))
    {
        insert(mailbox, message.clone());
    }
}
fn label(name: &str, mailbox: &Mailbox) -> String {
    if name.eq_ignore_ascii_case("INBOX") {
        return "\\Inbox".into();
    }
    mailbox
        .roles
        .first()
        .cloned()
        .unwrap_or_else(|| name.into())
}
pub(super) fn labels(state: &State, selected: &str, uid: u32) -> String {
    let Some(message) = state.boxes[selected].messages.iter().find(|m| m.uid == uid) else {
        return String::new();
    };
    state
        .boxes
        .iter()
        .filter(|(_, b)| {
            !b.roles.iter().any(|r| r == "\\All") && b.messages.iter().any(|m| m.key == message.key)
        })
        .map(|(name, b)| {
            let label = label(name, b);
            if label.starts_with('\\') {
                label
            } else {
                format!("\"{}\"", label.replace('\\', "\\\\").replace('"', "\\\""))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub(super) fn store(
    state: &mut State,
    args: &[String],
    selected: &str,
    shared: &Shared,
) -> Result<String, ()> {
    let uid = args[1].parse::<u32>().map_err(|_| ())?;
    let message = state.boxes[selected]
        .messages
        .iter()
        .find(|m| m.uid == uid)
        .ok_or(())?
        .clone();
    let labels = args[3..]
        .iter()
        .map(|s| s.trim_matches(['(', ')']))
        .filter(|s| !s.is_empty());
    let mut targets = Vec::new();
    for target in labels {
        let name = state
            .boxes
            .iter()
            .find(|(name, b)| label(name, b).eq_ignore_ascii_case(target))
            .map(|(name, _)| name.clone())
            .ok_or(())?;
        targets.push(name);
    }
    for name in targets {
        let mailbox = state.boxes.get_mut(&name).ok_or(())?;
        if args[2].starts_with('+') {
            insert(mailbox, message.clone());
        } else {
            mailbox.messages.retain(|m| m.key != message.key);
        }
        let _ = shared.changed.send(name);
    }
    Ok(String::new())
}
