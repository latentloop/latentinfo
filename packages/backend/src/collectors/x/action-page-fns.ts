// @ts-nocheck
/**
 * X collector action — page-side functions.
 *
 * These functions are serialized via .toString() and injected into the browser
 * page context via installModule() and page.evaluate(). They reference browser
 * globals (window, document, DOM types) that don't exist in Node.js — hence
 * @ts-nocheck.
 *
 * Two categories:
 *   1. Panel UI functions (installModule as "x_action"):
 *      __xActionInitSkipBtn, __xActionInitPanel
 *   2. Page logic (injected via page.evaluate):
 *      injectActionLogic() — keyboard handler, scroll, focus dot, addBadges patch
 *
 * Ported from latent_webext_apps/x_x/action.js.
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import type { PageProxy } from "../../collector-runner.js"
import { chooseDownNavigationTarget, chooseViewportFocusIndex } from "./action-navigation.js"

// ---------------------------------------------------------------------------
// Panel UI functions — serialized via installModule("x_action", { ... })
// All names use __xAction prefix to avoid window global collisions.
// ---------------------------------------------------------------------------

/**
 * __xActionInitSkipBtn — create the skip/pause toggle button.
 * Reads/writes localStorage for persistence across sessions.
 */
export function __xActionInitSkipBtn() {
  var LS_KEY = "latent_action_settings"
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {} } catch(e) { return {} }
  }
  function saveSettings(patch) {
    try {
      var s = loadSettings()
      for (var k in patch) s[k] = patch[k]
      localStorage.setItem(LS_KEY, JSON.stringify(s))
    } catch(e) {}
  }
  var settings = loadSettings()

  var btn = document.createElement("button")
  btn.id = "latent-skip-btn"
  btn.title = "Skip to next unseen tweet (\u2193 arrow)"
  btn.style.cssText = "border:none;cursor:pointer;font-size:13px;padding:4px 8px;border-radius:6px;display:flex;align-items:center;gap:4px;transition:background 0.15s,color 0.15s"
  var skipOn = settings.skipEnabled !== false // default on
  function applyState(on) {
    btn.setAttribute("data-on", on ? "1" : "0")
    btn.style.background = on ? "rgba(88,166,255,0.25)" : "rgba(255,255,255,0.06)"
    btn.style.color = on ? "#58a6ff" : "#6e7681"
    var freshLabel = window.__latentFreshLabel || ""
    btn.innerHTML = '<span style="font-size:14px">' + (on ? "\u2B07" : "\u23F8") + '</span><span style="font-size:11px">skip' + (freshLabel ? " (" + freshLabel + ")" : "") + '</span>'
  }
  applyState(skipOn)
  btn.onclick = function () {
    skipOn = !skipOn
    applyState(skipOn)
    saveSettings({ skipEnabled: skipOn })
  }
  return btn
}

/**
 * __xActionInitPanel — orchestrator: populate the X section in the shared panel.
 * Receives { sectionId: string }, queries DOM for the section container,
 * appends skip button + gear + popup.
 */
export function __xActionInitPanel(opts) {
  var sectionId = opts && opts.sectionId
  if (!sectionId) return
  var section = document.querySelector('[data-section="' + sectionId + '"]')
  if (!section) return

  // Guard: skip if already populated (SPA re-injection)
  if (section.querySelector("#latent-skip-btn")) return

  // Skip button
  var btn = __xActionInitSkipBtn()
  section.appendChild(btn)
}

// ---------------------------------------------------------------------------
// Page logic — injected via page.evaluate() as raw JS strings.
// Sets window globals that can't be serialized via installModule.
// ---------------------------------------------------------------------------

/**
 * injectActionLogic — inject keyboard handler, scroll logic, focus dot,
 * and addBadges timestamp patch into the page.
 *
 * Called by the X collector's actionHandler entry point.
 */
