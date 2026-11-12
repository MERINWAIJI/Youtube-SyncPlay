// Content script for www.youtube.com.
//
// YouTube is a single-page app, so this script lives across navigations and
// re-evaluates "which video is this page showing" on every yt-navigate event.
// A page is in *sync mode* only while it shows the room's shared video; any
// other page is *local mode* and never broadcasts.
(() => {
  "use strict";
  if (window.__ytSyncPlayLoaded) return;
  window.__ytSyncPlayLoaded = true;

  const { parseYouTubeVideoRef } = self.YTSync;

  // Seek when further than this from the room position while applying a
  // remote change...
  const APPLY_TOL_PLAYING = 1.2;
  const APPLY_TOL_PAUSED = 0.25;
  // ...but only treat a local event as a real user change beyond these (must
  // be >= the apply tolerances, or an un-seeked remote apply would echo back).
  const MATCH_TOL_PLAYING = 1.5;
  const MATCH_TOL_PAUSED = 0.5;
  // The periodic check is looser so a slow connection is not seek-looped.
  const RECONCILE_TOL = 2.5;
  const BROADCAST_DEBOUNCE_MS = 150;
  const TICK_MS = 1000;
  const NATURAL_END_WINDOW_MS = 15000;
  const OPTIMISTIC_TTL_MS = 3000;

  let alive = true;
  let snap = null; // { conn, memberId, room, autoShareNext }
  let video = null;
  let pageVideoId = null;
  let lastHref = location.href;
  let hydrated = false; // this page has adopted the room state at least once
  let broadcastTimer = null;
  let naturalEnd = null; // { videoId, at }
  let optimistic = null; // { playback, anchorAt, pendingEchoes, at }
  let lastServerSeq = null;
  let adNoticeShown = false;
  let autoplayNoticeAt = 0;
  let localNoticeFor = null;
  let autoShareTimer = null;

  // ---- messaging -------------------------------------------------------------
  function t(key, ...subs) {
    try {
      return chrome.i18n.getMessage(key, subs) || key;
    } catch {
      return key;
    }
  }

  function shutdown() {
    // The extension was reloaded or removed; this script is orphaned.
    alive = false;
    clearInterval(tickTimer);
    clearTimeout(broadcastTimer);
    clearTimeout(autoShareTimer);
    unbindVideo();
  }

  function send(message) {
    if (!alive) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      shutdown();
      return Promise.resolve(null);
    }
  }

  // ---- page / player inspection ------------------------------------------------
  function readPageVideoId() {
    const ref = parseYouTubeVideoRef(location.href);
    return ref ? ref.videoId : null;
  }

  function findVideo() {
    const selector = location.pathname.startsWith("/shorts/")
      ? "#shorts-player video, #movie_player video"
      : "#movie_player video, #shorts-player video";
    return document.querySelector(selector);
  }

  function playerEl() {
    return video ? video.closest(".html5-video-player") : null;
  }

  // While an ad plays, the same <video> element is showing the ad: its time
  // and events say nothing about the shared video.
  function isAdShowing() {
    const p = playerEl();
    return Boolean(
      p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")),
    );
  }

  function isLive() {
    const p = playerEl();
    return Boolean(p && (p.classList.contains("ytp-live") || p.querySelector(".ytp-live")));
  }

  // During SPA navigation the URL can change before the player swaps videos.
  function playerMatchesPage() {
    if (location.pathname !== "/watch") return true;
    const flexy = document.querySelector("ytd-watch-flexy[video-id]");
    return !flexy || flexy.getAttribute("video-id") === pageVideoId;
  }

  function pageTitle() {
    return document.title
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*-\s*YouTube\s*$/, "")
      .trim();
  }

  const inRoom = () => Boolean(snap && snap.room && snap.memberId);
  const sharedVideo = () => (inRoom() ? snap.room.sharedVideo : null);
  const isSharedPage = () => {
    const shared = sharedVideo();
    return Boolean(shared && pageVideoId && shared.videoId === pageVideoId);
  };

  function roomPlayback() {
    if (!isSharedPage()) return null;
    const pb = snap.room.playback;
    return pb && pb.videoId === pageVideoId ? pb : null;
  }

  function targetTime(pb) {
    if (pb.playState !== "playing") return pb.currentTime;
    const elapsed = Math.max(0, Date.now() - snap.room.anchorAt) / 1000;
    return pb.currentTime + elapsed * pb.playbackRate;
  }

  function localState() {
    return {
      videoId: pageVideoId,
      currentTime: Math.max(0, video.currentTime || 0),
      playState: video.paused ? "paused" : "playing",
      playbackRate: video.playbackRate || 1,
    };
  }

  function matchesRoom(ls) {
    const pb = roomPlayback();
    if (!pb) return false;
    if (pb.playState !== ls.playState) return false;
    if (isLive()) return true;
    if (Math.abs(pb.playbackRate - ls.playbackRate) > 0.001) return false;
    let target = targetTime(pb);
    if (Number.isFinite(video.duration)) target = Math.min(target, video.duration);
    const tol = ls.playState === "playing" ? MATCH_TOL_PLAYING : MATCH_TOL_PAUSED;
    return Math.abs(ls.currentTime - target) <= tol;
  }

  // ---- applying room state -------------------------------------------------------
  function applyRemote(tolOverride) {
    const pb = roomPlayback();
    if (!pb) return false;
    bindVideo();
    if (!video || video.readyState < 1 || !playerMatchesPage()) return false;
    if (isAdShowing()) {
      hydrated = false;
      return false;
    }

    const live = isLive();
    let target = targetTime(pb);
    let pastEnd = false;
    if (Number.isFinite(video.duration) && video.duration > 0 && target >= video.duration - 0.3) {
      target = Math.max(0, video.duration - 0.3);
      pastEnd = pb.playState === "playing";
    }

    if (!live) {
      if (Math.abs(video.playbackRate - pb.playbackRate) > 0.001) {
        video.playbackRate = pb.playbackRate;
      }
      const tol =
        tolOverride != null
          ? pb.playState === "playing"
            ? tolOverride
            : APPLY_TOL_PAUSED
          : pb.playState === "playing"
            ? APPLY_TOL_PLAYING
            : APPLY_TOL_PAUSED;
      if (Math.abs(video.currentTime - target) > tol && !(pastEnd && video.ended)) {
        video.currentTime = target;
      }
    }

    if (pb.playState === "playing" && video.paused && !pastEnd) {
      const attempt = video.play();
      if (attempt && attempt.catch) {
        attempt.catch(() => {
          // Autoplay policy: the browser wants a user gesture on this tab.
          if (Date.now() - autoplayNoticeAt > 15000) {
            autoplayNoticeAt = Date.now();
            toast(t("toastAutoplayBlocked"));
          }
        });
      }
    } else if (pb.playState === "paused" && !video.paused) {
      video.pause();
    }

    hydrated = true;
    return true;
  }

  // ---- broadcasting local changes ------------------------------------------------
  function scheduleBroadcast() {
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(flushBroadcast, BROADCAST_DEBOUNCE_MS);
  }

  function flushBroadcast() {
    broadcastTimer = null;
    if (!alive || !inRoom() || !hydrated || !video) return;
    pageVideoId = readPageVideoId();
    if (!isSharedPage() || !playerMatchesPage() || isAdShowing()) return;
    if (video.seeking) return scheduleBroadcast();

    const ls = localState();
    if (matchesRoom(ls)) return; // echo of a state we applied, or no real change

    // Adopt the change locally right away so the periodic check does not pull
    // the player back while the update is in flight.
    const pb = {
      ...ls,
      actorId: snap.memberId,
      actorName: "",
      seq: snap.room.playback ? snap.room.playback.seq : 0,
    };
    const pendingEchoes =
      optimistic && Date.now() - optimistic.at < OPTIMISTIC_TTL_MS
        ? optimistic.pendingEchoes + 1
        : 1;
    optimistic = { playback: pb, anchorAt: Date.now(), pendingEchoes, at: Date.now() };
    snap.room.playback = pb;
    snap.room.anchorAt = optimistic.anchorAt;

    send({ type: "content:playback", playback: ls });
  }

  function onVideoEvent(event) {
    if (!alive) return;
    if (event.type === "ended") {
      if (isSharedPage() && !isAdShowing()) {
        naturalEnd = { videoId: pageVideoId, at: Date.now() };
      }
      return;
    }
    if (!isSharedPage()) return;
    if (isAdShowing()) {
      hydrated = false;
      return;
    }
    if (!hydrated) {
      // Page-load autoplay and post-ad resume land here: adopt the room state
      // instead of pushing this tab's state onto the room.
      applyRemote();
      return;
    }
    scheduleBroadcast();
  }

  const VIDEO_EVENTS = ["play", "pause", "seeked", "ratechange", "ended", "loadedmetadata"];

  function unbindVideo() {
    if (!video) return;
    for (const name of VIDEO_EVENTS) video.removeEventListener(name, onVideoEvent);
    video = null;
  }

  function bindVideo() {
    const found = findVideo();
    if (found === video) return;
    unbindVideo();
    video = found;
    if (!video) return;
    for (const name of VIDEO_EVENTS) video.addEventListener(name, onVideoEvent);
  }

  // ---- snapshots from the background ----------------------------------------------
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function describeChange(prevPb, pb) {
    const name = pb.actorName || t("someone");
    if (!prevPb || prevPb.videoId !== pb.videoId) return null;
    if (prevPb.playState !== pb.playState) {
      return pb.playState === "playing" ? t("toastPlay", name) : t("toastPause", name);
    }
    if (Math.abs(prevPb.playbackRate - pb.playbackRate) > 0.001) {
      return t("toastRate", name, String(pb.playbackRate));
    }
    return t("toastSeek", name, formatTime(pb.currentTime));
  }

  function onSnapshot(next, isFirst) {
    const prev = snap;
    snap = next;
    if (!inRoom()) {
      hydrated = false;
      optimistic = null;
      lastServerSeq = null;
      localNoticeFor = null;
      return;
    }

    const prevShared = prev && prev.room && prev.room.sharedVideo;
    const shared = snap.room.sharedVideo;
    if ((shared && shared.videoId) !== (prevShared && prevShared.videoId)) {
      hydrated = false;
      optimistic = null;
      naturalEnd = null;
      if (shared && !isFirst && prev && prev.room && shared.sharedByMemberId !== snap.memberId) {
        toast(t("toastShared", shared.sharedByDisplayName || t("someone"), shared.title));
      }
    }

    if (!isSharedPage()) {
      notifyLocalMode();
      return;
    }

    const pb = snap.room.playback;
    const prevPb = prev && prev.room ? prev.room.playback : null;
    if (!pb || pb.videoId !== pageVideoId) return;
    // Compare against the last *server* sequence: the previous snapshot may
    // hold an optimistic local state, and the background also re-pushes the
    // same playback for unrelated changes (member list, connection).
    const changed = pb.seq !== lastServerSeq;
    lastServerSeq = pb.seq;

    if (pb.actorId === snap.memberId && hydrated) {
      // Echo of our own update. If more of ours are still in flight, keep the
      // newest local intent instead of stepping back to an older echo.
      if (optimistic && Date.now() - optimistic.at < OPTIMISTIC_TTL_MS) {
        if (changed) optimistic.pendingEchoes -= 1;
        if (optimistic.pendingEchoes > 0) {
          snap.room.playback = optimistic.playback;
          snap.room.anchorAt = optimistic.anchorAt;
        } else {
          optimistic = null;
        }
      } else {
        optimistic = null;
      }
      return;
    }

    optimistic = null;
    if (changed || !hydrated) {
      const wasHydrated = hydrated;
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
      if (applyRemote() && wasHydrated && changed && !isFirst) {
        const text = describeChange(prevPb, pb);
        if (text) toast(text);
      }
    }
  }

  function notifyLocalMode() {
    if (!sharedVideo() || !pageVideoId || localNoticeFor === pageVideoId) return;
    if (autoShareTimer) return;
    localNoticeFor = pageVideoId;
    toast(t("toastLocalMode"));
  }

  // ---- navigation -----------------------------------------------------------------
  function collectShare() {
    pageVideoId = readPageVideoId();
    bindVideo();
    if (!pageVideoId) return { ok: false, error: "not_video_page" };
    const usable = video && video.readyState >= 1 && playerMatchesPage() && !isAdShowing();
    const playback = usable
      ? localState()
      : { videoId: pageVideoId, currentTime: 0, playState: "playing", playbackRate: 1 };
    return {
      ok: true,
      video: { videoId: pageVideoId, title: pageTitle() || pageVideoId },
      playback,
    };
  }

  // The sharer's player moved on by itself (autoplay / playlist) right after
  // the shared video ended: take the room along.
  function maybeAutoShareNext() {
    const shared = sharedVideo();
    if (
      !shared ||
      !snap.autoShareNext ||
      !pageVideoId ||
      isSharedPage() ||
      !naturalEnd ||
      naturalEnd.videoId !== shared.videoId ||
      Date.now() - naturalEnd.at > NATURAL_END_WINDOW_MS ||
      shared.sharedByMemberId !== snap.memberId
    ) {
      return false;
    }
    naturalEnd = null;
    const expected = pageVideoId;
    clearTimeout(autoShareTimer);
    // Give YouTube a moment to update the title for the new video.
    autoShareTimer = setTimeout(() => {
      autoShareTimer = null;
      if (!alive || !inRoom() || readPageVideoId() !== expected) return;
      const info = collectShare();
      if (info.ok) send({ type: "content:share", video: info.video, playback: info.playback });
    }, 900);
    return true;
  }

  function onNavigate() {
    lastHref = location.href;
    const previous = pageVideoId;
    pageVideoId = readPageVideoId();
    if (pageVideoId !== previous) {
      hydrated = false;
      optimistic = null;
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    bindVideo();
    if (!inRoom()) return;
    if (isSharedPage()) {
      applyRemote();
    } else if (pageVideoId !== previous) {
      if (!maybeAutoShareNext()) notifyLocalMode();
    }
  }

  function tick() {
    if (!alive) return;
    if (location.href !== lastHref) onNavigate();
    if (!inRoom() || !isSharedPage()) return;
    bindVideo();
    if (!video) return;

    if (isAdShowing()) {
      hydrated = false;
      if (!adNoticeShown) {
        adNoticeShown = true;
        toast(t("toastAd"));
      }
      return;
    }
    adNoticeShown = false;

    if (!hydrated) {
      applyRemote();
      return;
    }
    if (broadcastTimer || video.seeking || video.readyState < 3) return;
    applyRemote(RECONCILE_TOL);
  }

  // ---- toasts ---------------------------------------------------------------------
  // Built with DOM APIs only: YouTube enforces Trusted Types, so innerHTML
  // would throw.
  let toastRoot = null;

  function ensureToastRoot() {
    const parent = document.fullscreenElement || document.documentElement;
    if (toastRoot && toastRoot.host.parentNode === parent) return toastRoot;
    if (toastRoot) toastRoot.host.remove();
    const host = document.createElement("div");
    host.id = "yt-syncplay-toasts";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; position: fixed; top: 72px; right: 20px; z-index: 2147483647;
        pointer-events: none; }
      .stack { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .toast { max-width: 340px; padding: 10px 14px; border-radius: 10px;
        background: rgba(24, 24, 32, 0.94); color: #f4f4f8;
        font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); border-left: 3px solid #7c6cff;
        overflow-wrap: anywhere; opacity: 0; transform: translateX(12px);
        transition: opacity .18s ease, transform .18s ease; }
      .toast.show { opacity: 1; transform: none; }
      @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
    `;
    const stack = document.createElement("div");
    stack.className = "stack";
    shadow.append(style, stack);
    parent.appendChild(host);
    toastRoot = { host, stack };
    return toastRoot;
  }

  function toast(text) {
    if (!alive || !text) return;
    const { stack } = ensureToastRoot();
    while (stack.childElementCount >= 4) stack.firstElementChild.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 220);
    }, 3600);
  }

  // ---- wiring ---------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!alive || !msg) return false;
    if (msg.type === "bg:state") {
      onSnapshot(msg.snapshot, false);
    } else if (msg.type === "bg:event") {
      if (msg.event === "member-joined") toast(t("toastJoined", msg.name));
      else if (msg.event === "member-left") toast(t("toastLeft", msg.name));
    } else if (msg.type === "bg:collect-share") {
      sendResponse(collectShare());
    }
    return false;
  });

  document.addEventListener("yt-navigate-start", () => {
    // The player is about to swap videos; its events are not user intent.
    hydrated = false;
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  });
  document.addEventListener("yt-navigate-finish", onNavigate);

  const tickTimer = setInterval(tick, TICK_MS);

  pageVideoId = readPageVideoId();
  bindVideo();
  send({ type: "content:hello" }).then((snapshot) => {
    if (snapshot) onSnapshot(snapshot, true);
  });
})();
