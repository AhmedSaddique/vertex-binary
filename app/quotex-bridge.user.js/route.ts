import type { NextRequest } from "next/server";

/**
 * Serves the Tampermonkey userscript that forwards the Quotex chart stream from
 * the user's own logged-in browser tab to this app. Read-only: it never sends
 * anything to Quotex and never touches credentials.
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const host = request.nextUrl.hostname;
  const script = `// ==UserScript==
// @name         Vertex Binary - Quotex bridge
// @namespace    vertex-binary
// @version      1.1.0
// @downloadURL  ${origin}/quotex-bridge.user.js
// @updateURL    ${origin}/quotex-bridge.user.js
// @description  Forwards the Quotex chart stream (read-only) from your own browser to the local Vertex Binary scanner.
// @match        https://market-qx.trade/*
// @match        https://*.market-qx.trade/*
// @match        https://qxbroker.com/*
// @match        https://*.qxbroker.com/*
// @match        https://quotex.com/*
// @match        https://*.quotex.com/*
// @match        https://quotex.io/*
// @match        https://*.quotex.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      ${host}
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==
(function () {
  "use strict";
  var ENDPOINT = ${JSON.stringify(origin + "/api/quotex/ingest")};
  var W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (W.__vertexBridge) return;
  W.__vertexBridge = true;

  var queue = [];
  function push(text) {
    if (typeof text !== "string" || text.length < 4) return;
    queue.push(text);
    if (queue.length > 800) queue.splice(0, queue.length - 800);
  }
  function decode(data) {
    if (typeof data === "string") return push(data);
    if (data instanceof ArrayBuffer) return push(new TextDecoder().decode(data));
    if (typeof Blob !== "undefined" && data instanceof Blob) data.text().then(push).catch(function () {});
  }

  var Native = W.WebSocket;
  function Hooked(url, protocols) {
    var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    ws.addEventListener("message", function (e) {
      try { decode(e.data); } catch (err) {}
    });
    return ws;
  }
  Hooked.prototype = Native.prototype;
  Hooked.CONNECTING = 0; Hooked.OPEN = 1; Hooked.CLOSING = 2; Hooked.CLOSED = 3;
  W.WebSocket = Hooked;

  var failures = 0;
  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    var body = JSON.stringify({ messages: batch, page: location.href, at: Date.now() });
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "POST", url: ENDPOINT, data: body,
        headers: { "Content-Type": "application/json" },
        onload: function () { failures = 0; },
        onerror: function () { failures++; }
      });
    } else {
      fetch(ENDPOINT, { method: "POST", body: body, headers: { "Content-Type": "application/json" }, mode: "cors" })
        .then(function () { failures = 0; })
        .catch(function () { failures++; });
    }
  }
  setInterval(flush, 1000);

  // small on-page badge so you can see the bridge is alive
  function badge() {
    var el = document.createElement("div");
    el.textContent = "Vertex bridge";
    el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;font:11px/1.6 monospace;padding:2px 8px;border-radius:999px;background:#0b1017;color:#22ff88;border:1px solid #22ff88;opacity:.85;pointer-events:none";
    document.body.appendChild(el);
    setInterval(function () {
      el.style.color = failures > 3 ? "#ff2d55" : "#22ff88";
      el.style.borderColor = el.style.color;
      el.textContent = failures > 3 ? "Vertex bridge: app offline" : "Vertex bridge";
    }, 2000);
  }
  if (document.body) badge(); else W.addEventListener("DOMContentLoaded", badge);
  console.log("[Vertex Binary] Quotex bridge active ->", ENDPOINT);
})();
`;
  return new Response(script, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
