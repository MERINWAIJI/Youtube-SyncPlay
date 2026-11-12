# YouTube SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

YouTube SyncPlay is a "browser extension + WebSocket server" project for watching YouTube together. Create or join a room, share the current video, and keep play, pause, seek and playback rate in sync between room members.

The design follows [Bili-SyncPlay](https://github.com/Sky1wu/Bili-SyncPlay) (the Bilibili version). The code was rewritten for YouTube and does not copy the original project's source.

## Layout

- `extension/`: browser extension (Manifest V3, Chrome / Edge 116+), no build step, load it directly
- `server/`: WebSocket room server (Node.js 18+ or Bun)
- `extension-test/`: tests for the in-page sync logic

## Quick Start

### 1. Start the server

With Node.js:

```bash
cd server
npm install
npm start
```

Or with Bun:

```bash
cd server
bun install
bun src/server.js
```

It listens on `ws://localhost:8787` by default.

### 2. Load the extension

1. Open `chrome://extensions` (`edge://extensions` in Edge)
2. Turn on Developer mode
3. Click `Load unpacked` and select the `extension` directory
4. Reload any YouTube tabs that were already open

### 3. Use it

1. Click the extension icon, enter a nickname and click "Create room"
2. Copy the invite (`roomCode:token`) and send it to a friend, who pastes it and clicks "Join room"
3. Open a YouTube video and click "Sync this page's video" in the popup
4. Other members open the same video automatically and start syncing

To use it with friends in other locations, deploy the server at an address everyone can reach, then set the server address in the popup's Settings to `wss://your-domain` (every member has to change it).

## Features

- Rooms: create a room, join by invite, copy the invite, member list
- Sync: play, pause, seek, playback rate; members who join midway start from the room's current position
- Auto-open: when the shared video changes, members' tabs navigate to the new video
- Page notices: member joined/left, shared video changed, play/pause/seek/rate changes
- Local browsing isolation: browsing other videos while in a room stays local and does not affect the room
- Reconnect: a short disconnect keeps your seat and recovers automatically

YouTube-specific handling:

- **Single-page navigation**: listens for `yt-navigate-start` / `yt-navigate-finish` and re-checks whether the new page is the shared video
- **Ads**: while a member is watching an ad, nothing is broadcast or applied; when the ad ends the member catches up with the room without slowing anyone else down
- **Autoplay next**: when the sharer's video ends naturally and YouTube autoplays the next one, the next video is shared with the room (can be turned off in Settings)
- **Live streams**: only play/pause is synced, not position or rate

Supported pages: `youtube.com/watch?v=`, `/shorts/`, `/live/`, and `youtu.be` short links (all normalized to `watch?v=<id>`).

## Server Configuration (environment variables)

| Variable               | Default   | Description                                                                                                                                             |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `8787`    | Listen port                                                                                                                                             |
| `HOST`                 | `0.0.0.0` | Listen address                                                                                                                                          |
| `ALLOWED_ORIGINS`      | empty     | Comma-separated allowed origins, e.g. `chrome-extension://<extension-id>`. When empty, any browser-extension origin is accepted and web page origins are rejected |
| `MAX_MEMBERS_PER_ROOM` | `20`      | Maximum members per room                                                                                                                                |

- Health check: `GET /healthz`
- For a public deployment, set `ALLOWED_ORIGINS` and terminate TLS with an Nginx/Caddy reverse proxy so the extension connects over `wss://`
- Docker: `docker build -t youtube-syncplay-server server && docker run -p 8787:8787 youtube-syncplay-server`
- Rooms live in memory; they are lost when the server restarts and must be created again

## Tests

```bash
cd server
npm test
```

```bash
node extension-test/content-sync.test.mjs
```

(Without Node, replace `npm test` / `node` with `bun test/smoke.mjs` / `bun`.)

## Differences from Bili-SyncPlay

This is a slimmed-down implementation that keeps the core room and sync experience. It does not include the original project's admin console, Redis multi-node support, announcements, Firefox build, or diagnostics panel. The protocol is simplified as well (a connection is bound to a member identity; `memberToken` is used only for reconnecting).

## Known Limitations

- The sync logic is covered by tests against a simulated player; it has not yet been verified end to end on real YouTube pages
- Members-only, age-restricted or region-restricted videos cannot be synced for members who are not allowed to watch them
- Everyone sees different ads; a member watching an ad jumps to the room's current position when the ad ends
- The browser may block autoplay in background tabs, in which case the page asks for a click
- Seeks smaller than about 1.5 seconds are not broadcast (this is how user actions are told apart from sync echoes)

## License

[GPL-3.0](./LICENSE)

## Notice

This project is not affiliated with YouTube or Google.
