// Background service worker: owns the WebSocket, the room session and tab
// coordination. Content scripts and the popup only talk to this worker.
importScripts("shared.js");

const { parseYouTubeVideoRef, parseInvite, normalizeServerUrl, DEFAULT_SERVER_URL } =
  self.YTSync;

const YT_MATCH = ["https://www.youtube.com/*"];
const KEEPALIVE_MS = 20_000; // WebSocket traffic keeps the MV3 worker alive
const MAX_RETRY_MS = 15_000;

// ---- state -----------------------------------------------------------------
// settings  -> chrome.storage.local   (survives browser restarts)
// session   -> chrome.storage.session (cleared when the browser closes)
let settings = { serverUrl: DEFAULT_SERVER_URL, displayName: "", autoShareNext: true };
let session = null; // { roomCode, joinToken, memberToken, memberId }
let tabState = { syncTabId: null, lastOpenedVideoId: null };

let room = null; // last room:state payload + anchorAt (local ms)
let conn = "disconnected"; // disconnected | connecting | connected
let lastError = null;
let ws = null;
let pending = null; // create/join request waiting for the socket to open
let retry = 0;
let retryTimer = null;
let keepAliveTimer = null;

const ready = (async () => {
  const local = await chrome.storage.local.get(["settings"]);
  Object.assign(settings, local.settings || {});
  const stored = await chrome.storage.session.get(["session", "tabState"]);
  session = stored.session || null;
  Object.assign(tabState, stored.tabState || {});
  if (session) connect();
})();

const saveSettings = () => chrome.storage.local.set({ settings });
const saveSession = () => chrome.storage.session.set({ session });
const saveTabState = () => chrome.storage.session.set({ tabState });

// ---- snapshots ---------------------------------------------------------------
function popupSnapshot() {
  return {
    conn,
    lastError,
    session: session
      ? { roomCode: session.roomCode, joinToken: session.joinToken, memberId: session.memberId }
      : null,
    room,
    settings,
    busy: Boolean(pending),
  };
}

// Content scripts never see the invite or member token.
function contentSnapshot() {
  return {
    conn,
    memberId: session ? session.memberId : null,
    room: session ? room : null,
    autoShareNext: settings.autoShareNext,
  };
}

async function sendToTabs(message) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: YT_MATCH });
  } catch {
    return;
  }
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

function pushAll() {
  chrome.runtime
    .sendMessage({ type: "bg:popup-state", snapshot: popupSnapshot() })
    .catch(() => {});
  sendToTabs({ type: "bg:state", snapshot: contentSnapshot() });
}

// ---- socket ------------------------------------------------------------------
function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
    return true;
  }
  return false;
}

function joinPayload() {
  return {
    roomCode: session.roomCode,
    joinToken: session.joinToken,
    memberToken: session.memberToken,
    displayName: settings.displayName,
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** retry);
  retry += 1;
  retryTimer = setTimeout(() => {
    if (session && !ws) connect();
  }, delay);
}

function closeSocket() {
  clearTimeout(retryTimer);
  clearInterval(keepAliveTimer);
  const sock = ws;
  ws = null;
  conn = "disconnected";
  if (sock) {
    try {
      sock.close();
    } catch {}
  }
}

function connect() {
  if (ws) return;
  clearTimeout(retryTimer);
  conn = "connecting";

  let sock;
  try {
    sock = new WebSocket(settings.serverUrl);
  } catch {
    conn = "disconnected";
    lastError = "connect_failed";
    pending = null;
    pushAll();
    return;
  }
  ws = sock;
  let opened = false;

  sock.onopen = () => {
    if (ws !== sock) return;
    opened = true;
    retry = 0;
    conn = "connected";
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => send("ping"), KEEPALIVE_MS);
    if (pending) {
      send(pending.type, pending.payload);
    } else if (session) {
      send("room:join", joinPayload());
    } else {
      closeSocket();
    }
    pushAll();
  };

  sock.onmessage = (event) => {
    if (ws !== sock) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg && typeof msg.type === "string") handleServer(msg);
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(keepAliveTimer);
    conn = "disconnected";
    if (pending) {
      pending = null;
      lastError = "connect_failed";
    } else if (session) {
      if (!opened) lastError = "connect_failed";
      scheduleRetry();
    }
    pushAll();
  };

  pushAll();
}

