#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_canon::{
    store::api::{sql, tags::name_key},
    work_schema,
};
use rusqlite::Connection;

pub(super) fn tag_keys_use_full_unicode_casefold_and_canonical_normalization() {
    for (left, right) in [
        ("Bug", "bug"),
        ("Straße", "STRASSE"),
        ("Σςσ", "σσσ"),
        ("É", "E\u{301}"),
        ("가", "\u{1100}\u{1161}"),
        ("İ", "i\u{307}"),
        ("ﬃ", "FFI"),
        ("Ა", "ა"),
    ] {
        assert_eq!(name_key(left), name_key(right), "{left} / {right}");
    }
    assert_ne!(name_key("I"), name_key("ı"));
    assert_ne!(name_key("Ａ"), name_key("A"));
}
pub(super) fn tag_color_check_matches_the_design_system_vocabulary() {
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    let source = include_str!(
        "../../../../../../butler-app/client/ui/src/libs/design-system/components/Tag/tagTones.ts"
    );
    let tones: Vec<_> = source
        .split("export const tagLabelTones = [")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap()
        .split(',')
        .map(|s| s.trim().trim_matches('"'))
        .collect();
    let schema: String = db
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='canon_tags'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let actual: Vec<_> = schema
        .split("color IN (")
        .nth(1)
        .unwrap()
        .split(')')
        .next()
        .unwrap()
        .split(',')
        .map(|s| s.trim().trim_matches('\''))
        .collect();
    assert_eq!(actual, tones);
    for tone in tones {
        db.execute(
            sql::INSERT_TAG,
            rusqlite::params![tone, "project", tone, tone, tone, 1, "{}"],
        )
        .unwrap();
    }
    assert!(
        db.execute(
            sql::INSERT_TAG,
            rusqlite::params!["hex", "project", "hex", "hex", "#fff", 1, "{}"]
        )
        .is_err()
    );
}
pub(super) fn tag_schema_has_unique_names_cascading_links_and_idempotent_creation() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch("INSERT INTO canon_epics(id,project_id,title,origin,created_at,updated_at,created_by) VALUES('epic','project','Title','board',1,1,'{}')").unwrap();
    db.execute(
        sql::INSERT_TAG,
        rusqlite::params!["tag", "project", "Name", "name", "gray", 1, "{}"],
    )
    .unwrap();
    assert!(
        db.execute(
            sql::INSERT_TAG,
            rusqlite::params!["duplicate", "project", "NAME", "name", "gray", 1, "{}"]
        )
        .is_err()
    );
    db.execute(sql::ASSIGN_TAG, ["epic", "tag"]).unwrap();
    work_schema::ensure(&db).unwrap();
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epic_tags", [], |r| r.get(0))
            .unwrap(),
        1
    );
    db.execute(sql::DELETE_TAG, ["tag"]).unwrap();
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epic_tags", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
