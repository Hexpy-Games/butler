//! Bun 1.3.11 Request.formData File.type for multipart parts without Content-Type.
//!
//! Values were observed with in-memory multipart Requests and checked against
//! https://github.com/oven-sh/bun/blob/bun-v1.3.11/src/http/MimeType.zig
//! This is the source App-upload-accepted subset, not a replacement MIME registry.
//! Bun extension lookup is case-sensitive; App storage owns final normalization.

pub(super) fn inferred_content_type(file_name: &str) -> Option<&'static str> {
    let extension = file_name.rsplit_once('.')?.1;
    match extension {
        "3dml" => Some("text/vnd.in3d.3dml"),
        "appcache" | "manifest" => Some("text/cache-manifest"),
        "asm" | "s" => Some("text/x-asm"),
        "c" | "cc" | "cpp" | "cxx" | "dic" | "h" | "hh" => Some("text/x-c"),
        "cjs" | "cts" | "js" | "jsx" | "mjs" | "mts" | "mtsx" | "ts" | "tsx" => {
            Some("text/javascript;charset=utf-8")
        }
        "coffee" | "litcoffee" => Some("text/coffeescript"),
        "conf" | "def" | "in" | "ini" | "list" | "log" | "text" | "txt" => {
            Some("text/plain;charset=utf-8")
        }
        "css" => Some("text/css;charset=utf-8"),
        "csv" => Some("text/csv"),
        "curl" => Some("text/vnd.curl"),
        "dcurl" => Some("text/vnd.curl.dcurl"),
        "dsc" => Some("text/prs.lines.tag"),
        "etx" => Some("text/x-setext"),
        "f" | "f77" | "f90" | "for" => Some("text/x-fortran"),
        "flx" => Some("text/vnd.fmi.flexstor"),
        "fly" => Some("text/vnd.fly"),
        "ged" => Some("text/vnd.familysearch.gedcom"),
        "gif" => Some("image/gif"),
        "gv" => Some("text/vnd.graphviz"),
        "hbs" => Some("text/x-handlebars-template"),
        "htc" => Some("text/x-component"),
        "htm" | "html" | "shtml" => Some("text/html;charset=utf-8"),
        "ics" | "ifb" => Some("text/calendar"),
        "jad" => Some("text/vnd.sun.j2me.app-descriptor"),
        "jade" => Some("text/jade"),
        "java" => Some("text/x-java-source"),
        "jpe" | "jpeg" | "jpg" => Some("image/jpeg"),
        "json" | "map" => Some("application/json;charset=utf-8"),
        "less" => Some("text/less"),
        "lua" => Some("text/x-lua"),
        "man" | "me" | "ms" | "roff" | "t" | "tr" => Some("text/troff"),
        "markdown" | "md" => Some("text/markdown"),
        "mcurl" => Some("text/vnd.curl.mcurl"),
        "mdx" => Some("text/mdx"),
        "mkd" => Some("text/x-markdown"),
        "mml" => Some("text/mathml"),
        "n3" => Some("text/n3"),
        "nfo" => Some("text/x-nfo"),
        "opml" => Some("text/x-opml"),
        "org" => Some("text/x-org"),
        "p" | "pas" => Some("text/x-pascal"),
        "pde" => Some("text/x-processing"),
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "rs" => Some("application/rls-services+xml"),
        "rtf" => Some("text/rtf"),
        "rtx" => Some("text/richtext"),
        "sass" => Some("text/x-sass"),
        "scss" => Some("text/x-scss"),
        "scurl" => Some("text/vnd.curl.scurl"),
        "sfv" => Some("text/x-sfv"),
        "sgm" | "sgml" => Some("text/sgml"),
        "sh" => Some("application/x-sh"),
        "shex" => Some("text/shex"),
        "slim" | "slm" => Some("text/slim"),
        "spdx" => Some("text/spdx"),
        "spot" => Some("text/vnd.in3d.spot"),
        "styl" | "stylus" => Some("text/stylus"),
        "sub" => Some("text/vnd.dvb.subtitle"),
        "toml" => Some("application/toml"),
        "yaml" | "yml" => Some("text/yaml"),
        "tsv" => Some("text/tab-separated-values"),
        "ttl" => Some("text/turtle"),
        "uri" | "uris" | "urls" => Some("text/uri-list"),
        "uu" => Some("text/x-uuencode"),
        "vcard" => Some("text/vcard"),
        "vcf" => Some("text/x-vcard"),
        "vcs" => Some("text/x-vcalendar"),
        "vtt" => Some("text/vtt"),
        "webp" => Some("image/webp"),
        "wml" => Some("text/vnd.wap.wml"),
        "wmls" => Some("text/vnd.wap.wmlscript"),
        "xml" => Some("application/xml"),
        "ymp" => Some("text/x-suse-ymp"),
        _ => None,
    }
}
