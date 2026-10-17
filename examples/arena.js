import { createGame, nostrDiscovery, trysteroTransport } from '../src/index.ts';
import { networkConfig, networkErrorMessage, connectionModeOptions } from './network-config.mjs';

const $ = id => document.getElementById(id);
const keys = new Set();
let connection;
try { connection = networkConfig(import.meta.env); }
catch (error) {
  $('message').textContent = networkErrorMessage(error);
  $('status').textContent = '网络配置错误';
  $('host').disabled = $('join').disabled = true;
  throw error;
}
const { relayUrl, options: connectionOptions } = connection;
$('connection-mode').value = connectionOptions.rtcConfig?.iceTransportPolicy === 'relay' ? 'relay' : 'auto';
try {
  const savedMode = sessionStorage.getItem('ogp-connection-mode');
  if (['auto', 'lan', 'relay'].includes(savedMode)) $('connection-mode').value = savedMode;
} catch { /* Storage is optional. */ }
let networkStarted = false;
$('connection-mode').onchange = () => {
  try { sessionStorage.setItem('ogp-connection-mode', $('connection-mode').value); }
  catch { $('message').textContent = '切换模式后请刷新页面并重新选择，以清理上次连接。'; return; }
  // Trystero reuses live PCs across rooms. A new mode must use fresh PCs.
  if (networkStarted) location.reload();
};
let diagnosticReport;
function showDiagnostics(report) {
  diagnosticReport = { browser: navigator.userAgent, secureContext: isSecureContext,
    mode: $('connection-mode').value, ...report };
  const counts = c => `host ${c.host}（mDNS ${c.mdns}）/ srflx ${c.srflx} / prflx ${c.prflx} / relay ${c.relay}`;
  const paths = { 'host-direct': '本机候选直连', 'nat-direct': 'NAT 直连', relay: 'TURN 中继' };
  $('diagnostics').textContent = report.connections.map(pc =>
    `连接 ${pc.id}：${paths[pc.path] ?? '尚未选中路径'}\n` +
    `连接状态 ${pc.connectionState} / ICE ${pc.iceConnectionState}\n` +
    `收到对端描述：${pc.remoteDescription ? '是' : '否'}\n` +
    `本端：${counts(pc.local)}\n对端：${counts(pc.remote)}` +
    (pc.roundTripTimeMs === undefined ? '' : `\n往返延迟：${pc.roundTripTimeMs} ms`)).join('\n\n') || '等待浏览器创建连接…';
}
$('copy-diagnostics').onclick = async () => {
  if (!diagnosticReport) return;
  const text = JSON.stringify(diagnosticReport, null, 2);
  try { await navigator.clipboard.writeText(text); $('message').textContent = '连接诊断已复制'; }
  catch { $('diagnostics').textContent = text; $('message').textContent = '请选中并复制下方连接诊断'; }
};
let session, state = { positions: {} }, self = '', pending = false, publicRooms = [], lobby, openingLobby = false;
const game = createGame({
  appId: 'org.opengamep2p.arena.v1',
  transport: args => {
    networkStarted = true;
    return trysteroTransport({
      ...connectionModeOptions(connectionOptions, $('connection-mode').value), onDiagnostics: showDiagnostics,
    })(args);
  },
  lobby: relayUrl ? { transport: nostrDiscovery({ relayUrls: [relayUrl] }) } : undefined,
  initialState: { positions: {} },
  validateInput: v => v !== null && typeof v === 'object' &&
    Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
  update(state, { players, inputs, dt }) {
    const live = new Set(players.map(p => p.id));
    for (const id of Object.keys(state.positions)) if (!live.has(id)) delete state.positions[id];
    players.forEach((player, index) => {
      const p = state.positions[player.id] ??= { x: 180 + (index % 4) * 80, y: 220 + Math.floor(index / 4) * 80 };
      const input = inputs.get(player.id) ?? { x: 0, y: 0 };
      const scale = Math.max(1, Math.hypot(input.x, input.y));
      p.x = Math.max(20, Math.min(580, p.x + input.x / scale * 180 * dt));
      p.y = Math.max(20, Math.min(580, p.y + input.y / scale * 180 * dt));
    });
    return state;
  },
  onError: error => { console.error('[opengamep2p] transport/session error', error); $('message').textContent = networkErrorMessage(error); },
});

