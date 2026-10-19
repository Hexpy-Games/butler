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
