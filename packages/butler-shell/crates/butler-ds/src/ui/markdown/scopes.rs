//! The scope to role table: the way `useSyntaxHighlight.tsx` maps `hljs-*` classes onto the ten
//! `--syntax-*` roles, restated for TextMate scopes (see the table in the module doc).
use syntect::parsing::Scope;

/// A `--syntax-*` role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Keyword,
    String,
    Comment,
    Number,
    Title,
    Type,
    Variable,
    Meta,
    Addition,
    Deletion,
}

/// One row: a scope prefix, the grammar root it applies in (any grammar when `None`) and the
/// role (`None` leaves the token plain and stops the search outward).
type Row = (&'static str, Option<&'static str>, Option<Role>);

use Role::{
    Addition, Comment, Deletion, Keyword, Meta, Number, String as Str, Title, Type, Variable,
};

#[rustfmt::skip]
const TABLE: &[Row] = &[
    // hljs-comment, hljs-quote
    ("comment", None, Some(Comment)),
    ("markup.quote", None, Some(Comment)),
    // hljs-string, hljs-regexp, hljs-template-tag
    ("string", None, Some(Str)),
    ("constant.character.escape", None, Some(Str)),
    // hljs-number, hljs-literal, hljs-symbol
    ("constant.numeric", None, Some(Number)),
    ("constant.language", None, Some(Number)),
    ("constant.other.symbol", None, Some(Number)),
    ("keyword.other.unit", None, Some(Number)),
    ("storage.modifier.lifetime", None, Some(Number)),
    // hljs-keyword, hljs-doctag, hljs-tag, hljs-name, hljs-selector-tag, hljs-bullet
    ("keyword.operator", None, None),
    ("keyword", None, Some(Keyword)),
    ("storage", None, Some(Keyword)),
    ("entity.name.tag", Some("source.yaml"), Some(Variable)),
    ("entity.name.tag", None, Some(Keyword)),
    ("punctuation.definition.tag", None, Some(Keyword)),
    ("punctuation.definition.list", None, Some(Keyword)),
    ("punctuation.definition.block.sequence", None, Some(Keyword)),
    // hljs-title, hljs-section, hljs-selector-class, hljs-selector-id
    ("entity.name.function", None, Some(Title)),
    ("entity.name.class", None, Some(Title)),
    ("entity.name.type", None, Some(Title)),
    ("entity.name.section", None, Some(Title)),
    ("variable.function", None, Some(Title)),
    ("markup.heading", None, Some(Title)),
    ("entity.other.attribute-name.class", None, Some(Title)),
    ("entity.other.attribute-name.id", None, Some(Title)),
    ("entity.other.attribute-name.pseudo-class", None, None),
    ("entity.other.attribute-name.pseudo-element", None, None),
    // hljs-type, hljs-built_in
    ("storage.type.numeric", None, Some(Type)),
    ("storage.type.primitive", None, Some(Type)),
    ("entity.other.inherited-class", None, Some(Type)),
    ("support.constant.property-value", None, None),
    ("support.type.property-name", None, Some(Variable)),
    ("support.function", None, Some(Type)),
    ("support.class", None, Some(Type)),
    ("support.type", None, Some(Type)),
    ("support.macro", None, Some(Type)),
    ("support.constant", None, Some(Type)),
    // hljs-attr, hljs-attribute, hljs-property, hljs-variable, hljs-template-variable, hljs-params
    ("entity.other.attribute-name", None, Some(Variable)),
    ("variable.parameter", None, Some(Variable)),
    ("variable.other.member", None, Some(Variable)),
    ("variable.other.property", None, Some(Variable)),
    ("variable.language", None, Some(Variable)),
    ("variable.other.readwrite", Some("source.shell"), Some(Variable)),
    ("meta.object-literal.key", None, Some(Variable)),
    // hljs-meta
    ("meta.annotation", None, Some(Meta)),
    ("meta.decorator", None, Some(Meta)),
    ("meta.function.decorator", None, Some(Meta)),
    ("meta.preprocessor", None, Some(Meta)),
    ("meta.attribute", None, Some(Meta)),
    ("meta.diff.range", None, Some(Meta)),
    ("meta.diff.header", None, Some(Comment)),
    ("meta.diff.index", None, Some(Comment)),
    // hljs-addition, hljs-deletion
    ("markup.inserted", None, Some(Addition)),
    ("markup.deleted", None, Some(Deletion)),
];

/// Whether the dotted scope `name` is `prefix` or lies under it.
fn under(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

/// The role of a token inside `stack` (outermost first): the most specific row for the
/// innermost scope any row covers.
pub(super) fn role(stack: &[Scope]) -> Option<Role> {
    let root = stack.first().map(ToString::to_string)?;
    for scope in stack.iter().rev() {
        let name = scope.to_string();
        let row = TABLE
            .iter()
            .filter(|(prefix, only, _)| {
                under(&name, prefix) && only.is_none_or(|only| under(&root, only))
            })
            .max_by_key(|(prefix, only, _)| (prefix.len(), only.is_some()));
        if let Some((_, _, role)) = row {
            return *role;
        }
    }
    None
}
