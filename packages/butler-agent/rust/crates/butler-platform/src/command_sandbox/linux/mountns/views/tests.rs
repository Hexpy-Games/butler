//! Pin the indexed mount lookup to the previous full-snapshot algorithm.
use super::*;

fn mount(device: &str, source: &str, target: &str) -> Mount {
    Mount {
        device: device.into(),
        source: source.into(),
        target: target.into(),
        options: "rw".into(),
    }
}

fn previous_owner<'a>(snapshot: &'a Snapshot, path: &Path) -> Option<&'a Mount> {
    snapshot
        .mounts
        .iter()
        .filter(|mount| beneath(path, &mount.target).is_some())
        .max_by_key(|mount| mount.target.as_os_str().len())
}

// test-category: security
#[test]
fn indexed_lookup_preserves_mount_coordinates_and_denial_plan() -> Result<(), Error> {
    let mut mounts = vec![
        mount("8:1", "/", "/"),
        mount("8:1", "/", "/views/root"),
        mount("8:1", "/home/person", "/views/home"),
        mount("0:4", "/", "/proc"),
        mount("8:2", "/", "/workspace"),
        // The later stacked mount must hide the earlier view.
        mount("8:3", "/", "/workspace"),
        mount("8:1", "/home/person/project", "/workspace"),
        mount("8:4", "/", "/views/root/home/person/.ssh"),
        mount("8:5", "/", "/home/person/project/deep"),
    ];
    for index in 0..128 {
        mounts.push(mount("0:5", "/", &format!("/unrelated/{index}")));
    }
    let snapshot = Snapshot::new(mounts);
    // Resolved secret targets and missing credential roots use the same
    // coordinates: existence must never affect which mount view is withheld.
    let paths: Vec<PathBuf> = [
        "/home/person/.ssh",
        "/home/person/.config/gh",
        "/home/person/project/.env",
        "/home/person/project/secrets.json",
        "/home/person/private-target",
        "/workspace/.env",
        "/workspace/nested/.env",
        "/home/person/project/deep/file",
        "/workspace-other/file",
        "/proc/self",
        "/views/root/home/person/.ssh/key",
        "/",
        "/workspace/",
        "/home/person/project/한국어 ✓/key.pem",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    for path in paths
        .iter()
        .chain(snapshot.mounts.iter().map(|mount| &mount.target))
        .chain(paths.iter().rev())
    {
        let previous = previous_owner(&snapshot, path).ok_or("missing previous mount")?;
        let indexed = snapshot.owner(path).ok_or("missing indexed mount")?;
        assert!(std::ptr::eq(previous, indexed), "{path:?}");
        let relative = beneath(path, &previous.target).ok_or("missing relative path")?;
        assert_eq!(
            snapshot.backing(path)?,
            (previous.device.as_str(), join(&previous.source, relative))
        );
    }
    let denied: Vec<PathBuf> = [
        "/home/person/.ssh",
        "/home/person/.config/gh",
        "/home/person/project/.env",
        "/home/person/private-target",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    assert_eq!(
        snapshot.withheld(&denied, Some(&["/workspace".into()]))?,
        vec![
            PathBuf::from("/home/person/.config/gh"),
            PathBuf::from("/home/person/.ssh"),
            PathBuf::from("/home/person/private-target"),
            PathBuf::from("/home/person/project/.env"),
            PathBuf::from("/views/home"),
            PathBuf::from("/views/root"),
            PathBuf::from("/workspace/.env"),
        ]
    );
    Ok(())
}

// test-category: security
#[test]
fn mount_parser_preserves_previous_fields_and_escape_validation() -> Result<(), Error> {
    let input = concat!(
        "1 0 8:1 / / rw - ext4 /dev/root rw,relatime\n",
        "2 1 8:1 /home/person/project /workspace ro shared:1 - ext4 /dev/root rw\n",
        "3 1 8:2 / /workspace rw - tmpfs tmpfs rw\n",
        "4 1 8:1 /space\\040project /한글\\040✓ rw - ext4 /dev/root rw\n",
    );
    let snapshot = parse(input)?;
    let previous = input
        .lines()
        .map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let [_, _, device, source, target, options, ..] = fields.as_slice() else {
                return Err("invalid mountinfo".into());
            };
            Ok((
                (*device).to_owned(),
                previous_decode(source)?,
                previous_decode(target)?,
                (*options).to_owned(),
            ))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let actual: Vec<_> = snapshot
        .mounts
        .into_iter()
        .map(|mount| (mount.device, mount.source, mount.target, mount.options))
        .collect();
    assert_eq!(actual, previous);
    for encoded in [
        "plain",
        "한글 ✓",
        r"\040",
        r"\134",
        r"\377",
        r"\400",
        r"\12",
        r"\x00",
    ] {
        assert_eq!(
            decode(encoded).ok(),
            previous_decode(encoded).ok(),
            "{encoded}"
        );
    }
    for malformed in ["1", "1 2 3 4 5", r"1 2 8:1 /bad\999 /target rw"] {
        assert!(parse(malformed).is_err(), "{malformed}");
    }
    Ok(())
}

fn previous_decode(encoded: &str) -> Result<PathBuf, Error> {
    use std::os::unix::ffi::OsStringExt;
    let mut decoded = Vec::new();
    let mut bytes = encoded.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'\\' {
            let mut value = 0u8;
            for digit in [bytes.next(), bytes.next(), bytes.next()] {
                let digit = digit
                    .filter(|digit| (b'0'..=b'7').contains(digit))
                    .ok_or("invalid mountinfo escape")?;
                value = value
                    .checked_mul(8)
                    .and_then(|value| value.checked_add(digit - b'0'))
                    .ok_or("mountinfo escape overflow")?;
            }
            decoded.push(value);
        } else {
            decoded.push(byte);
        }
    }
    Ok(std::ffi::OsString::from_vec(decoded).into())
}
