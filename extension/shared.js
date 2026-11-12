/*
 * Shared helpers. Loaded as a classic script by the service worker
 * (importScripts), the popup (<script>) and the content script (manifest js
 * list), so it attaches to the global object instead of using ES modules.
 */
(function (root) {
  "use strict";

  const DEFAULT_SERVER_URL = "ws://localhost:8787";
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const YOUTUBE_HOSTS = new Set([
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
  ]);

  function canonicalUrl(videoId) {
    return "https://www.youtube.com/watch?v=" + videoId;
  }

  /**
   * Parse any supported YouTube page URL into { videoId, url }.
   * Supported: /watch?v=ID, /shorts/ID, /live/ID, /embed/ID, youtu.be/ID.
   * Returns null for everything else. All video identity comparisons in the
   * extension go through this helper.
   */
  function parseYouTubeVideoRef(input) {
    let url;
    try {
      url = new URL(String(input));
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    let id = null;
    if (url.hostname === "youtu.be") {
      id = url.pathname.split("/")[1] || null;
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      if (url.pathname === "/watch") {
        id = url.searchParams.get("v");
      } else {
        const m = url.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }
    if (!id || !VIDEO_ID_RE.test(id)) return null;
    return { videoId: id, url: canonicalUrl(id) };
  }

  /** Invite format is `roomCode:joinToken`, same as the Bilibili original. */
  function parseInvite(input) {
    const m = String(input || "")
      .trim()
      .match(/^([A-Za-z0-9]{4,12}):([A-Za-z0-9_-]{8,64})$/);
    if (!m) return null;
    return { roomCode: m[1].toUpperCase(), joinToken: m[2] };
  }

  /** Empty input falls back to the default; only ws:// and wss:// pass. */
  function normalizeServerUrl(input) {
    const raw = String(input || "").trim();
    if (!raw) return DEFAULT_SERVER_URL;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return url.toString().replace(/\/$/, "");
  }

  root.YTSync = {
    DEFAULT_SERVER_URL,
    VIDEO_ID_RE,
    canonicalUrl,
    parseYouTubeVideoRef,
    parseInvite,
    normalizeServerUrl,
  };
})(typeof self !== "undefined" ? self : globalThis);
