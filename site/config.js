/**
 * Edit these before publishing (or set via your fork).
 * APP_URL = your Vercel SessionVault deployment.
 * GITHUB_URL = this repository.
 */
window.SESSIONVAULT_SITE = {
  APP_URL: "https://YOUR_APP.vercel.app",
  GITHUB_URL: "https://github.com/saiphanindra1010/sessionvault",
};

(function () {
  var cfg = window.SESSIONVAULT_SITE || {};
  var app = (cfg.APP_URL || "").replace(/\/+$/, "");
  var gh = cfg.GITHUB_URL || "https://github.com/saiphanindra1010/sessionvault";

  function setHref(id, href) {
    var el = document.getElementById(id);
    if (el && href) el.setAttribute("href", href);
  }

  setHref("app-link-2", app ? app + "/login" : "#");
  setHref("github-link", gh);
  setHref("github-link-2", gh);

  var pre = document.getElementById("mcp-snippet");
  if (pre && app) {
    pre.textContent =
      '{\n  "mcpServers": {\n    "sessionvault": {\n      "url": "' +
      app +
      '/api/mcp",\n      "headers": {\n        "Authorization": "Bearer sv_live_YOUR_KEY"\n      }\n    }\n  }\n}';
  }
})();
