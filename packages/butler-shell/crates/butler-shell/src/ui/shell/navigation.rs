//! The native launch contract, shared by argv, open-url events and the live harness.
use super::Shell;
use crate::ui::source::{ChatId, ChatRef, SessionId};
use gpui::{Context, Window};

#[derive(Clone, Debug)]
pub(crate) enum Navigation {
    NewChat,
    Session(String),
}

impl Navigation {
    pub(crate) fn from_args(args: &[String]) -> Option<Self> {
        if args
            .iter()
            .any(|a| a == "--new-chat" || a == "--butler-new-chat")
        {
            return Some(Self::NewChat);
        }
        if let Some(arg) = args
            .iter()
            .find_map(|a| a.strip_prefix("--butler-open-session="))
        {
            return (!arg.trim().is_empty()).then(|| Self::Session(arg.trim().to_owned()));
        }
        args.iter()
            .find(|a| a.starts_with("butler://"))
            .and_then(|a| Self::from_url(a))
    }

    pub(crate) fn from_url(value: &str) -> Option<Self> {
        if !value.starts_with("butler://") {
            return None;
        }
        let url = url::Url::parse(value).ok()?;
        if url.scheme() != "butler"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        match url.host_str()? {
            "new-chat" if matches!(url.path(), "" | "/") => Some(Self::NewChat),
            "session" => {
                let path = url.path().strip_prefix('/')?;
                let bytes = path.as_bytes();
                for (i, b) in bytes.iter().enumerate() {
                    if *b == b'%'
                        && !bytes
                            .get(i + 1..i + 3)
                            .is_some_and(|s| s.iter().all(u8::is_ascii_hexdigit))
                    {
                        return None;
                    }
                }
                let id = percent_encoding::percent_decode_str(path)
                    .decode_utf8()
                    .ok()?;
                (!id.is_empty() && !id.contains('/') && id.encode_utf16().count() <= 256)
                    .then(|| Self::Session(id.into_owned()))
            }
            _ => None,
        }
    }
}

impl Shell {
    pub(crate) fn navigate(
        &mut self,
        request: Navigation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.is_none() {
            self.pending_navigation = Some(request);
            return;
        }
        let chat = match request {
            Navigation::NewChat => None,
            Navigation::Session(id) => Some(ChatRef {
                chat: ChatId(id.clone().into()),
                session: SessionId(id.into()),
            }),
        };
        self.open_chat(chat, window, cx);
        cx.activate(true);
    }
}