function controls(connected) {
  $('host').disabled = connected || pending; $('join').disabled = connected || pending;
  $('leave').disabled = !connected; $('copy').disabled = !connected;
  $('invite').readOnly = connected;
  $('room-name').disabled = connected || pending;
  $('public-room').disabled = connected || pending;
  $('connection-mode').disabled = connected || pending;
  renderRooms();
}
async function connect(host) {
  if (pending) return;
  pending = true; controls(false); $('message').textContent = ''; $('status').textContent = '正在连接…';
  diagnosticReport = undefined; $('diagnostics').textContent = '等待连接诊断…';
  renderedPositions.clear();
  try {
    session = host ? await game.host({ public: $('public-room').checked, name: $('room-name').value }) : await game.join($('invite').value);
    self = session.id; $('invite').value = session.invite;
    $('status').textContent = session.isHost ? `已连接 · ${$('public-room').checked ? '公开主机' : '私密主机'}` : '已连接 · 客机';
    session.onState(value => { state = value; });
    session.onPlayers(players => { $('players').textContent = `${players.length} / 8 玩家`; });
    session.onDisconnect(reason => {
      session = undefined; state = { positions: {} }; keys.clear();
      $('status').textContent = reason === 'left' ? '已离开房间' : '房间已结束'; controls(false);
    });
  } catch (error) { console.error('[opengamep2p] join/host failed', error); $('message').textContent = networkErrorMessage(error); $('status').textContent = '连接失败'; }
  finally { pending = false; controls(!!session?.connected); }
}
$('host').onclick = () => connect(true);
function renderRooms() {
  const container = $('rooms'); container.replaceChildren();
  if (!publicRooms.length) {
    const empty = document.createElement('p'); empty.className = 'muted';
    empty.textContent = lobby ? '暂无公开房间，创建一个邀请大家加入吧。' : '大厅尚未连接，你仍可通过邀请加入房间。';
    container.append(empty); return;
  }
  for (const room of publicRooms) {
    const card = document.createElement('div'); card.className = 'room-card';
    const info = document.createElement('div'), name = document.createElement('h3'), detail = document.createElement('p');
    name.textContent = room.name; detail.textContent = `${room.playerCount} / ${room.maxPlayers} 玩家`;
    info.append(name, detail);
    const join = document.createElement('button'), own = session?.id === room.hostId, full = room.playerCount >= room.maxPlayers;
    join.textContent = own ? '我的房间' : full ? '已满' : '加入';
    join.disabled = own || full || pending || !!session?.connected;
    join.onclick = () => { $('invite').value = room.invite; void connect(false); };
    card.append(info, join); container.append(card);
  }
}
async function openLobby() {
  if (openingLobby || (lobby && !lobby.closed)) return;
  openingLobby = true; $('retry-lobby').disabled = true; $('lobby-status').textContent = '正在连接大厅…';
  try {
    lobby = await game.lobby();
    lobby.onRooms(rooms => { publicRooms = rooms; renderRooms(); });
    $('lobby-status').textContent = '大厅已打开 · 房间自动更新';
  } catch (error) { $('lobby-status').textContent = `大厅连接失败：${error.message}`; renderRooms(); }
  finally { openingLobby = false; $('retry-lobby').disabled = !!lobby && !lobby.closed; }
}
$('retry-lobby').onclick = () => { void openLobby(); };
void openLobby();
$('join').onclick = () => connect(false);
$('leave').onclick = async () => { await session?.leave(); };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(session.invite); $('message').textContent = '邀请已复制'; }
  catch { $('invite').select(); $('message').textContent = '请手动复制邀请代码'; }
};
const controlKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd']);
addEventListener('keydown', event => {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  if (controlKeys.has(event.key)) { event.preventDefault(); keys.add(event.key); }
});
addEventListener('keyup', event => keys.delete(event.key));
addEventListener('blur', () => keys.clear());
document.querySelectorAll('[data-key]').forEach(button => {
  button.onpointerdown = event => { button.setPointerCapture(event.pointerId); keys.add(button.dataset.key); };
  button.onpointerup = button.onpointercancel = () => keys.delete(button.dataset.key);
});
setInterval(() => {
  if (!session?.connected) return;
  const held = (...names) => names.some(name => keys.has(name)) ? 1 : 0;
  session.sendInput({ x: held('ArrowRight', 'd') - held('ArrowLeft', 'a'), y: held('ArrowDown', 's') - held('ArrowUp', 'w') })
    .catch(error => { $('message').textContent = networkErrorMessage(error); });
}, 1000 / 30);

const ctx = $('arena').getContext('2d');
const colors = ['#a2f3ba', '#7fc6ff', '#ffc785', '#d2abff', '#ff9eaf', '#84e1d5', '#e5e384', '#9daaff'];
const renderedPositions = new Map();
let lastDrawAt = performance.now();
function draw() {
  const now = performance.now();
  const blend = 1 - Math.exp(-Math.max(0, now - lastDrawAt) / 35);
  lastDrawAt = now;
  ctx.fillStyle = '#0b1521'; ctx.fillRect(0, 0, 600, 600);
  ctx.strokeStyle = '#1b2a3c'; ctx.lineWidth = 1;
  for (let n = 30; n < 600; n += 30) { ctx.beginPath(); ctx.moveTo(n, 0); ctx.lineTo(n, 600); ctx.moveTo(0, n); ctx.lineTo(600, n); ctx.stroke(); }
  for (const id of renderedPositions.keys()) if (!state.positions[id]) renderedPositions.delete(id);
  Object.entries(state.positions).forEach(([id, target], index) => {
    // Smooth the guest's 20 Hz snapshots at display refresh rate. Authoritative
    // positions remain untouched; new players and teleports snap immediately.
    let p = renderedPositions.get(id);
    if (!p || session?.isHost || Math.hypot(target.x - p.x, target.y - p.y) > 120) {
      p = { ...target }; renderedPositions.set(id, p);
    } else { p.x += (target.x - p.x) * blend; p.y += (target.y - p.y) * blend; }
    if (id === self) { ctx.strokeStyle = '#a2f3ba'; ctx.beginPath(); ctx.arc(p.x, p.y, 23, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = colors[index % colors.length]; ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#cfdeed'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(id === self ? '你' : `玩家 ${index + 1}`, p.x, p.y + 40);
  });
  requestAnimationFrame(draw);
}
draw();
