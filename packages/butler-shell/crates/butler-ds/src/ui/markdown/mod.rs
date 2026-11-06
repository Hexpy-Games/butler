//! The markdown engine of the chat blocks: GFM parsing and code highlighting.
//!
//! # Parsing
//! `pulldown-cmark` 0.13 with tables, strikethrough and task lists (`remark-gfm`), `~text~` left
//! as text (`singleTilde: false`), footnotes off. What it lacks, [`parse`] adds: the GFM literal
//! autolinks (`https://`, `http://`, `www.` and e-mail addresses, with the trailing-punctuation
//! and unbalanced-parenthesis rules) and `remarkPunctuationBoldSuffix.ts` (`**text.**word` is
//! bold). Raw HTML renders as text, as react-markdown does without `rehype-raw`.
//!
//! # Highlighting
//! `syntect` 5.3 with `default-fancy` (the pure-Rust `fancy-regex` engine). Only the grammars
//! `syntaxHighlighter.ts` registers with lowlight resolve, under the same names and aliases:
//! bash (sh, zsh, shell, console), css, diff (patch), go, javascript (js, jsx, mjs, cjs), json,
//! markdown (md), python (py), rust (rs), typescript (ts, tsx, mts, cts), xml (html, svg ...)
//! and yaml (yml). syntect's bundled set has no TypeScript: it reads as its JavaScript syntax
//! plus the words only TypeScript has (`interface`, `enum`, `readonly`, `type Id`, the
//! primitive type names).
//!
//! # Scope to token
//! `useSyntaxHighlight.tsx` maps the first `hljs-*` class of a span to a role; a token takes the
//! role of the most specific row covering the innermost scope of its scope stack that any row
//! covers (a row with no role leaves the token plain, as hljs leaves operators). The rows
//! restate the hljs mapping for TextMate scopes:
//!
//! | `--syntax-*` | hljs classes | scopes (prefixes) |
//! | --- | --- | --- |
//! | `keyword` | keyword, doctag, tag, name, selector-tag, bullet | `keyword`, `storage` (except `storage.type.numeric/primitive`, `storage.modifier.lifetime`), `entity.name.tag`, `punctuation.definition.tag`, `punctuation.definition.list`, YAML `punctuation.definition.block.sequence` |
//! | `string` | string, regexp, template-tag | `string`, `constant.character.escape` |
//! | `comment` | comment, quote | `comment`, `markup.quote`, `meta.diff.header`, `meta.diff.index` |
//! | `number` | number, literal, symbol | `constant.numeric`, `constant.language`, `constant.other.symbol`, `keyword.other.unit`, `storage.modifier.lifetime` |
//! | `title` | title, section, selector-class, selector-id | `entity.name.function/class/type/section`, `variable.function`, `markup.heading`, `entity.other.attribute-name.class/id` |
//! | `type` | type, built_in | `storage.type.numeric/primitive`, `entity.other.inherited-class`, `support.function/class/type/macro/constant` |
//! | `variable` | attr, attribute, property, variable, template-variable, params | `entity.other.attribute-name`, `support.type.property-name`, `variable.parameter/language`, `variable.other.member/property`, `meta.object-literal.key`, shell `variable.other.readwrite`, YAML `entity.name.tag` |
//! | `meta` | meta | `meta.annotation/decorator/preprocessor/attribute`, `meta.function.decorator`, `meta.diff.range` |
//! | `addition` | addition | `markup.inserted` |
//! | `deletion` | deletion | `markup.deleted` |
//!
//! Plain: `keyword.operator`, CSS pseudo-classes and property values, everything no row covers.
//! The binary carries syntect's whole bundled set (about forty grammars); the rows above are the
//! only ones reachable. gpui draws the roles through `--syntax-*` tokens, so a theme change
//! recolours without re-highlighting.
mod highlight;
mod model;
mod parse;
mod scopes;
mod text;

pub use highlight::{Token, highlight, registered};
pub use model::{Align, Block, Inline, Item, Style, Table, plain};
pub use parse::parse;
pub use scopes::Role;
