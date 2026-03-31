// @ts-nocheck
/**
 * Page-side resource tracker — tracks MutationObservers, event listeners,
 * and timers per collector for bulk cleanup.
 *
 * These functions are serialized via .toString() and injected into the browser
 * page context via installModule(). They reference browser globals (window,
 * AbortController) that don't exist in Node.js — hence @ts-nocheck.
 *
 * Module name: "__resources" (double underscore = framework-owned).
 * In-page access: window.__latent.__tracker (initialized after install).
 */

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// NOTE: No module-level variables! Functions serialized via .toString() cannot
// reference closure variables — all constants must be inlined in each function.

/**
 * createResourceTracker — create a per-collector resource cleanup coordinator.
 *
 * Returns an object that tracks MutationObservers, event listeners, timers,
 * and arbitrary cleanup functions keyed by collector ID. Calling
 * disposeCollector(id) tears down everything registered under that ID.
 *
 * Uses AbortController for addEventListener cleanup (native browser support).
 */
export function createResourceTracker() {
  var resources = {}

  function getOrCreate(collectorId) {
    if (!resources[collectorId]) resources[collectorId] = []
    return resources[collectorId]
  }

  return {
    /**
     * Track a MutationObserver. Calls observe() and stores disconnect().
     */
    addObserver: function(collectorId, observer, target, config) {
      observer.observe(target, config)
      getOrCreate(collectorId).push(function() { observer.disconnect() })
      return observer
    },

    /**
     * Track an event listener. Uses AbortController internally for cleanup.
     */
    addListener: function(collectorId, target, event, handler, options) {
      var ac = new AbortController()
      var opts = {}
      if (options) {
        for (var k in options) {
          if (options.hasOwnProperty(k)) opts[k] = options[k]
        }
      }
      opts.signal = ac.signal
      target.addEventListener(event, handler, opts)
      getOrCreate(collectorId).push(function() { ac.abort() })
    },

    /**
     * Track a setTimeout. Returns the timer ID.
     */
    addTimeout: function(collectorId, fn, delay) {
      var id = setTimeout(fn, delay)
      getOrCreate(collectorId).push(function() { clearTimeout(id) })
      return id
    },

    /**
     * Track a setInterval. Returns the timer ID.
     */
    addInterval: function(collectorId, fn, delay) {
      var id = setInterval(fn, delay)
      getOrCreate(collectorId).push(function() { clearInterval(id) })
      return id
    },

    /**
     * Register an arbitrary cleanup function.
     */
    addCleanup: function(collectorId, fn) {
      getOrCreate(collectorId).push(fn)
    },

    /**
     * Tear down all resources for a specific collector (LIFO order).
     */
    disposeCollector: function(collectorId) {
      var cleanups = resources[collectorId]
      if (!cleanups) return
      for (var i = cleanups.length - 1; i >= 0; i--) {
        try { cleanups[i]() } catch(e) { /* swallow — continue cleanup */ }
      }
      delete resources[collectorId]
    },

    /**
     * Tear down all resources for all collectors.
     */
    disposeAll: function() {
      var ids = Object.keys(resources)
      for (var j = 0; j < ids.length; j++) {
        this.disposeCollector(ids[j])
      }
    },

    /**
     * Query which collectors have registered resources.
     */
    activeCollectors: function() {
      return Object.keys(resources)
    }
  }
}
