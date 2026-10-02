//! Task XML and its execution fingerprint; no host side effects.
use super::{Definition, Error};
use base64::{Engine, engine::general_purpose::STANDARD};
use roxmltree::{Document, Node};
use serde_json::{Value, json};

const NS: &str = "http://schemas.microsoft.com/windows/2004/02/mit/task";

pub(crate) struct Task {
    pub definition: Definition,
    pub sid: String,
    pub enabled: bool,
    fingerprint: Vec<String>,
}

pub(crate) fn render(def: &Definition, sid: &str, shell: &str) -> Result<String, Error> {
    super::validate(def)?;
    let root = def.program.parent().ok_or(Error::InvalidValue)?;
    let metadata = json!({"program": def.program, "args": def.args, "env": def.env,
        "data": def.working_dir, "sid": sid, "shell": shell});
    let command = script(def);
    let encoded = STANDARD.encode(
        command
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let arguments =
        format!("-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {encoded}");
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="{NS}">
  <RegistrationInfo><Source>Butler Agent CLI</Source><Documentation>{metadata}</Documentation></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Agent"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Agent"><Exec><Command>{shell}</Command><Arguments>{arguments}</Arguments><WorkingDirectory>{root}</WorkingDirectory></Exec></Actions>
</Task>
"#,
        metadata = escape(&metadata.to_string()),
        sid = escape(sid),
        shell = escape(shell),
        arguments = escape(&arguments),
        root = escape(&root.to_string_lossy())
    ))
}

fn script(def: &Definition) -> String {
    let mut script = "$ErrorActionPreference='Stop';".to_owned();
    for (key, value) in &def.env {
        script.push_str(&format!(
            "[Environment]::SetEnvironmentVariable({},{},'Process');",
            quote(key),
            quote(value)
        ));
    }
    script.push_str(&format!("& {}", quote(&def.program.to_string_lossy())));
    for arg in &def.args {
        script.push(' ');
        script.push_str(&quote(arg));
    }
    script.push_str(";exit $LASTEXITCODE");
    script
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    let mut nodes = node.children().filter(|n| n.has_tag_name((NS, name)));
    let first = nodes.next()?;
    nodes.next().is_none().then_some(first)
}

fn field(node: Node<'_, '_>, name: &str) -> Option<String> {
    Some(child(node, name)?.text().unwrap_or_default().to_owned())
}

fn only_element<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    let mut children = node.children().filter(Node::is_element);
    let first = children.next()?;
    (children.next().is_none() && first.has_tag_name((NS, name))).then_some(first)
}

pub(crate) fn parse(xml: &str) -> Option<Task> {
    let document = Document::parse(xml).ok()?;
    let task = document.root_element();
    if !task.has_tag_name((NS, "Task")) {
        return None;
    }
    let info = child(task, "RegistrationInfo")?;
    if field(info, "Source")? != "Butler Agent CLI" {
        return None;
    }
    let metadata: Value = serde_json::from_str(&field(info, "Documentation")?).ok()?;
    let definition = Definition {
        program: metadata.get("program")?.as_str()?.into(),
        args: serde_json::from_value(metadata.get("args")?.clone()).ok()?,
        working_dir: metadata.get("data")?.as_str()?.into(),
        env: serde_json::from_value(metadata.get("env")?.clone()).ok()?,
    };
    let sid = metadata.get("sid")?.as_str()?.to_owned();
    let shell = metadata.get("shell")?.as_str()?;
    let expected = render(&definition, &sid, shell).ok()?;
    let expected_doc = Document::parse(&expected).ok()?;
    let fingerprint = fingerprint(task)?;
    if fingerprint != fingerprint_of(&expected_doc)? {
        return None;
    }
    let enabled = match field(child(task, "Settings")?, "Enabled")?.as_str() {
        "true" => true,
        "false" => false,
        _ => return None,
    };
    Some(Task {
        definition,
        sid,
        enabled,
        fingerprint,
    })
}

fn fingerprint_of(document: &Document<'_>) -> Option<Vec<String>> {
    fingerprint(document.root_element())
}

fn fingerprint(task: Node<'_, '_>) -> Option<Vec<String>> {
    let action = only_element(child(task, "Actions")?, "Exec")?;
    let principal = only_element(child(task, "Principals")?, "Principal")?;
    let trigger = only_element(child(task, "Triggers")?, "LogonTrigger")?;
    Some(vec![
        field(action, "Command")?,
        field(action, "Arguments")?,
        field(action, "WorkingDirectory")?,
        field(principal, "UserId")?,
        field(principal, "LogonType")?,
        field(principal, "RunLevel")?,
        field(trigger, "UserId")?,
        field(trigger, "Enabled")?,
    ])
}

pub(crate) fn same_owner(local: &str, remote: &str, sid: &str) -> bool {
    let (Some(local), Some(remote)) = (parse(local), parse(remote)) else {
        return false;
    };
    local.sid == sid && remote.sid == sid && local.fingerprint == remote.fingerprint
}

/// Decodes schtasks' Unicode output without silently dropping invalid bytes.
pub(crate) fn decode(bytes: &[u8]) -> Result<String, Error> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.get(1) == Some(&0) {
        let offset = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        let bytes = bytes.get(offset..).ok_or(Error::InvalidValue)?;
        if bytes.len() % 2 != 0 {
            return Err(Error::InvalidValue);
        }
        let words = bytes
            .chunks_exact(2)
            .map(|chunk| chunk.try_into().map(u16::from_le_bytes))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::InvalidValue)?;
        String::from_utf16(&words).map_err(|_| Error::InvalidValue)
    } else {
        std::str::from_utf8(bytes)
            .map(|text| text.trim_start_matches('\u{feff}').to_owned())
            .map_err(|_| Error::InvalidValue)
    }
}
