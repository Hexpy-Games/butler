//! Atomic owner-only writes, permission modes, directory exchange, file
//! identity and no-follow opens. Capabilities a host lacks report `None`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};

use butler_platform::secure_fs::{
    DIRECTORY_SYNC, ExchangeError, FILE_IDS, FileMode, NO_FOLLOW, OWNER_ONLY, PERMISSION_MODES,
    append_private, create_private_dir_all, exchange_directories, file_mode, identity,
    is_owner_only, is_private, no_follow, open_read_no_follow, owner_only, protect_folder,
    replace_private, restrict_directory, restrict_file, restrict_open_file, same_file,
    set_file_mode, symlink, sync_directory,
};

use super::scratch;

#[test]
fn capabilities_match_the_host() {
    let unix = cfg!(unix);
    assert_eq!(OWNER_ONLY, unix);
    assert_eq!(PERMISSION_MODES, unix);
    assert_eq!(NO_FOLLOW, unix);
    assert_eq!(FILE_IDS, unix);
    assert_eq!(DIRECTORY_SYNC, unix);
}

#[test]
fn replace_private_swaps_in_a_complete_owner_only_file() {
    let directory = scratch("replace");
    let path = directory.join("config.json");
    let neighbor = directory.join("neighbor.tmp");
    fs::write(&path, "before").unwrap();
    fs::write(&neighbor, "someone else's").unwrap();
    let before = fs::metadata(&path).unwrap();

    replace_private(
        &path,
        |file| file.write_all(b"after"),
        std::convert::identity,
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "after");
    let after = fs::metadata(&path).unwrap();
    assert_eq!(is_owner_only(&after), OWNER_ONLY.then_some(true));
    // A replaced file is a new file, which readers can tell apart.
    if FILE_IDS {
        assert!(!same_file(&before, &after));
    }

    let failed = replace_private(
        &path,
        |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("writer failed"))
        },
        std::convert::identity,
    );
    assert_eq!(failed.unwrap_err().to_string(), "writer failed");
    assert_eq!(fs::read_to_string(&path).unwrap(), "after");
    // Only the target and the untouched neighbor are left: no temporary file
    // survives, and nothing this call did not create was removed.
    let mut names: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["config.json", "neighbor.tmp"]);
    assert_eq!(fs::read_to_string(&neighbor).unwrap(), "someone else's");
    assert_eq!(sync_directory(&directory).is_some(), DIRECTORY_SYNC);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn private_directories_and_files_are_owner_only_where_supported() {
    let directory = scratch("private");
    let nested = directory.join("a/b");
    create_private_dir_all(&nested).unwrap();
    create_private_dir_all(&nested).unwrap();
    let private = OWNER_ONLY.then_some(true);
    assert_eq!(is_owner_only(&fs::metadata(&nested).unwrap()), private);
    assert_eq!(is_private(&nested), Some(true));

    let created = nested.join("created");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    assert_eq!(owner_only(&mut options).is_some(), OWNER_ONLY);
    options.open(&created).unwrap();
    assert_eq!(is_owner_only(&fs::metadata(&created).unwrap()), private);
    assert_eq!(is_private(&created), Some(true));

    // A folder made elsewhere is protected on hosts that use access lists.
    let elsewhere = directory.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    assert_eq!(
        protect_folder(&elsewhere).transpose().unwrap().is_some(),
        !OWNER_ONLY
    );
    if !OWNER_ONLY {
        fs::write(elsewhere.join("secret"), "x").unwrap();
        assert_eq!(is_private(&elsewhere.join("secret")), Some(true));
    }

    let restricted = nested.join("restricted");
    fs::write(&restricted, "x").unwrap();
    assert_eq!(
        restrict_file(&restricted).transpose().unwrap(),
        OWNER_ONLY.then_some(())
    );
    assert_eq!(is_owner_only(&fs::metadata(&restricted).unwrap()), private);
    if let Some(result) = set_file_mode(&restricted, FileMode::GROUP_READABLE) {
        result.unwrap();
    }
    let mut append = append_private(&restricted).unwrap();
    append.write_all(b" appended").unwrap();
    append.sync_all().unwrap();
    assert_eq!(is_owner_only(&append.metadata().unwrap()), private);
    assert_eq!(fs::read_to_string(&restricted).unwrap(), "x appended");
    drop(append);

    let file = fs::File::create(nested.join("open")).unwrap();
    assert_eq!(
        restrict_open_file(&file).transpose().unwrap(),
        OWNER_ONLY.then_some(())
    );
    assert_eq!(is_owner_only(&file.metadata().unwrap()), private);
    assert_eq!(
        restrict_directory(&nested).transpose().unwrap(),
        OWNER_ONLY.then_some(())
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn permission_modes_are_read_and_set_where_supported() {
    let directory = scratch("modes");
    let path = directory.join("shared");
    fs::write(&path, "x").unwrap();
    let set = set_file_mode(&path, FileMode::GROUP_READABLE);
    assert_eq!(set.is_some(), PERMISSION_MODES);
    match set {
        Some(result) => {
            result.unwrap();
            let mode = file_mode(&fs::metadata(&path).unwrap());
            assert_eq!(mode, Some(FileMode::GROUP_READABLE));
            assert_eq!(is_owner_only(&fs::metadata(&path).unwrap()), Some(false));
        }
        None => assert_eq!(file_mode(&fs::metadata(&path).unwrap()), None),
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn file_ids_are_reported_only_where_the_host_has_them() {
    let directory = scratch("identity");
    let path = directory.join("file");
    fs::write(&path, "x").unwrap();
    let first = identity(&fs::metadata(&path).unwrap());
    assert_eq!(first.id.is_some(), FILE_IDS);
    assert!(first.modified.is_some());
    assert_eq!(identity(&fs::metadata(&path).unwrap()).id, first.id);
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
    let mut options = OpenOptions::new();
    options.append(true);
    let refusing = no_follow(&mut options);
    assert_eq!(refusing.is_some(), NO_FOLLOW);
    if let Some(options) = refusing {
        assert!(options.open(&link).is_err());
        assert!(append_private(&link).is_err());
    }
    assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
    fs::remove_dir_all(directory).unwrap();
}
