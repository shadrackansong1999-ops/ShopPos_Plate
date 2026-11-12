/* Theme boot: runs in <head> before first paint so there is no flash of the
   wrong colours. Add a theme by adding a [data-theme="id"] block in style.css
   and one line here. Saved choices from the old theme names (midnight,
   daylight...) are ignored and fall back to the default. */
(function () {
  var KEY = "shoppos_theme";
  var DEFAULT_LIGHT = "bangladesh", DEFAULT_DARK = "firefly";
  var THEMES = [
    { id: "sage", name: "Soft Sage", mode: "dark" },
    { id: "lime", name: "Fresh Lime", mode: "dark" },
    { id: "desert", name: "Desert Sand", mode: "dark" },
    { id: "violet", name: "Russian Violet", mode: "dark" },
    { id: "firefly", name: "Firefly", mode: "dark" },
    { id: "lava", name: "Liquid Lava", mode: "dark" },
    { id: "latte", name: "Vanilla Latte", mode: "light" },
    { id: "puce", name: "Dark Puce", mode: "light" },
    { id: "bangladesh", name: "Bangladesh Green", mode: "light" },
    { id: "red", name: "Blood Orange", mode: "light" },
    { id: "blue", name: "College Blue", mode: "light" },
    { id: "emerald", name: "Emerald", mode: "light" },
    { id: "wine", name: "Wine", mode: "light" },
    { id: "rose", name: "French Rose", mode: "light" },
    { id: "hunter", name: "Hunter Green", mode: "light" },
    { id: "mustard", name: "Dark Mustard", mode: "light" },
    { id: "pearl", name: "Pearl Bush", mode: "light" },
    { id: "cherry", name: "Cherry Crush", mode: "light" },
    { id: "ocean", name: "Ocean Blue", mode: "light" }
  ];

  function valid(id) { return THEMES.some(function (t) { return t.id === id; }); }
  function initial() {
    try { var s = localStorage.getItem(KEY); if (valid(s)) return s; } catch (e) {}
    var dark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
    return dark ? DEFAULT_DARK : DEFAULT_LIGHT;
  }
  function apply(id, save) {
    var root = document.documentElement;
    root.setAttribute("data-theme", id);
    var meta = document.getElementById("theme-color-meta");
    if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--ground").trim());
    if (save) { try { localStorage.setItem(KEY, id); } catch (e) {} }
    document.dispatchEvent(new CustomEvent("themechange", { detail: id }));
  }
  window.ShopTheme = {
    list: THEMES,
    get: function () { return document.documentElement.getAttribute("data-theme") || initial(); },
    name: function (id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i].name; return id; },
    set: function (id) { if (valid(id)) apply(id, true); }
  };
  apply(initial(), false);
})();
