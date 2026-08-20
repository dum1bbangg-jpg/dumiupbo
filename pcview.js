/* PC view for in-app browsers (?pc=1).

   The SOOP app webview cannot render nested iframes and resets its own zoom, so
   neither a wrapper page nor a wide viewport works there. Instead:
     1. drop every mobile media rule from our own stylesheets, so desktop rules win
     2. lay the document out at DESIGN px
     3. shrink it with a CSS transform, which no webview zoom reset can undo

   Load order: right after the stylesheet, before the page scripts. */

(function () {
  var DESIGN = 1180;
  if (location.search.indexOf("pc=1") === -1) return;

  document.documentElement.setAttribute("data-pc", "1");

  var viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.setAttribute("content", "width=device-width, initial-scale=1");

  function stripMobileRules(sheet) {
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return; }   /* cross-origin sheet */
    if (!rules) return;
    for (var i = rules.length - 1; i >= 0; i--) {
      var rule = rules[i];
      if (rule.type !== 4) continue;                        /* CSSMediaRule */
      var text = rule.conditionText || (rule.media && rule.media.mediaText) || "";
      var match = /max-width:\s*(\d+)px/.exec(text);
      if (match && parseInt(match[1], 10) <= DESIGN) {
        try { sheet.deleteRule(i); } catch (e) {}
      }
    }
  }

  /* vw/vh do not follow the transform, and a few containers are sized that way.
     Restate them in DESIGN px. */
  function injectOverrides() {
    if (document.getElementById("pcview-css")) return;
    if (!document.head) return;
    /* The sidebar stays sticky: sticky works fine under a transform, and taking
       it out of flow would collapse the shell grid. Only vw/vh-sized boxes and
       position:fixed need restating. */
    var css =
      "body.pcview .site-shell { width: 1180px; }" +
      "body.pcview .sidebar { height: 100vh; }" +
      "body.pcview .hero { height: 250px; }" +
      "body.pcview .hero-title { width: 460px; }" +
      "body.pcview .hero-title h1 { font-size: 42px; }" +
      "body.pcview .hero-title p { font-size: 15px; }" +
      "body.pcview .detail-drawer, body.pcview .viewer-modal { width: 440px; }" +
      "body.pcview .drawer-backdrop { position: absolute; left: 0; width: 1180px; }" +
      "body.pcview .open-full { display: none; }";
    var style = document.createElement("style");
    style.id = "pcview-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* Capture the width before the body is widened: once the document overflows,
     mobile browsers grow the layout viewport, and reading innerWidth again feeds
     that growth back into the scale (measured 1089 instead of 375, so almost no
     shrink at all). */
  var BASE = (function () {
    var screenWidth = (window.screen && window.screen.width) || 0;
    var innerWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (screenWidth && innerWidth) return Math.min(screenWidth, innerWidth);
    return screenWidth || innerWidth || DESIGN;
  })();

  function scale() { return BASE / DESIGN; }

  /* transform, not zoom: some in-app webviews ignore `zoom` entirely */
  function place() {
    if (!document.body) return;
    var ratio = scale();
    document.documentElement.style.overflowX = "hidden";
    document.documentElement.style.width = BASE + "px";
    document.body.style.width = DESIGN + "px";
    document.body.style.transformOrigin = "0 0";
    document.body.style.transform = "scale(" + ratio + ")";
    sizeDocument();
  }

  /* The transform is visual only, so the document keeps its unscaled height. */
  function sizeDocument() {
    if (!document.body) return;
    var ratio = scale();
    var anchor = document.querySelector(".site-footer") || document.querySelector(".site-shell");
    var height = anchor
      ? Math.ceil(anchor.getBoundingClientRect().bottom / ratio + window.scrollY / ratio)
      : document.body.scrollHeight;
    document.documentElement.style.height = Math.ceil(height * ratio) + "px";
  }

  function apply() {
    injectOverrides();
    for (var i = 0; i < document.styleSheets.length; i++) stripMobileRules(document.styleSheets[i]);
    if (document.body) document.body.classList.add("pcview");
    place();
  }

  apply();
  document.addEventListener("DOMContentLoaded", apply);
  window.addEventListener("load", function () {
    apply();
    [300, 900, 2000].forEach(function (delay) { setTimeout(sizeDocument, delay); });
    if (window.ResizeObserver && document.body) new ResizeObserver(sizeDocument).observe(document.body);
  });
  window.addEventListener("resize", function () {
    var screenWidth = (window.screen && window.screen.width) || 0;
    if (screenWidth) BASE = screenWidth;                    /* orientation change only */
    place();
  });
})();
