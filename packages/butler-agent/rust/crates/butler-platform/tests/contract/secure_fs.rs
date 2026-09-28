//! Atomic owner-only writes, directory exchange and no-follow opens.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};

use butler_platform::secure_fs::{
    ExchangeError, create_private_dir_all, exchange_directories, identity, is_owner_only,
    no_follow, open_read_no_follow, owner_only, replace_private, restrict_file, restrict_open_file,
    symlink,
};

use super::scratch;

#[test]
fn replace_private_swaps_in_a_complete_owner_only_file() {
    let directory = scratch("replace");
    let path = directory.join("config.json");
    let temporary = directory.join(".config.tmp");
    fs::write(&path, "before").unwrap();
    let before = identity(&fs::metadata(&path).unwrap());

    replace_private(&path, &temporary, |file| file.write_all(b"after")).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "after");
    assert!(!temporary.exists());
    let metadata = fs::metadata(&path).unwrap();
    assert!(is_owner_only(&metadata));
    // A replaced file is a new file, which readers can tell apart.
    if !cfg!(windows) {
        assert_ne!(identity(&metadata).inode, before.inode);
    }

    let failed = replace_private(&path, &temporary, |file| {
        file.write_all(b"partial")?;
        Err(io::Error::other("writer failed"))
    });
    assert_eq!(failed.unwrap_err().to_string(), "writer failed");
    assert_eq!(fs::read_to_string(&path).unwrap(), "after");
    assert!(!temporary.exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn private_directories_and_files_are_owner_only() {
    let directory = scratch("private");
    let nested = directory.join("a/b");
    create_private_dir_all(&nested).unwrap();
    create_private_dir_all(&nested).unwrap();
    assert!(is_owner_only(&fs::metadata(&nested).unwrap()));

    let created = nested.join("created");
    owner_only(OpenOptions::new().write(true).create_new(true))
        .open(&created)
        .unwrap();
    assert!(is_owner_only(&fs::metadata(&created).unwrap()));

    let restricted = nested.join("restricted");
    fs::write(&restricted, "x").unwrap();
    restrict_file(&restricted).unwrap();
    assert!(is_owner_only(&fs::metadata(&restricted).unwrap()));

    let open = nested.join("open");
    let file = fs::File::create(&open).unwrap();
    restrict_open_file(&file).unwrap();
    assert!(is_owner_only(&file.metadata().unwrap()));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn exchange_directories_swaps_both_trees_atomically() {
    let directory = scratch("exchange");
    let left = directory.join("left");
    let right = directory.join("right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    fs::write(left.join("name"), "left").unwrap();
    fs::write(right.join("name"), "right").unwrap();
    match exchange_directories(&left, &right) {
        Err(ExchangeError::Unsupported) => assert!(cfg!(windows)),
        result => {
            result.unwrap();
            assert_eq!(fs::read_to_string(left.join("name")).unwrap(), "right");
            assert_eq!(fs::read_to_string(right.join("name")).unwrap(), "left");
        }
    }
    let missing = directory.join("missing");
    assert!(matches!(
        exchange_directories(&left, &missing),
        Err(ExchangeError::Io(_) | ExchangeError::Unsupported)
    ));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn no_follow_opens_refuse_a_symbolic_link() {
    let directory = scratch("no-follow");
    let target = directory.join("target");
    let link = directory.join("link");
    fs::write(&target, "secret").unwrap();
    if let Err(error) = symlink(&target, &link) {
        // Windows creates links only with Developer Mode or the privilege.
        assert!(cfg!(windows), "{error}");
        return;
    }
    assert!(open_read_no_follow(&link).is_err());
    assert_eq!(
        io::read_to_string(open_read_no_follow(&target).unwrap()).unwrap(),
        "secret"
    );
    let opened = no_follow(OpenOptions::new().read(true)).open(&link);
    // Windows opens are not reparse-point safe yet.
    assert_eq!(opened.is_err(), !cfg!(windows));
    let appended = no_follow(OpenOptions::new().append(true)).open(&link);
    assert_eq!(appended.is_err(), !cfg!(windows));
    assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
    fs::remove_dir_all(directory).unwrap();
}