function handleServer(msg) {
  const p = msg.payload || {};
  switch (msg.type) {
    case "room:created":
    case "room:joined": {
      pending = null;
      lastError = null;
      session = {
        roomCode: p.roomCode,
        joinToken: p.joinToken,
        memberToken: p.memberToken,
        memberId: p.memberId,
      };
      saveSession();
      pushAll();
      break;
    }
    case "room:state": {
      if (!session || p.roomCode !== session.roomCode) break;
      const age = Number.isFinite(p.playbackAgeMs) ? Math.max(0, p.playbackAgeMs) : 0;
      room = {
        roomCode: p.roomCode,
        sharedVideo: p.sharedVideo || null,
        playback: p.playback || null,
        members: Array.isArray(p.members) ? p.members : [],
        // Local instant the playback snapshot was "true" at. Positions are
        // extrapolated from this anchor, never from the server's clock.
        anchorAt: Date.now() - age,
      };
      lastError = null;
      pushAll();
      maybeOpenShared();
      break;
    }
    case "room:member-joined":
    case "room:member-left": {
      if (!session || !p.member || p.member.id === session.memberId) break;
      sendToTabs({
        type: "bg:event",
        event: msg.type === "room:member-joined" ? "member-joined" : "member-left",
        name: p.member.name,
      });
      break;
    }
    case "error": {
      lastError = p.code || "internal_error";
      const hadPending = Boolean(pending);
      pending = null;
      if (p.code === "room_not_found" || p.code === "join_token_invalid") {
        // Terminal for a stored session (e.g. the server restarted).
        if (!hadPending || !session) clearSession();
      }
      if (!session) closeSocket();
      pushAll();
      break;
    }
    default:
      break;
  }
}

function clearSession() {
  session = null;
  room = null;
  tabState = { syncTabId: null, lastOpenedVideoId: null };
  saveSession();
  saveTabState();
}

// ---- tab coordination ----------------------------------------------------------
// When the room's shared video changes, bring this member to it once: reuse a
// tab already on that video, else navigate the tab that was following the
// room, else open a new tab. Later manual browsing is left alone.
async function maybeOpenShared() {
  const video = room && room.sharedVideo;
  if (!video || video.videoId === tabState.lastOpenedVideoId) return;
  tabState.lastOpenedVideoId = video.videoId;
  saveTabState();
  await openSharedVideo(false);
}

async function openSharedVideo(focus) {
  const video = room && room.sharedVideo;
  if (!video) return;
  // Only ever open a URL that parses back to the shared video id.
  const ref = parseYouTubeVideoRef(video.url);
  if (!ref || ref.videoId !== video.videoId) return;

  const tabs = await chrome.tabs.query({ url: YT_MATCH });
  let target = tabs.find((t) => parseYouTubeVideoRef(t.url || "")?.videoId === video.videoId);
  if (!target) {
    const syncTab = tabs.find((t) => t.id === tabState.syncTabId);
    if (syncTab) {
      target = await chrome.tabs.update(syncTab.id, { url: ref.url });
    } else {
      target = await chrome.tabs.create({ url: ref.url, active: true });
    }
  }
  tabState.syncTabId = target.id;
  saveTabState();
  if (focus) {
    await chrome.tabs.update(target.id, { active: true });
    if (target.windowId != null) {
      await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
    }
  }
}

