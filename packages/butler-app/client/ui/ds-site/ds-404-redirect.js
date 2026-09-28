/*
 * Butler DS site 404 redirect helper.
 *
 * The DS Viewer keeps every route in query params, so a path-style link such as
 * <base>components/Button#variants maps onto <base>?page=components%2FButton#variants.
 * The build replaces the base placeholder with DS_SITE_BASE and emits this file as
 * <base>ds-404-redirect.js; a host's 404 page includes it with a plain <script src>.
 * It only acts on paths under its own base, so a combined site's single 404.html can
 * include it unconditionally. Exposes window.butlerDsSite.{base, redirectTarget, redirect}.
 */
(function (window) {
  var BASE = "__DS_SITE_BASE__";

  function redirectTarget(base, pathname, search, hash) {
    var root = base.replace(/\/+$/, "");
    if (pathname !== root && pathname.indexOf(root + "/") !== 0) return null;
    var page = pathname.slice(root.length).replace(/^\/+|\/+$/g, "");
    var query = page ? "page=" + encodeURIComponent(page) : "";
    var rest = (search || "").replace(/^\?/, "");
    if (rest) query = query ? query + "&" + rest : rest;
    return base + (query ? "?" + query : "") + (hash || "");
  }

  function redirect() {
    var location = window.location;
    var next = redirectTarget(BASE, location.pathname, location.search, location.hash);
    if (next === null || next === location.pathname + location.search + location.hash) return false;
    location.replace(next);
    return true;
  }

  window.butlerDsSite = { base: BASE, redirectTarget: redirectTarget, redirect: redirect };
  redirect();
})(window);
