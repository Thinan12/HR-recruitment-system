'use strict';
// Light / dark theme for every LALCO page. Loaded in <head> so the theme is set
// before the page is drawn (no flash). The choice is remembered on this device;
// until one is made, the device's own light / dark setting is followed.
// A switch button is placed in every element marked data-theme-slot.
(function () {
  var KEY = 'lalco_theme';
  var root = document.documentElement;
  function saved() {
    try { var v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; }
  }
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function system() { return media && media.matches ? 'dark' : 'light'; }
  function apply(theme) { root.setAttribute('data-theme', theme); }
  function current() { return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  apply(saved() || system());
  if (media && media.addEventListener) media.addEventListener('change', function () { if (!saved()) { apply(system()); refresh(); } });

  function label(b) {
    var dark = current() === 'dark';
    b.textContent = dark ? '☀' : '☾'; // sun / moon
    b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
  function refresh() { var all = document.querySelectorAll('.theme-toggle'); for (var i = 0; i < all.length; i++) label(all[i]); }
  function button() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-toggle';
    label(b);
    b.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* not remembered, still switched */ }
      refresh();
    });
    return b;
  }
  function place() {
    var slots = document.querySelectorAll('[data-theme-slot]');
    for (var i = 0; i < slots.length; i++) if (!slots[i].querySelector('.theme-toggle')) slots[i].appendChild(button());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place); else place();
}());