export async function injectActionLogic(page: PageProxy, logLevel: string, freshMinutes?: number): Promise<void> {
  // 1. Inject log helper (logs to both browser console and backend via __latentNotify)
  await page.evaluate(`(function() {
    var LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
    window.__latentLogLevel = ${JSON.stringify(logLevel)};
    window.__llog = function(level, msg) {
      var threshold = window.__latentLogLevel in LEVELS ? LEVELS[window.__latentLogLevel] : 3;
      var num = level in LEVELS ? LEVELS[level] : 2;
      if (num >= threshold) {
        console.log("[latent] " + msg);
        try { if (window.__latentInfoNotify) window.__latentInfoNotify("log:" + level + ":" + msg); } catch(e) {}
      }
    };
  })()`)

  // 2. Inject skip handler + scroll logic + focus dot
  await page.evaluate(`(function() {
    var L = window.__llog;
    var chooseDownNavigationTarget = ${chooseDownNavigationTarget.toString()};
    var chooseViewportFocusIndex = ${chooseViewportFocusIndex.toString()};
    L("info", "installing skip handler...");

    // SPA cleanup: remove previous handler if re-injected (pushState navigation)
    if (window.__latentKeyHandler) {
      window.removeEventListener("keydown", window.__latentKeyHandler, true);
      L("debug", "removed old handler");
    }
    if (window.__latentScrollFocusHandler) {
      window.removeEventListener("scroll", window.__latentScrollFocusHandler);
      L("debug", "removed old scroll focus handler");
    }
    if (window.__latentUrlChangeHandler) {
      window.removeEventListener("popstate", window.__latentUrlChangeHandler);
      L("debug", "removed old URL change handler");
    }

    var FRESH_MS = ${Math.round((freshMinutes ?? 0.5) * 60000)};
    var collectAt = window.__latentCollectAt || {};
    window.__latentCollectAt = collectAt;

    // --- Navigation state (single source of truth) ---
    var navState = {
      cursor: null,          // { element, pathname } or null
      history: [],           // Array of { element, pathname }
      historyIndex: -1,      // -1 if empty
      animating: false,      // true during smooth scroll
      pendingDelta: 0        // coalesced keypress counter
    };
    var MAX_HISTORY = 50;
    var MAX_PENDING = 10;
    var STALE_CONTEXT_MULT = 3;   // viewport heights
    var SCROLL_SKIP_MULT = 3;     // viewport heights: skip-focus ceiling & scroll distance
    var lastUrl = location.href;

    // --- Utilities ---
    function gaussRandom(m, s) {
      var u = 0, v = 0;
      while (!u) u = Math.random();
      while (!v) v = Math.random();
      return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    function getTweetPathname(art) {
      var timeEl = art.querySelector("time");
      if (timeEl) {
        var a = timeEl.closest("a");
        if (a) {
          var href = a.getAttribute("href");
          if (href && href.charAt(0) === "/") return href;
        }
      }
      return null;
    }

    function isUnseenPath(path, article) {
      if (!path) return false;  // no permalink = ad/promoted tweet, skip during navigation
      var ts = collectAt[path];
      if (!ts) {
        // Map miss — check DOM for a badge (handles race where initial scrape
        // ran before the addBadges patch was installed).
        if (article && article.querySelector(".li-scrape-badge")) {
          L("trace", "isUnseen " + path + " map-miss but badge present => false");
          return false;
        }
        return true;  // not collected yet → unseen, don't skip
      }
      var age = Date.now() - ts;
      var unseen = age < FRESH_MS;
      L("trace", "isUnseen " + path + " age=" + Math.round(age / 1000) + "s fresh=" + Math.round(FRESH_MS / 1000) + "s => " + unseen);
      return unseen;
    }

    function showFocus(art) {
      var existing = document.querySelector(".latent-focus-dot");
      if (!art) {
        if (existing) existing.remove();
        return;
      }
      var avatar = art.querySelector('[data-testid="Tweet-User-Avatar"]');
      if (!avatar) { if (existing) existing.remove(); return; }
      if (existing && existing.parentElement === avatar) return;
      if (existing) existing.remove();
      var dot = document.createElement("div");
      dot.className = "latent-focus-dot";
      avatar.appendChild(dot);
    }

    // --- Cursor + history helpers ---
    function setCursor(element) {
      if (!element) {
        navState.cursor = null;
        showFocus(null);
        return;
      }
      navState.cursor = { element: element, pathname: getTweetPathname(element) };
      showFocus(element);
    }

    function resolveElement(entry) {
      if (!entry) return null;
      if (entry.element && entry.element.isConnected) return entry.element;
      if (!entry.pathname) return null;
      var arts = document.querySelectorAll('article[data-testid="tweet"]');
      for (var i = 0; i < arts.length; i++) {
        if (getTweetPathname(arts[i]) === entry.pathname) return arts[i];
      }
      return null;
    }

    function pushToHistory(element) {
      // Truncate forward history (if user was mid-history, new Down overwrites forward)
      if (navState.historyIndex < navState.history.length - 1) {
        navState.history = navState.history.slice(0, navState.historyIndex + 1);
      }
      navState.history.push({ element: element, pathname: getTweetPathname(element) });
      if (navState.history.length > MAX_HISTORY) {
        navState.history.shift();
      } else {
        navState.historyIndex++;
      }
    }

    function resetNavState() {
      navState.cursor = null;
      navState.history = [];
      navState.historyIndex = -1;
      navState.pendingDelta = 0;
      navState.animating = false;
      showFocus(null);
      // Deferred cleanup: Twitter may restore cached DOM (with stale dot) asynchronously
      // after popstate fires. Re-check after one frame to catch restored dots.
      requestAnimationFrame(function() {
        // Only remove if no new cursor was set in the meantime
        if (!navState.cursor) showFocus(null);
      });
      L("debug", "navState reset");
    }

    // --- Navigation primitives ---
    function findPreviousTweetInDOM(cursorEl) {
      var arts = document.querySelectorAll('article[data-testid="tweet"]');
      if (!cursorEl) {
        // No cursor — pick the tweet just above viewport center, or first visible above
        var anchor = window.innerHeight * 0.2;
        var best = null, bestTop = -Infinity;
        for (var i = 0; i < arts.length; i++) {
          try {
            var rect = arts[i].getBoundingClientRect();
            if (rect.top >= anchor) continue;
            if (rect.top > bestTop) { bestTop = rect.top; best = arts[i]; }
          } catch(e) {}
        }
        return best;
      }
      var prev = null;
      for (var j = 0; j < arts.length; j++) {
        if (arts[j] === cursorEl) return prev;
        prev = arts[j];
      }
      return null;
    }

    function collectDownNavigationCandidates(cursorEl) {
      var arts = document.querySelectorAll('article[data-testid="tweet"]');
      var candidates = [];
      for (var i = 0; i < arts.length; i++) {
        try {
          var art = arts[i];
          var rect = art.getBoundingClientRect();
          var path = getTweetPathname(art);
          candidates.push({
            top: rect.top,
            bottom: rect.bottom,
            isCursor: !!cursorEl && art === cursorEl,
            isValid: !!path,
            isUnseen: isUnseenPath(path, art),
            element: art
          });
        } catch(e) {}
      }
      return candidates;
    }

    function focusViewportTweet() {
      var candidates = collectDownNavigationCandidates(navState.cursor ? navState.cursor.element : null);
      var index = chooseViewportFocusIndex(candidates, {
        viewportHeight: window.innerHeight
      });
      if (index === -1) return false;
      var target = candidates[index] && candidates[index].element;
      if (!target) return false;
      setCursor(target);
      return true;
    }

    function scrollViewportAndFocus() {
      var el = document.scrollingElement || document.documentElement;
      smoothScroll(el.scrollTop + window.innerHeight * SCROLL_SKIP_MULT, function() {
        if (!focusViewportTweet()) {
          L("debug", "scrollViewportAndFocus: no tweet visible after scroll");
        }
      });
    }

    // --- Smooth scroll ---
    function smoothScroll(targetY, cb) {
      if (navState.animating) { L("debug", "smoothScroll: already animating, skipped"); return; }
      navState.animating = true;
      var el = document.scrollingElement || document.documentElement;
      var startY = el.scrollTop, dist = targetY - startY;
      if (Math.abs(dist) < 5) {
        navState.animating = false;
        if (cb) cb();
        drainPendingDelta();
        return;
      }
      var dur = Math.min(900, Math.max(400, Math.abs(dist) * 0.35)) + gaussRandom(0, 40);
      var t0 = performance.now(), lastY = startY;
      function ease(t) { return 1 - Math.pow(1 - t, 3); }
      function step() {
        try {
          var p = Math.min(1, (performance.now() - t0) / dur);
          var y = startY + dist * ease(p), d = y - lastY;
          if (Math.abs(d) > 0.3) {
            try { el.dispatchEvent(new WheelEvent("wheel", { deltaY: d + gaussRandom(0, 2), deltaX: gaussRandom(0, 0.2), deltaMode: 0, bubbles: true })); } catch(e) {}
            el.scrollTop = lastY + d;
            lastY += d;
          }
          if (p < 1) requestAnimationFrame(step);
          else {
            navState.animating = false;
            if (cb) cb();
            drainPendingDelta();
          }
        } catch(e) {
          navState.animating = false;
          if (cb) cb();
          drainPendingDelta();
        }
      }
      requestAnimationFrame(step);
    }

    function animateTo(element, onArrive) {
      var el = document.scrollingElement || document.documentElement;
      var rect = element.getBoundingClientRect();
      var offset = Math.floor(window.innerHeight * 0.2);
      var targetY = Math.max(0, el.scrollTop + rect.top - offset);
      L("trace", "animateTo rect.top=" + Math.round(rect.top) + " targetY=" + Math.round(targetY));
      smoothScroll(targetY, onArrive);
    }

    // --- Coalesce drain ---
    function drainPendingDelta() {
      if (navState.pendingDelta === 0) return;
      // If cursor was cleared (reset), drop pending
      if (navState.cursor === null && navState.pendingDelta !== 0) {
        var maybeStillValid = navState.history.length > 0 || navState.pendingDelta > 0;
        if (!maybeStillValid) { navState.pendingDelta = 0; return; }
      }
      if (navState.pendingDelta > 0) {
        navState.pendingDelta--;
        executeDown();
      } else {
        navState.pendingDelta++;
        executeUp();
      }
    }

    // --- Navigation commands ---
    function describeCursor() {
      if (!navState.cursor) return "none";
      var p = navState.cursor.pathname || "?";
      var el = navState.cursor.element;
      var badge = el ? !!el.querySelector(".li-scrape-badge") : false;
      var ts = collectAt[p];
      return p + " badge=" + badge + " collectedAt=" + (ts ? new Date(ts).toISOString() : "none");
    }

    function describeCandidates(candidates) {
      var parts = [];
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var path = "?";
        try { path = getTweetPathname(c.element) || "no-path"; } catch(e) {}
        parts.push("#" + i + " " + path + " top=" + Math.round(c.top) + " cur=" + c.isCursor + " unseen=" + c.isUnseen);
      }
      return parts.join(" | ");
    }

    function executeDown() {
      L("trace", "▼ DOWN before=" + describeCursor());

      var cursorEl = navState.cursor ? navState.cursor.element : null;
      if (cursorEl && !cursorEl.isConnected && navState.cursor) {
        cursorEl = resolveElement(navState.cursor);
        L("trace", "▼ DOWN resolved disconnected cursor → " + (cursorEl ? "found" : "null"));
      }
      var candidates = collectDownNavigationCandidates(cursorEl);
      L("trace", "▼ DOWN candidates(" + candidates.length + "): " + describeCandidates(candidates));

      var decision = chooseDownNavigationTarget(candidates, {
        viewportHeight: window.innerHeight,
        maxSkipDistanceMultiplier: SCROLL_SKIP_MULT
      });
      L("trace", "▼ DOWN decision=" + decision.action + " reason=" + (decision.reason || "n/a") + " index=" + (decision.index !== undefined ? decision.index : "n/a"));

      if (decision.action === "focus-target" || decision.action === "focus-viewport") {
        var el = candidates[decision.index] && candidates[decision.index].element;
        if (el) {
          if (decision.action === "focus-viewport") {
            L("trace", "cursor is outside the viewport, re-focusing a visible tweet");
            setCursor(el);
          } else {
            setCursor(el);
            animateTo(el, null);
          }
          L("trace", "▼ DOWN after=" + describeCursor());
          return true;
        }
      }
      L("trace", decision.reason === "next-unseen-too-far"
        ? "next unseen valid tweet is too far away, scrolling " + SCROLL_SKIP_MULT + "vh"
        : "no nearby unseen valid tweet, scrolling " + SCROLL_SKIP_MULT + "vh");
      scrollViewportAndFocus();
      L("trace", "▼ DOWN after=" + describeCursor());
      return true;
    }

    function executeUp() {
      // Simple move: go to the tweet directly above the current cursor (no skip, no filter)
      var cursorEl = navState.cursor ? navState.cursor.element : null;
      if (cursorEl && !cursorEl.isConnected && navState.cursor) {
        cursorEl = resolveElement(navState.cursor);
      }
      var prev = findPreviousTweetInDOM(cursorEl);
      if (prev) {
        setCursor(prev);
        animateTo(prev, null);
        return;
      }
      // Last resort: large scroll up
      var scrollEl = document.scrollingElement || document.documentElement;
      L("info", "no previous tweet, large scroll up");
      smoothScroll(Math.max(scrollEl.scrollTop - window.innerHeight * 2, 0), null);

      // --- History-based Up (commented out for future re-enable) ---
      // // Walk back through history (unfiltered)
      // while (navState.historyIndex > 0) {
      //   navState.historyIndex--;
      //   var entry = navState.history[navState.historyIndex];
      //   var el = resolveElement(entry);
      //   if (el) {
      //     navState.cursor = { element: el, pathname: entry.pathname };
      //     showFocus(el);
      //     animateTo(el, null);
      //     return;
      //   }
      //   L("debug", "history entry unresolvable at index " + navState.historyIndex + ", skipping");
      // }
      // // Fall back to DOM-previous when history exhausted
      // var prev2 = findPreviousTweetInDOM(cursorEl);
      // if (prev2) {
      //   navState.history.unshift({ element: prev2, pathname: getTweetPathname(prev2) });
      //   if (navState.history.length > MAX_HISTORY) navState.history.pop();
      //   navState.historyIndex = 0;
      //   setCursor(prev2);
      //   animateTo(prev2, null);
      //   return;
      // }
    }

    // --- Scroll listener: detachment + stale-context detection ---
    var __scrollFocusFn = function() {
      if (navState.animating) return;
      if (!navState.cursor) return;
      // Detachment check — try re-resolve by pathname
      if (!navState.cursor.element || !navState.cursor.element.isConnected) {
        var re = resolveElement(navState.cursor);
        if (re) {
          navState.cursor.element = re;
          showFocus(re);
        } else {
          L("debug", "cursor element detached and unresolvable, resetting");
          resetNavState();
        }
        return;
      }
      // Stale-context check — cursor scrolled too far from viewport
      var r = navState.cursor.element.getBoundingClientRect();
      var vh = window.innerHeight;
      if (r.bottom < -STALE_CONTEXT_MULT * vh || r.top > (STALE_CONTEXT_MULT + 1) * vh) {
        L("debug", "cursor beyond stale-context threshold, resetting");
        resetNavState();
      }
    };
    window.__latentScrollFocusHandler = __scrollFocusFn;
    var __tracker = window.__latent && window.__latent.__tracker;
    if (__tracker) {
      __tracker.addListener("x", window, "scroll", window.__latentScrollFocusHandler, { passive: true });
    } else {
      // tracker-bypass: __resources install failed — fallback is best-effort; listener leaks on reattach but collector is degraded anyway
      window.addEventListener("scroll", window.__latentScrollFocusHandler, { passive: true });
    }

    // --- URL change detection ---
    function onUrlMaybeChanged() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        resetNavState();
        L("debug", "URL changed, navState reset");
      }
    }
    window.__latentUrlChangeHandler = onUrlMaybeChanged;
    window.__latentOnUrlMaybeChanged = onUrlMaybeChanged;
    if (__tracker) {
      __tracker.addListener("x", window, "popstate", window.__latentUrlChangeHandler);
    } else {
      // tracker-bypass: __resources install failed — see scroll-handler note above
      window.addEventListener("popstate", window.__latentUrlChangeHandler);
    }
    try {
      if (!history.pushState.__latentPatched) {
        var origPush = history.pushState;
        history.pushState = function() {
          var ret = origPush.apply(this, arguments);
          // tracker-bypass: single-fire 0ms inside persistent history monkey-patch; __latentOnUrlMaybeChanged is stubbed to noop on reattach (collector-runner)
          setTimeout(function() {
            if (window.__latentOnUrlMaybeChanged) window.__latentOnUrlMaybeChanged();
          }, 0);
          return ret;
        };
        history.pushState.__latentPatched = true;
      }
      if (!history.replaceState.__latentPatched) {
        var origReplace = history.replaceState;
        history.replaceState = function() {
          var ret = origReplace.apply(this, arguments);
          // tracker-bypass: single-fire 0ms inside persistent history monkey-patch; __latentOnUrlMaybeChanged is stubbed to noop on reattach (collector-runner)
          setTimeout(function() {
            if (window.__latentOnUrlMaybeChanged) window.__latentOnUrlMaybeChanged();
          }, 0);
          return ret;
        };
        history.replaceState.__latentPatched = true;
      }
    } catch(e) { L("warn", "history patching failed: " + e); }

    // --- Enable/typing checks ---
    function isEnabled() {
      var btn = document.getElementById("latent-skip-btn");
      return !btn || btn.getAttribute("data-on") !== "0";
    }

    function isTyping() {
      var a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return true;
      return !!document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]');
    }

    // --- Fresh label (unchanged) ---
    function formatFreshLabel(ms) {
      var sec = Math.round(ms / 1000);
      if (sec < 60) return sec + "s";
      var min = Math.round(sec / 6) / 10;
      return min + "m";
    }
    window.__latentFreshLabel = formatFreshLabel(FRESH_MS);
    window.__latentSetFreshMs = function(ms) {
      FRESH_MS = ms;
      window.__latentFreshLabel = formatFreshLabel(ms);
      L("debug", "FRESH_MS set to " + ms + "ms");
      var btn = document.getElementById("latent-skip-btn");
      if (btn) {
        var on = btn.getAttribute("data-on") !== "0";
        var icon = on ? "\u2B07" : "\u23F8";
        btn.innerHTML = '<span style="font-size:14px">' + icon + '</span><span style="font-size:11px">skip (' + window.__latentFreshLabel + ')</span>';
      }
    };
    window.__latentSetLogLevel = function(level) {
      window.__latentLogLevel = level;
      L("debug", "logLevel set to " + level);
    };

    // --- Keyboard handler with coalesce ---
    window.__latentKeyHandler = function(e) {
      if (!isEnabled() || isTyping()) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      var delta = e.key === "ArrowDown" ? 1 : -1;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (navState.animating) {
        // Coalesce: accumulate net direction, replay on animation end
        navState.pendingDelta += delta;
        if (navState.pendingDelta > MAX_PENDING) navState.pendingDelta = MAX_PENDING;
        if (navState.pendingDelta < -MAX_PENDING) navState.pendingDelta = -MAX_PENDING;
        return;
      }
      if (delta > 0) executeDown();
      else executeUp();
    };
    if (__tracker) {
      __tracker.addListener("x", window, "keydown", window.__latentKeyHandler, { capture: true });
    } else {
      // tracker-bypass: __resources install failed — see scroll-handler note above
      window.addEventListener("keydown", window.__latentKeyHandler, true);
    }
    L("debug", "handler installed, collectAt keys=" + Object.keys(collectAt).length);
  })()`)

  // 3. Fresh threshold already set via FRESH_MS in step 2

  // 4. Patch addBadges to record timestamps (retry loop — page handler is fire-and-forget)
  await page.evaluate(`(function() {
    var L = window.__llog;
    var retries = 0;
    var MAX_RETRIES = 10;
    var RETRY_MS = 200;
    var __tracker = window.__latent && window.__latent.__tracker;
    function tryPatch() {
      if (!window.__latent || !window.__latent.li_x) {
        retries++;
        if (retries <= MAX_RETRIES) {
          if (__tracker) {
            __tracker.addTimeout("x", tryPatch, RETRY_MS);
          } else {
            // tracker-bypass: __resources install failed — see scroll-handler note above
            setTimeout(tryPatch, RETRY_MS);
          }
        } else {
          L("warn", "addBadges patch: gave up after " + MAX_RETRIES + " retries (" + (MAX_RETRIES * RETRY_MS) + "ms)");
        }
        return;
      }
      var orig = window.__latent.li_x.addBadges;
      if (!orig || orig.__ts_patched) return;
      var map = window.__latentCollectAt || {};
      window.__latentCollectAt = map;
      window.__latent.li_x.addBadges = function(items) {
        orig(items);
        for (var i = 0; i < items.length; i++) {
          var p = items[i].pathname;
          if (!p) continue;
          // Use backend collectAt timestamp for skip freshness.
          // Only record the first observation — don't overwrite on re-renders.
          if (!map[p] && items[i].collectAt) {
            map[p] = new Date(items[i].collectAt).getTime();
          }
        }
        L("trace", "addBadges: updated " + items.length + " entries, map size=" + Object.keys(map).length);
      };
      window.__latent.li_x.addBadges.__ts_patched = true;
    }
    tryPatch();
  })()`)
}