function shareFromTab(tabId, video, playback) {
  if (!session) return { ok: false, error: "not_in_room" };
  if (!video || !self.YTSync.VIDEO_ID_RE.test(video.videoId || "")) {
    return { ok: false, error: "not_video_page" };
  }
  // The sharer is already on the video: do not reopen it for them.
  tabState.lastOpenedVideoId = video.videoId;
  tabState.syncTabId = tabId;
  saveTabState();
  if (!send("video:share", { video, playback })) {
    return { ok: false, error: "not_connected" };
  }
  return { ok: true };
}

// ---- requests from popup / content -----------------------------------------------
function startRoomRequest(type, payload) {
  lastError = null;
  if (session) {
    send("room:leave");
    clearSession();
  }
  pending = { type, payload };
  if (ws && ws.readyState === WebSocket.OPEN) {
    send(type, payload);
  } else {
    connect();
  }
  pushAll();
}

async function handleRequest(msg, sender) {
  await ready;
  switch (msg.type) {
    // -- content --
    case "content:hello": {
      if (session && !ws) connect();
      return contentSnapshot();
    }
    case "content:playback": {
      if (session && msg.playback) send("playback:update", { playback: msg.playback });
      return { ok: true };
    }
    case "content:share": {
      if (!sender.tab) return { ok: false };
      return shareFromTab(sender.tab.id, msg.video, msg.playback);
    }

    // -- popup --
    case "popup:get": {
      if (session && !ws) connect();
      return popupSnapshot();
    }
    case "popup:create": {
      settings.displayName = String(msg.displayName || "").trim().slice(0, 32);
      saveSettings();
      startRoomRequest("room:create", { displayName: settings.displayName });
      return { ok: true };
    }
    case "popup:join": {
      const invite = parseInvite(msg.invite);
      if (!invite) {
        lastError = "invalid_invite";
        pushAll();
        return { ok: false };
      }
      settings.displayName = String(msg.displayName || "").trim().slice(0, 32);
      saveSettings();
      startRoomRequest("room:join", { ...invite, displayName: settings.displayName });
      return { ok: true };
    }
    case "popup:leave": {
      send("room:leave");
      clearSession();
      pending = null;
      lastError = null;
      closeSocket();
      pushAll();
      return { ok: true };
    }
    case "popup:share": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !parseYouTubeVideoRef(tab.url || "")) {
        return { ok: false, error: "not_video_page" };
      }
      let info;
      try {
        info = await chrome.tabs.sendMessage(tab.id, { type: "bg:collect-share" });
      } catch {
        // The tab was open before the extension was installed/reloaded.
        return { ok: false, error: "no_content_script" };
      }
      if (!info || !info.ok) return { ok: false, error: (info && info.error) || "not_video_page" };
      return shareFromTab(tab.id, info.video, info.playback);
    }
    case "popup:open-shared": {
      await openSharedVideo(true);
      return { ok: true };
    }
    case "popup:set-name": {
      settings.displayName = String(msg.displayName || "").trim().slice(0, 32);
      saveSettings();
      if (session && settings.displayName) {
        send("profile:update", { displayName: settings.displayName });
      }
      return { ok: true };
    }
    case "popup:set-auto-next": {
      settings.autoShareNext = Boolean(msg.value);
      saveSettings();
      pushAll();
      return { ok: true };
    }
    case "popup:set-server": {
      const url = normalizeServerUrl(msg.url);
      if (!url) return { ok: false, error: "invalid_server_url" };
      if (url !== settings.serverUrl) {
        // Rooms live on one server; switching servers leaves the room.
        send("room:leave");
        clearSession();
        pending = null;
        closeSocket();
        settings.serverUrl = url;
        saveSettings();
      }
      lastError = null;
      pushAll();
      return { ok: true };
    }
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (!msg.type.startsWith("content:") && !msg.type.startsWith("popup:")) return false;
  handleRequest(msg, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true; // async response
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabState.syncTabId === tabId) {
    tabState.syncTabId = null;
    saveTabState();
  }
});

// Watchdog: if the worker was suspended while in a room, the alarm wakes it
// and the stored session reconnects.
chrome.alarms.create("watchdog", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "watchdog") return;
  await ready;
  if (session && !ws) connect();
});
