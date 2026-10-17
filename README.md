# opengamep2p

**一个玩家做主机，其他玩家从公开大厅点击加入，或凭私密邀请加入。给浏览器游戏加上可复用的 P2P 联机能力，无需自建游戏服务器。**

基于 [Trystero](https://github.com/dmotz/trystero) 建立 WebRTC 连接，参考 [NetplayJS](https://github.com/rameshvarun/netplayjs) 的固定步长、输入驱动和权威状态校正设计。MIT 开源。

> 当前版本：0.2.0。已完成公开房间大厅与主机权威同步，不包含 rollback、客户端预测、主机迁移或断线续局。适合先接入小规模休闲、合作和桌面游戏；高延迟网络下的快速动作游戏需要后续预测与插值。

## “零自建服务器”的准确含义

- **不需要部署房间服务、游戏服务器、数据库或自己的信令服务。** 玩家浏览器运行游戏逻辑；静态文件可部署到 GitHub Pages、itch.io 或任何静态托管。
- 默认利用 Trystero 的公共 Nostr 信令发现其他玩家，使用 STUN 和 WebRTC 建立跨公网连接。联机不局限于同一个局域网。
- “零自建”不等于“不使用任何第三方基础设施”。公共信令和 STUN 有可用性、地域访问及网络限制，没有本框架提供的 SLA。
- 某些 NAT、防火墙和运营商网络无法直连。可配置托管 TURN；此时加密游戏数据会经 TURN 中继，可能产生流量费用。**不配置 TURN 就需要接受部分玩家无法连接，无法保证任意两个公网玩家都能直连。** 见 [Trystero 连接故障说明](https://github.com/dmotz/trystero#troubleshooting-connection-issues)。

## 先运行示例

需要 Node.js 20.19+ 或 22.12+。

```sh
npm ci
npm run dev
```

打开终端打印的地址。一端输入名称，保持“在公开大厅显示”勾选后点击“创建房间”；另一台设备或独立浏览器窗口会在大厅看到房间，点击“加入”即可。取消公开勾选后，仍可通过复制、粘贴邀请代码加入私密房间。用方向键 / WASD 或手机按钮移动。

本地开发服务器只负责提供 HTML/JS，不处理房间或游戏数据。跨网络测试时，把示例发布到双方都能访问的 HTTPS 静态站点：

```sh
npm run build:demo
# 将 demo-dist/ 部署到静态托管
```

用不同设备或独立浏览器上下文测试。Trystero 的 `selfId` 在同一 JavaScript 上下文共享，本框架禁止在该上下文加入自己的房间。

## 最小接入

这个仓库尚未发布到 npm。可以先在仓库中执行 `npm pack`，再在游戏项目中安装生成的 `opengamep2p-0.2.0.tgz`；也可以 `npm install /你的路径/opengamep2p`（先执行 `npm run build`）。下例适用于 Vite 等浏览器打包工具。

```ts
import { createGame } from 'opengamep2p';

type State = { positions: Record<string, { x: number; y: number }> };
type Input = { x: number; y: number };

const game = createGame<State, Input>({
  appId: 'com.example.my-game', // 每个游戏使用唯一命名空间
  initialState: { positions: {} },
  validateInput: (v): v is Input =>
    v !== null && typeof v === 'object' &&
    'x' in v && 'y' in v &&
    typeof v.x === 'number' && typeof v.y === 'number' &&
    Number.isFinite(v.x) && Number.isFinite(v.y) &&
    Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
  update(state, { players, inputs, dt }) {
    const active = new Set(players.map(p => p.id));
    for (const id of Object.keys(state.positions)) {
      if (!active.has(id)) delete state.positions[id];
    }
    for (const player of players) {
      const p = state.positions[player.id] ??= { x: 100, y: 100 };
      const input = inputs.get(player.id) ?? { x: 0, y: 0 };
      p.x += input.x * 100 * dt;
      p.y += input.y * 100 * dt;
    }
    return state;
  },
});

// 创建房间的一端：
const room = await game.host();
console.log(room.invite); // 将完整邀请代码发给朋友

// 加入的一端使用相同游戏配置，改为：
// const room = await game.join(invitation);

room.onState(state => renderGame(state)); // 将状态交给 Canvas / Three.js 等渲染
room.onPlayers(players => renderPlayerList(players));
room.onDisconnect(reason => showRoomEnded(reason));

// 例如每秒 30 次发送当前控制值；松开按键也要发送 { x: 0, y: 0 }。
await room.sendInput({ x: 1, y: 0 });

// 退出并清理资源：
await room.leave();
```

上例中的 `renderGame`、`renderPlayerList` 和 `showRoomEnded` 是你自己的界面函数。完整可运行代码见 [examples/arena.js](examples/arena.js)。每个游戏配置对象同时只允许一个活动房间；退出后可以再次创建或加入。

## 对外 API

| API | 用途 |
| --- | --- |
| `createGame(options)` | 定义游戏状态、规则和输入校验 |
| `await game.host()` | 创建新房间，立即返回主机会话；不会等待朋友加入 |
| `await game.host({ public: true, name })` | 创建并发布公开房间；至少一个 relay 确认发布后返回 |
| `await game.lobby()` | 打开当前游戏与版本的公开房间大厅；同一 game 对象复用大厅 |
| `await game.join(invite)` | 加入邀请指定的主机；完成准入并取得初始快照才返回 |
| `room.invite` | 可分享的完整邀请代码，包含房间随机密钥 |
| `room.id` / `room.isHost` | 本机玩家 ID / 是否主机 |
| `room.state` / `room.players` / `room.tick` | 当前权威状态副本、玩家列表、模拟步编号 |
| `room.connected` | 会话是否有效；主机为 true 不代表已有客机 |
| `await room.sendInput(input)` | 提交本机控制值；客机只发送给主机 |
| `room.onState(fn)` | 立即提供当前状态，之后通知每次更新；返回取消订阅函数 |
| `room.onPlayers(fn)` | 立即提供成员列表，之后通知成员变化；返回取消订阅函数 |
| `room.onDisconnect(fn)` | 会话结束时通知原因；返回取消订阅函数 |
| `room.step()` | `manualTick: true` 时由自己的固定时钟驱动主机模拟 |
| `await room.leave()` | 离开并释放资源，可以重复调用 |

## 公开房间大厅

定义 `game` 后，浏览房间只需：

```ts
const lobby = await game.lobby();
const unsubscribe = lobby.onRooms(rooms => renderRoomList(rooms));

// 主机浏览器：
const room = await game.host({ public: true, name: '一起冒险' });

// 其他玩家浏览器，点击某一项时：
// const room = await game.join(selectedRoom.invite);

// 退出游戏后释放大厅订阅：
await room.leave();
unsubscribe();
await lobby.close();
```

`game.host()` 默认仍创建私密房间，不启动大厅、不发布邀请。示例页面默认勾选公开，调用方通过 `public: true` 明确选择公开。

| 大厅 API / 房间字段 | 用途 |
| --- | --- |
| `lobby.rooms` | 当前列表的副本 |
| `lobby.onRooms(fn)` | 立即提供当前列表，之后在房间、人数或过期变化时通知；返回取消订阅函数 |
| `lobby.close()` | 下架本大厅发布的房间并关闭订阅；游戏会话继续运行 |
| `lobby.closed` | 大厅是否已经关闭；关闭后再次调用 `game.lobby()` 可重新打开 |
| `room.id` | 大厅内唯一标识，绑定发布者和房间 |
| `room.name` | 房间名称，1–80 字符 |
| `room.playerCount` / `room.maxPlayers` | 当前人数 / 人数上限，包含主机 |
| `room.invite` | 点击加入时传给 `game.join()` |
| `room.hostId` / `room.gameVersion` | 游戏主机 ID / 游戏版本 |

大厅通过公共 Nostr relay 的 WebSocket 订阅带签名的房间元数据，**浏览大厅不会建立玩家之间的 WebRTC mesh**。只有实际加入游戏才进入原来的 Trystero 房间。事件签名与过期标记遵循 [Nostr 基础协议](https://github.com/nostr-protocol/nips/blob/master/01.md) 和 [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md)。

- 主机默认每 10 秒发送心跳；加入、离开时发送人数更新。
- 正常退出主动发送下架消息。异常离线或 relay 不可达，最后一条心跳在 35 秒后过期；实际清理还受浏览器计时器调度影响。
- 大厅只显示相同 `appId` 和 `gameVersion` 的房间，默认最多缓存 200 条记录，包括短期下架标记。旧序号不能覆盖新序号，不同签名发布者不能删除原发布者的记录。
- 公开房间的名称、人数及**完整邀请代码（包括房间密钥）会发布到公共 relay**。公开房间允许任何看到它的玩家申请加入；不要在名称里放私人信息。私密房间不会出现在大厅。
- 签名确认元数据来自该发布者，不代表账号认证，也不能证明发布者就是游戏主机本人。列表信息不是可信授权或人数保证，真正加入仍由游戏主机检查人数和版本。
- 这是尽力发现的公开列表，不是保证完整的全球目录。不同 relay 的数据、限流、审核及可用性会影响结果；列表显示不代表双方能成功建立 WebRTC。
- 主机页面在后台受计时器节流时，房间可能暂时从大厅过期消失。关闭大厅会停止心跳，继续运行的游戏会话不会自动重新公开。

需要固定发现节点时，所有玩家使用相同 relay 配置：

```ts
import { nostrDiscovery } from 'opengamep2p';

// 放入 createGame({ ...游戏配置, lobby: { ... } }) 中：
const lobbyOptions = {
  transport: nostrDiscovery({ relayUrls: ['wss://your-selected-public-relay.example'] }),
  heartbeatMs: 10000,
  ttlMs: 35000,
  maxRooms: 200,
};
```

`.example` 是占位地址。大厅与游戏信令默认都选择 Trystero 公布的 relay 列表中的前五个，不需要额外账号，避免大厅可达但游戏使用另一组不可达节点。自定义配置分别通过 `nostrDiscovery()` 与 `trysteroTransport()` 设置；替换游戏 transport 不会自动改变大厅发现策略。两条通路使用的事件类型和协议不同，同一组节点也不保证都允许游戏信令。

`ttlMs` 必须至少为 `heartbeatMs` 的三倍且不超过 120 秒。`maxRooms` 为 1–1000。高级调用方可以通过 `DiscoveryFactory` 替换发现机制；它与游戏 `TransportFactory` 分开，避免发现依赖游戏连接。

`onDisconnect` 原因包括 `left`、`host-left`、`simulation-error`。加入失败通过 `join()` Promise 拒绝报告，包括超时、人数已满、游戏版本不匹配。`onError` 配置回调接收传输、模拟或监听器异常。即使错误监听器抛异常，清理也会继续。

### 可选配置

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `gameVersion` | `'1'` | 修改不兼容游戏规则或数据结构时更新 |
| `tickRate` | `60` | 主机固定模拟频率，1–240 Hz |
| `snapshotRate` | `20` | 权威快照频率，不超过 tickRate |
| `maxPlayers` | `8` | 包括主机的人数上限，最多 64；建议小规模房间 |
| `joinTimeoutMs` | `45000` | 等待主机准入的超时时间 |
| `inputTimeoutMs` | `1000` | 输入超时后从当前控制映射移除 |
| `maxMessageBytes` | `65536` | JSON 协议消息的 UTF-8 字节上限，包括快照 |
| `manualTick` | `false` | 使用自己的固定更新循环 |
| `onError` | 无 | 接收错误以显示提示或记录诊断 |
| `transport` | `trysteroTransport()` | 替换网络适配器 |
| `lobby` | 默认 Nostr 发现配置 | 可选公开房间心跳、TTL、缓存上限与发现适配器 |

状态和输入必须是 JSON 数据：普通对象、数组、有限数字、字符串、布尔值及 null。不能放入类实例、Map、Set、函数、undefined、循环引用或 NaN。整个状态会按快照频率复制及发送，因此应保持紧凑，把纹理、模型等资源留在游戏本地。

`update()` 只在主机执行，`inputs` 是每名玩家最近一次通过校验且未过期的控制值。它不是事件队列：连续发送的离散指令可能被覆盖。客机遇到发送拥塞时最多保留一个在途输入和一个最新待发输入；被更新替代的待发 `sendInput()` 调用会正常完成，但其旧值不会发送，返回的 Promise 也不是主机接收确认。退出时尚未完成的输入调用会拒绝。当前版本适合“移动方向、按键状态”等持续控制；回合指令、聊天和必须逐条确认的操作应在后续可靠命令 API 中实现。

## TURN 与公共信令配置

```ts
import { createGame, trysteroTransport } from 'opengamep2p';

const transport = trysteroTransport({
  // 可选：指定你验证过的公共 Nostr relay，所有玩家配置相同的列表。
  relayConfig: { urls: ['wss://your-selected-public-relay.example'], redundancy: 1 },
  turnConfig: [{
    urls: 'turn:your-provider.example:3478',
    username: 'short-lived-user',
    credential: 'short-lived-credential',
  }],
});
// 在 createGame({ ...游戏配置, transport }) 中使用。
```

上面是字段格式示例，`.example` 地址不可连接。默认无需配置：ICE 优先选择可用的直连路径，直连不可用时使用 TURN 候选。未设置 `turnConfig` 时自动加入 [freeSTUN 公布的公共 TURN](https://freestun.net/)（`turn:freestun.net:3478`，公开账号和密码均为 `free`），无需注册。开发者提供 `turnConfig` 时会替换公共兜底；配置错误或服务不可达时不会再混入公共 TURN。`turnConfig: []` 可关闭公共兜底。公共服务属于尽力而为，尚未验证当前中继可用性及中国—新加坡链路，不保证长期可用。使用托管服务时，不要把长期私有 TURN 密钥提交到公开仓库。适配器也支持 `rtcConfig`，但覆盖 `rtcConfig.iceServers` 时会替换 Trystero 默认 STUN 配置，需自行包含需要的 ICE 服务器。

## 跨运营商 / 跨国家无法加入时

同一 Wi-Fi 下出现“手机能分别加入两台电脑，但两台电脑互相加入失败”时，先比较实际路径。手机成功不代表使用了局域网；它也可能通过 NAT 直连或 TURN。示例页面新增“连接诊断”，显示收到对端描述与否、ICE 状态、双方 host / srflx / prflx / relay 候选数量、mDNS 候选数量及实际选中路径。失败后保留诊断，可点击复制；报告不包含 IP、SDP、邀请代码或 TURN 凭据。

手机创建房间时，两台电脑只需分别连上手机，游戏就能同步；电脑间的额外连接即使失败，也不阻止游戏准入。换成电脑 A 创建房间，电脑 B 必须连上 A，手机作为普通客机不会替它转发握手或游戏消息。因此“手机建房三人能玩、电脑建房另一台电脑进不来”不能证明电脑间连接已经可用，也不能单凭建房角色断定是角色握手错误。

- **自动**：允许全部候选，由浏览器 ICE 优先探测本机地址、NAT 直连和 TURN。标准的候选类型优先级见 [RFC 8445 §5.1.2](https://www.rfc-editor.org/rfc/rfc8445.html#section-5.1.2)。候选收集及连通性检查会重叠进行，不是三个串行超时阶段；应用不能保证浏览器始终选中某个接口。
- **仅本机候选**：禁用 STUN / TURN，检查本机地址能否互通；仍需要信令。host 候选也可能是可公网路由的 IPv6，因此 `host-direct` 表示本机候选直连，并不证明处于同一 Wi-Fi。
- **仅 TURN**：强制使用中继，检查 TURN 是否可用；只有实际出现 relay 候选并选中中继路径，才能确认使用了 TURN。

排查时两端选择同一模式后重新建房。已有连接尝试后切换模式，示例会刷新页面以清除 Trystero 跨房间复用的连接。没有收到对端描述时先查信令；收到描述但 ICE 失败时，再比较候选交换、mDNS 解析、系统防火墙、VPN/虚拟网卡和浏览器策略。仅凭 mDNS 候选存在不能断言 mDNS 故障。

接入自己的游戏时，可用 `trysteroTransport({ onDiagnostics: report => console.log(report) })` 获取同样的本地诊断，每秒更新一次并在退出时停止。默认不启用监测；连接选择逻辑不受监测影响。

默认加入等待为 45 秒，为公共信令发现及 ICE 协商留出时间；可通过 `joinTimeoutMs` 修改。超时报错中的 `host-not-connected` 表示还没有连接到邀请中的主机，`host-admission-timeout` 表示数据通道已连接但没有收到有效的游戏准入。延长等待不保证解决信令或 ICE 失败。同一 Wi-Fi 仍需要双方访问相同的公共信令节点。

`could not connect ... after exchanging SDP` 表示双方已交换连接信息，但 ICE 未建立连接。可能与 NAT、UDP 防火墙、STUN 或候选地址可达性有关；不能从这个报错确定是某个国家或运营商的固定限制。

| 服务 | 作用 | 是否转发游戏数据 |
| --- | --- | --- |
| 信令 relay | 让双方发现彼此、交换连接信息 | 不转发游戏数据 |
| STUN | 帮助浏览器获取公网地址、尝试直连 | 不转发游戏数据 |
| TURN | 直连失败时中转两端的加密数据 | 转发数据，但不运行游戏逻辑 |

TURN 不是每次联机都必须使用。默认优先尝试直连；某些网络组合必须借助中继才能联机。更换 STUN 有时能改善发现，但不能替代必须中继时的 TURN。托管 TURN 仍符合“零自建服务器”，但中继会消耗服务商资源，不代表所有游戏流量永远零服务器成本。

示例无需填写环境变量即可使用默认公共 TURN。需要替换为开发者的 TURN 时：

```sh
cp .env.example .env.local
```

在 `.env.local` 填入**服务商实际提供的地址和短期凭据**，例如以下占位格式：

```dotenv
VITE_TURN_URLS=turn:provider.example:3478?transport=udp,turns:provider.example:443?transport=tcp
VITE_TURN_USERNAME=temporary-user
VITE_TURN_CREDENTIAL=temporary-credential
VITE_ICE_TRANSPORT_POLICY=all
```

`.example` 不能用于真实连接，服务商不支持的端口也不能自行添加。优先包含服务商支持的 UDP、TCP 及 TLS 地址；TLS 443 有助于某些限制 UDP 的网络，但仍需确认中国与新加坡两端实际可达。

修改后重启 `npm run dev`；部署静态示例时重新运行 `npm run build:demo` 并发布 `demo-dist/`，让两端都使用更新后的页面。配置自定义 TURN 时，双方都应使用有效凭据，凭据可以不同。临时设置 `VITE_ICE_TRANSPORT_POLICY=relay` 可强制使用 TURN 做诊断（未填自定义 TURN 时测试默认公共服务）；确认可用后改回 `all`，允许直连。

`VITE_*` 会进入浏览器包。`.env.local` 已忽略，但这不使打包后的凭据保密；这里的静态配置只适合短期凭据测试。生产环境应通过受信任的服务端/托管接口签发并更新短期 TURN 凭据，不要把永久 API 密钥放在浏览器中。本库不会自动创建 TURN 账号或保证跨境网络可达性。

默认配置已接入公开 TURN 地址；配置优先级经自动测试验证，实际公共中继及中国—新加坡链路仍需公网实测。ICE 会同时收集直连和中继候选，优先选择可用的直连；不是等待一次连接彻底失败后再发起第二轮连接。

## 同步设计与边界

1. 主机生成随机房间 ID 和 128 位随机密钥，邀请绑定主机 peer ID 与游戏 appId。
2. Trystero 通过公共信令交换 WebRTC 连接信息。密码用于保护信令协商。
3. 客机向邀请中的主机申请加入；主机检查版本、人数，发送当前状态及成员名单。
4. 客机只提交自己的输入。主机按固定 `dt` 运行 `update()`，广播包含 tick 的权威快照。
5. 客机用快照渲染，不执行模拟；忽略其他客机伪造的状态和旧 tick。主机忽略未准入玩家及重复输入序号。
6. 主机离线后结束房间；客机离线后移除对应成员与输入。再次加入需要新的连接，会获得最新状态。

传输协议在游戏层是主机与客机通信，但 Trystero 默认发现策略仍可能建立玩家之间的完整 WebRTC mesh。因此主机/客机架构不等于底层只建立星形连接；人数上限也不会阻止未准入的 WebRTC 连接先建立。

游戏层仅校验消息、身份、输入与大小，不提供账号认证、主机反作弊或抗拒绝服务保证。拿到邀请的玩家可申请加入；主机控制游戏逻辑。消息字节上限在传输重组完成后校验，不是网络层的内存配额。适合朋友联机与可信小房间。

每个客机独立限制为一个在途快照：某条连接拥塞时仅跳过发往该客机的中间帧，其他玩家继续接收更新；该连接恢复后发送当前状态，不补发全部旧帧。客机输入同样合并为最新待发状态，避免堆积过期按键。浏览器已缓存的网络数据仍可能带来延迟，这不是带宽或时延保证。

示例对客机位置做显示层平滑，减轻默认 20 Hz 快照直接跳动的观感；它不修改权威状态，也不包含客户端预测。平滑有约数十毫秒的跟随延迟，不能修复高 RTT 或丢包。后台标签页会受到浏览器计时器节流，固定 `dt` 不代表浏览器永远保持真实时间的 60 Hz；应提示玩家让主机页面保持前台。

## 开发与测试

```sh
npm run check          # TypeScript 编译 + 逻辑/协议测试
npm run build:demo     # 静态示例构建
npx playwright install chromium # 首次安装测试浏览器，macOS 也可使用已安装的 Chrome
npm run test:browser   # 真实 Trystero + WebRTC 的三浏览器集成测试
TEST_BROWSER_DEFAULT_NETWORK=1 npm run test:browser # 使用浏览器默认网络/mDNS 行为（POSIX shell）
npm pack --dry-run     # 检查库发布文件
```

协议测试覆盖公开/私密房间、晚发现、人数更新、TTL、签名校验、下架、防旧消息覆盖及 relay 重连。发现传输测试使用真实密码学和内存 WebSocket，不需要监听端口。

浏览器集成脚本通过本地测试 Nostr relay 和真实 WebRTC 检查三名玩家、公开大厅、晚加入、人数同步、下架、示例页面点击加入与信令不携带游戏状态。测试 relay 只存在于 `tests/browser.mjs`，不参与产品运行。它验证本机网络连接，不证明所有公网 NAT 组合可用；正式发布前应使用不同运营商和设备补充公网测试。

CI 包含编译、协议测试、示例构建、浏览器集成及打包检查。本次本机验证已通过三浏览器集成，包括浏览器默认网络/mDNS 模式；测试使用本地信令节点，不能替代两台实体 PC 或公共信令、不同运营商网络的实测。

## 开源发布

已提供 MIT LICENSE、依赖锁文件和 GitHub Actions 配置；未创建远程仓库、未发布 npm 包。选择目标 GitHub 仓库后提交并推送源码即可。发布前确认包名可用，再补充 `repository`、作者和发布信息。

后续演进顺序：公网网络矩阵与连接诊断 → 插值 / 客户端预测 → 可靠命令 API → 确定性 lockstep / rollback → 主机迁移。各阶段保持 `host / join / sendInput / onState` 基础 API 稳定，不用一次性让调用方理解全部网络机制。
