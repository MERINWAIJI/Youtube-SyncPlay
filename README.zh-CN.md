# YouTube SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

“浏览器扩展 + WebSocket 服务端”的 YouTube 同步观影工具。创建或加入房间，分享当前视频，房间成员之间同步播放、暂停、跳转和倍速。

设计思路参考了 [Bili-SyncPlay](https://github.com/Sky1wu/Bili-SyncPlay)（哔哩哔哩版），代码为针对 YouTube 重新编写，未复制原项目源码。

## 目录

- `extension/`：浏览器扩展（Manifest V3，Chrome / Edge 116+），无需构建，直接加载
- `server/`：WebSocket 房间服务器（Node.js 18+ 或 Bun）
- `extension-test/`：页面同步逻辑测试

## 快速开始

### 1. 启动服务器

用 Node.js：

```bash
cd server
npm install
npm start
```

或用 Bun：

```bash
cd server
bun install
bun src/server.js
```

默认监听 `ws://localhost:8787`。

### 2. 加载扩展

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”，选择 `extension` 目录
4. 已经打开的 YouTube 标签页需要刷新一次

### 3. 使用

1. 点击扩展图标，填写昵称，点“创建房间”
2. 复制邀请串（`房间号:令牌`）发给朋友，对方粘贴后点“加入房间”
3. 打开一个 YouTube 视频，在弹窗中点“同步当前页视频”
4. 其他成员会自动打开同一视频并进入同步

和朋友异地使用时，需要把服务器部署到双方都能访问的地址，并在弹窗“设置”里把服务器地址改成 `wss://你的域名`（双方都要改）。

Windows 上可以直接双击根目录的 `start-server.bat`：它会启动服务器、用 cloudflared 开一条临时隧道，并显示可填入扩展的 `wss://` 地址（需要已安装 Node.js 或 Bun，以及 cloudflared）。临时隧道的地址每次启动都会变。

## 功能

- 房间：创建房间、邀请串加入、复制邀请串、成员列表
- 同步：播放、暂停、跳转、倍速；中途加入的成员从房间当前进度开始
- 自动打开：共享视频变更时，成员的标签页自动跳转到新视频
- 页面提示：成员加入/离开、共享视频变更、播放/暂停/跳转/倍速变化
- 本地浏览隔离：在房间里浏览其他视频只在本地生效，不会影响房间
- 断线重连：短暂掉线会保留席位，自动恢复

针对 YouTube 的处理：

- **单页应用导航**：监听 `yt-navigate-start` / `yt-navigate-finish`，切换视频时重新判断是否为共享视频
- **广告**：某位成员播放广告期间不广播也不应用状态，广告结束后自动追上房间进度，不会拖慢其他人
- **自动连播**：分享者的视频自然播完并自动播放下一个时，自动把下一个视频同步给房间（可在设置中关闭）
- **直播**：只同步播放/暂停，不同步进度和倍速

支持的页面：`youtube.com/watch?v=`、`/shorts/`、`/live/`，以及 `youtu.be` 短链（统一归一化为 `watch?v=<id>`）。

## 服务器配置（环境变量）

| 变量                   | 默认值    | 说明                                                                 |
| ---------------------- | --------- | -------------------------------------------------------------------- |
| `PORT`                 | `8787`    | 监听端口                                                             |
| `HOST`                 | `0.0.0.0` | 监听地址                                                             |
| `ALLOWED_ORIGINS`      | 空        | 逗号分隔的允许来源，如 `chrome-extension://<扩展ID>`。留空时接受任意浏览器扩展来源、拒绝普通网页来源 |
| `MAX_MEMBERS_PER_ROOM` | `20`      | 每个房间人数上限                                                     |

- 健康检查：`GET /healthz`
- 公网部署建议设置 `ALLOWED_ORIGINS`，并用 Nginx/Caddy 反向代理做 TLS，让扩展通过 `wss://` 连接
- Docker：`docker build -t youtube-syncplay-server server && docker run -p 8787:8787 youtube-syncplay-server`
- 房间保存在内存中，服务器重启后房间失效，需要重新创建

## 测试

```bash
cd server
npm test
```

```bash
node extension-test/content-sync.test.mjs
```

（没有 Node 时把 `npm test` / `node` 换成 `bun test/smoke.mjs` / `bun`。）

## 与 Bili-SyncPlay 的差异

这是一个精简实现，保留了核心的房间与同步体验，没有包含原项目的：管理后台、Redis 多节点、运营公告、Firefox 构建、诊断面板。协议也做了简化（连接绑定成员身份，`memberToken` 仅用于重连）。

## 已知限制

- 同步逻辑目前由基于模拟播放器的测试覆盖，尚未在真实 YouTube 页面上做端到端验证
- 会员专享、年龄限制或地区限制的视频，无权观看的成员无法同步
- 每个人看到的广告不同，看广告的成员会在广告结束后跳到房间当前进度
- 浏览器可能阻止后台标签页自动播放，此时页面会提示点击一下
- 小于约 1.5 秒的微小跳转不会广播（用于区分用户操作和同步回声）

## 许可证

[GPL-3.0](./LICENSE)

## 说明

本项目与 YouTube / Google 无关联。
