import type { NextRequest } from "next/server";

/**
 * Serves the Tampermonkey userscript that forwards the Quotex chart stream from
 * the user's own logged-in browser tab. Read-only: it never sends anything to
 * Quotex and never touches credentials.
 *
 * Two delivery paths run at once:
 *  1. POST to this app's /api/quotex/ingest (works locally, or on Vercel with Redis).
 *  2. Tab-to-tab relay through Tampermonkey storage: the same script, running on the
 *     dashboard page, hands the messages to the page, which parses them itself.
 *     This needs no server storage at all.
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const host = request.nextUrl.hostname;
  const script = `// ==UserScript==
// @name         Vertex Binary - Quotex bridge
// @namespace    vertex-binary
// @version      1.2.0
// @downloadURL  ${origin}/quotex-bridge.user.js
// @updateURL    ${origin}/quotex-bridge.user.js
// @description  Forwards the Quotex chart stream (read-only) from your own browser to the Vertex Binary scanner.
// @match        https://market-qx.trade/*
// @match        https://*.market-qx.trade/*
// @match        https://qxbroker.com/*
// @match        https://*.qxbroker.com/*
// @match        https://quotex.com/*
// @match        https://*.quotex.com/*
// @match        https://quotex.io/*
// @match        https://*.quotex.io/*
// @match        ${origin}/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      ${host}
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==
(function () {
  "use strict";
  var APP_ORIGIN = ${JSON.stringify(origin)};
  var ENDPOINT = APP_ORIGIN + "/api/quotex/ingest";
  var W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var hasGM = typeof GM_setValue === "function" && typeof GM_getValue === "function";

  // ------------------------------------------------------------ dashboard side
  if (location.origin === APP_ORIGIN) {
    if (W.__vertexBridgeDash) return;
    W.__vertexBridgeDash = true;
    function deliver(payload) {
      if (!payload) return;
      try { W.postMessage({ source: "vertex-bridge", payload: payload }, APP_ORIGIN); } catch (e) {}
    }
    function start() {
      if (!hasGM) { deliver({ kind: "status", relay: false, reason: "GM storage not granted" }); return; }
      try {
        var snap = GM_getValue("vb:snapshot", null);
        if (snap) deliver({ kind: "snapshot", data: JSON.parse(snap) });
      } catch (e) {}
      if (typeof GM_addValueChangeListener === "function") {
        GM_addValueChangeListener("vb:batch", function (name, oldV, newV) {
          try { if (newV) deliver({ kind: "batch", data: JSON.parse(newV) }); } catch (e) {}
        });
      } else {
        var lastId = 0;
        setInterval(function () {
          try {
            var raw = GM_getValue("vb:batch", null); if (!raw) return;
            var d = JSON.parse(raw); if (d.id === lastId) return; lastId = d.id;
            deliver({ kind: "batch", data: d });
          } catch (e) {}
        }, 1000);
      }
      deliver({ kind: "status", relay: true });
      // the page may mount after us: answer its hello
      W.addEventListener("message", function (e) {
        if (e.origin === APP_ORIGIN && e.data && e.data.source === "vertex-page" && e.data.type === "hello") {
          deliver({ kind: "status", relay: true });
          try { var s = GM_getValue("vb:snapshot", null); if (s) deliver({ kind: "snapshot", data: JSON.parse(s) }); } catch (err) {}
        }
      });
    }
    if (document.readyState === "loading") W.addEventListener("DOMContentLoaded", start); else start();
    return;
  }

  // ------------------------------------------------------------ Quotex side
  if (W.__vertexBridge) return;
  W.__vertexBridge = true;

  var queue = [];
  var recent = [];   // last small messages (ticks)
  var big = [];      // last large messages (history / candles)
  var seq = 0;
  function push(text) {
    if (typeof text !== "string" || text.length < 4) return;
    queue.push(text);
    if (queue.length > 800) queue.splice(0, queue.length - 800);
    if (text.length > 2000) { big.push(text); if (big.length > 12) big.shift(); }
    else { recent.push(text); if (recent.length > 900) recent.splice(0, recent.length - 900); }
  }
  function decode(data) {
    if (typeof data === "string") return push(data);
    if (data instanceof ArrayBuffer) return push(new TextDecoder().decode(data));
    if (typeof Blob !== "undefined" && data instanceof Blob) data.text().then(push).catch(function () {});
  }

  var Native = W.WebSocket;
  function Hooked(url, protocols) {
    var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    ws.addEventListener("message", function (e) { try { decode(e.data); } catch (err) {} });
    return ws;
  }
  Hooked.prototype = Native.prototype;
  Hooked.CONNECTING = 0; Hooked.OPEN = 1; Hooked.CLOSING = 2; Hooked.CLOSED = 3;
  W.WebSocket = Hooked;

  var failures = 0;
  var relayOk = hasGM;
  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    var body = { messages: batch, page: location.href, at: Date.now(), id: ++seq };
    // path 1: app server
    var json = JSON.stringify(body);
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({ method: "POST", url: ENDPOINT, data: json, headers: { "Content-Type": "application/json" },
        onload: function () { failures = 0; }, onerror: function () { failures++; } });
    } else {
      fetch(ENDPOINT, { method: "POST", body: json, headers: { "Content-Type": "application/json" }, mode: "cors" })
        .then(function () { failures = 0; }).catch(function () { failures++; });
    }
    // path 2: tab-to-tab relay through Tampermonkey storage
    if (hasGM) {
      try {
        GM_setValue("vb:batch", json);
        GM_setValue("vb:snapshot", JSON.stringify({ messages: big.concat(recent), page: location.href, at: Date.now() }));
        relayOk = true;
      } catch (e) { relayOk = false; }
    }
  }
  setInterval(flush, 1000);

  function badge() {
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;font:11px/1.6 monospace;padding:2px 8px;border-radius:999px;background:#0b1017;color:#22ff88;border:1px solid #22ff88;opacity:.85;pointer-events:none";
    document.body.appendChild(el);
    function paint() {
      var serverOk = failures <= 3;
      var ok = serverOk || relayOk;
      el.style.color = ok ? "#22ff88" : "#ff2d55"; el.style.borderColor = el.style.color;
      el.textContent = "Vertex bridge" + (relayOk ? " · relay" : "") + (serverOk ? " · server" : " · server offline");
    }
    paint(); setInterval(paint, 2000);
  }
  if (document.body) badge(); else W.addEventListener("DOMContentLoaded", badge);
  console.log("[Vertex Binary] Quotex bridge active ->", ENDPOINT, "relay:", hasGM);
})();
`;
  return new Response(script, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
