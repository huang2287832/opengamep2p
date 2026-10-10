import { createGame, nostrDiscovery, trysteroTransport } from '../src/index.ts';
import { networkConfig, networkErrorMessage } from './network-config.mjs';

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
let session, state = { positions: {} }, self = '', pending = false, publicRooms = [], lobby, openingLobby = false;
const game = createGame({
  appId: 'org.opengamep2p.arena.v1',
  transport: trysteroTransport(connectionOptions),
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
  onError: error => { $('message').textContent = networkErrorMessage(error); },
});

function controls(connected) {
  $('host').disabled = connected || pending; $('join').disabled = connected || pending;
  $('leave').disabled = !connected; $('copy').disabled = !connected;
  $('invite').readOnly = connected;
  $('room-name').disabled = connected || pending;
  $('public-room').disabled = connected || pending;
  renderRooms();
}
async function connect(host) {
  if (pending) return;
  pending = true; controls(false); $('message').textContent = ''; $('status').textContent = '正在连接…';
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
  } catch (error) { $('message').textContent = networkErrorMessage(error); $('status').textContent = '连接失败'; }
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
function draw() {
  ctx.fillStyle = '#0b1521'; ctx.fillRect(0, 0, 600, 600);
  ctx.strokeStyle = '#1b2a3c'; ctx.lineWidth = 1;
  for (let n = 30; n < 600; n += 30) { ctx.beginPath(); ctx.moveTo(n, 0); ctx.lineTo(n, 600); ctx.moveTo(0, n); ctx.lineTo(600, n); ctx.stroke(); }
  Object.entries(state.positions).forEach(([id, p], index) => {
    if (id === self) { ctx.strokeStyle = '#a2f3ba'; ctx.beginPath(); ctx.arc(p.x, p.y, 23, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = colors[index % colors.length]; ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#cfdeed'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(id === self ? '你' : `玩家 ${index + 1}`, p.x, p.y + 40);
  });
  requestAnimationFrame(draw);
}
draw();
