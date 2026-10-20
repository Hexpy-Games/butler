use super::PathSyntax;
use std::{collections::HashMap, iter::Peekable, str::Chars};

pub(super) fn value<'a>(
    env: &'a HashMap<String, String>,
    name: &str,
    syntax: PathSyntax,
) -> Option<&'a str> {
    if syntax == PathSyntax::Posix {
        env.get(name).map(String::as_str)
    } else {
        env.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}
pub(super) fn home(env: &HashMap<String, String>, syntax: PathSyntax) -> Option<&str> {
    value(env, "HOME", syntax).or_else(|| value(env, "USERPROFILE", syntax))
}

pub(super) fn dollar(
    chars: &mut Peekable<Chars<'_>>,
    env: &HashMap<String, String>,
    syntax: PathSyntax,
) -> (String, bool) {
    if chars.peek() == Some(&'(') {
        return ("$".into(), false);
    }
    let name = if chars.peek() == Some(&'{') {
        chars.next();
        chars
            .by_ref()
            .take_while(|ch| *ch != '}')
            .collect::<String>()
    } else {
        let mut name = String::new();
        while chars.peek().is_some_and(|ch| {
            ch.is_alphanumeric() || *ch == '_' || *ch == ':' && syntax == PathSyntax::PowerShell
        }) {
            if let Some(ch) = chars.next() {
                name.push(ch);
            }
        }
        name
    };
    let name = if syntax == PathSyntax::PowerShell {
        name.get(..4)
            .filter(|prefix| prefix.eq_ignore_ascii_case("env:"))
            .and_then(|_| name.get(4..))
            .unwrap_or(&name)
    } else {
        &name
    };
    if name == "HOME" || syntax == PathSyntax::PowerShell && name.eq_ignore_ascii_case("HOME") {
        return home(env, syntax)
            .map(|v| (v.into(), true))
            .unwrap_or_default();
    }
    match value(env, name, syntax) {
        Some(value) => (value.to_owned(), true),
        None => (String::new(), false),
    }
}
