const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ---------- Campeones y estadísticas reales (Data Dragon) ----------
let champs = [], list = [];
(async function load() {
  try {
    const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
    const d = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/es_MX/champion.json`)).json();
    champs = Object.values(d.data).map(c => ({
      name: c.name, title: c.title, tags: c.tags, stats: c.stats,
      icon: `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${c.image.full}`,
      img: `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${c.id}_0.jpg`
    }));
    list = champs.map(c => ({ name: c.name, icon: c.icon, img: c.img }));
    console.log(`${champs.length} campeones cargados (v${v})`);
  } catch (e) { console.error('Data Dragon falló:', e.message); setTimeout(load, 5000); }
})();
app.get('/api/champs', (q, r) => (list.length ? r.json(list) : r.status(503).end()));

// ---------- Motor de combate ----------
const DMG = 1.8;                       // escala global para que los combates duren ~15 turnos
const CD = { spell: 1, ult: 4, guard: 2 };
const ARCH = { Mage: { sp: 1.45 }, Assassin: { ult: 1.25, crit: 0.12 }, Marksman: { ad: 1.15 },
               Tank: { guard: 0.35 }, Fighter: { ad: 1.05, sp: 1.05 }, Support: { heal: 1.5 } };

function build(c, lvl) {
  const L = lvl - 1, s = c.stats, k = { ad: 1, sp: 1, ult: 1, crit: 0, guard: 0.45, heal: 1 };
  c.tags.forEach(t => {
    const m = ARCH[t] || {};
    for (const key in m) {
      if (key === 'crit') k.crit += m[key];
      else if (key === 'guard') k.guard = Math.min(k.guard, m[key]);
      else k[key] *= m[key];
    }
  });
  const hp = Math.round(s.hp + s.hpperlevel * L);
  return {
    name: c.name, title: c.title, img: c.img, tags: c.tags, k,
    maxhp: hp, hp,
    ad: Math.round(s.attackdamage + s.attackdamageperlevel * L),
    ar: Math.round(s.armor + s.armorperlevel * L),
    mr: Math.round(s.spellblock + s.spellblockperlevel * L),
    as: +(s.attackspeed * (1 + s.attackspeedperlevel * L / 100)).toFixed(2),
    ms: s.movespeed,
    regen: Math.round((s.hpregen + s.hpregenperlevel * L) * 3),
    cd: { spell: 0, ult: 0, guard: 0 }, guard: false
  };
}
const pub = ({ k, regen, ...f }) => f;

function act(r, id, kind) {
  if (r.phase !== 'battle' || r.order[r.turn] !== id) return false;
  if (!['attack', 'spell', 'ult', 'guard'].includes(kind)) return false;
  const me = r.f[id], foeId = r.order.find(x => x !== id), foe = r.f[foeId];
  if (kind !== 'attack' && me.cd[kind] > 0) return false;

  me.guard = false;
  me.hp = Math.min(me.maxhp, me.hp + me.regen);
  const fx = [], lv = r.level;
  let blocked = false;
  const hit = (raw, res, crit) => {
    let d = raw * 100 / (100 + res) * DMG;
    if (foe.guard) { d *= foe.k.guard; foe.guard = false; blocked = true; fx.push({ t: foeId, k: 'guard' }); }
    d = Math.max(1, Math.round(d));
    foe.hp = Math.max(0, foe.hp - d);
    fx.push({ t: foeId, k: 'dmg', n: d, crit: !!crit });
    return d;
  };
  let text;
  if (kind === 'attack') {
    const hits = Math.random() < Math.min(0.5, Math.max(0, (me.as - 0.6) * 0.5)) ? 2 : 1;
    let total = 0, anyCrit = false;
    for (let i = 0; i < hits; i++) {
      const crit = Math.random() < 0.1 + me.k.crit; anyCrit = anyCrit || crit;
      total += hit(me.ad * me.k.ad * (0.9 + Math.random() * 0.2) * (crit ? 1.75 : 1), foe.ar, crit);
    }
    text = `${me.name} golpea${hits > 1 ? ' dos veces' : ''}${anyCrit ? ' (¡crítico!)' : ''} y causa ${total}.`;
  } else if (kind === 'spell') {
    const d = hit((35 + 11 * lv + me.ad * 0.7 + me.maxhp * 0.04) * me.k.sp, foe.mr);
    text = `${me.name} lanza un hechizo y causa ${d}.`;
  } else if (kind === 'ult') {
    const d = hit((60 + 18 * lv + me.ad * 1.6 + me.maxhp * 0.06) * me.k.ult, (foe.ar + foe.mr) / 2);
    const h = Math.min(me.maxhp - me.hp, Math.round(d * 0.15));
    me.hp += h; if (h) fx.push({ t: id, k: 'heal', n: h });
    text = `¡${me.name} libera su definitiva! Causa ${d} y recupera ${h}.`;
  } else {
    const h = Math.min(me.maxhp - me.hp, Math.round(me.maxhp * 0.08 * me.k.heal));
    me.guard = true; me.hp += h; fx.push({ t: id, k: 'heal', n: h });
    text = `${me.name} se cubre y recupera ${h}.`;
  }
  if (blocked) text += ' (golpe amortiguado)';

  for (const key in me.cd) if (key !== kind && me.cd[key] > 0) me.cd[key]--;
  if (CD[kind]) me.cd[kind] = CD[kind];

  r.seq++; r.fx = fx; r.by = id;
  r.log.push({ by: id, text }); if (r.log.length > 40) r.log.shift();
  if (foe.hp <= 0) { r.phase = 'over'; r.winner = id; r.reason = 'ko'; }
  else r.turn = 1 - r.turn;
  return true;
}

function step(r, id, kind) {
  if (!act(r, id, kind)) return;
  push(r);
  if (r.phase === 'battle' && r.p[r.order[r.turn]]?.bot) setTimeout(() => botMove(r), 1400);
}
function botMove(r) {
  if (r.phase !== 'battle') return;
  const id = r.order[r.turn];
  if (!r.p[id]?.bot) return;
  const m = r.f[id], c = m.cd;
  let k = 'attack';
  if (c.guard === 0 && m.hp < m.maxhp * 0.35 && Math.random() < 0.6) k = 'guard';
  else if (c.ult === 0 && Math.random() < 0.8) k = 'ult';
  else if (c.spell === 0 && Math.random() < 0.7) k = 'spell';
  step(r, id, k);
}

// ---------- Salas ----------
const rooms = {};
const newCode = () => { let c; do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms[c]); return c; };
const rnd = () => Math.floor(Math.random() * champs.length);

function view(r, id) {
  const inB = r.phase !== 'pick';
  const foeId = inB ? r.order.find(x => x !== id) : Object.keys(r.p).find(x => x !== id);
  const v = {
    code: r.code, phase: r.phase, me: id, host: r.host === id, level: r.level,
    seq: r.seq, by: r.by, fx: r.fx, log: r.log,
    mine: { pick: r.p[id].pick, ready: r.p[id].ready },
    foe: foeId ? { name: r.names[foeId], ready: !!r.p[foeId]?.ready } : null,
    anyReady: Object.values(r.p).some(x => x.ready && !x.bot)
  };
  if (inB) {
    v.foeId = foeId; v.turn = r.order[r.turn]; v.winner = r.winner; v.reason = r.reason;
    v.f = {}; for (const i in r.f) v.f[i] = pub(r.f[i]);
  }
  return v;
}
const push = r => Object.keys(r.p).forEach(id => { if (!r.p[id].bot) io.to(id).emit('state', view(r, id)); });

function startBattle(r) {
  const ids = Object.keys(r.p);
  r.f = {}; ids.forEach(i => (r.f[i] = build(champs[r.p[i].pick], r.level)));
  const [a, b] = ids;
  r.order = r.f[a].ms > r.f[b].ms ? [a, b] : r.f[a].ms < r.f[b].ms ? [b, a] : (Math.random() < 0.5 ? [a, b] : [b, a]);
  r.turn = 0; r.phase = 'battle'; r.winner = null; r.reason = null; r.seq = 0; r.fx = []; r.by = null;
  r.log = [{ by: null, text: `${r.f[r.order[0]].name} es más rápido y empieza el combate.` }];
  push(r);
  if (r.p[r.order[0]].bot) setTimeout(() => botMove(r), 1600);
}

io.on('connection', socket => {
  let room = null;
  const add = (r, name) => {
    r.p[socket.id] = { pick: null, ready: false };
    r.names[socket.id] = (String(name || '').trim().slice(0, 16)) || 'Invocador';
    room = r; socket.join(r.code);
  };

  socket.on('create', ({ name, bot }) => {
    if (!champs.length) return socket.emit('err', 'Campeones cargando, intenta en unos segundos.');
    const code = newCode();
    const nr = { code, host: socket.id, phase: 'pick', level: 11, p: {}, names: {}, f: null, order: [], turn: 0, seq: 0, fx: [], by: null, log: [], winner: null, reason: null };
    rooms[code] = nr;
    add(nr, name);
    if (bot) { nr.p.BOT = { pick: rnd(), ready: true, bot: true }; nr.names.BOT = 'Bot'; }
    push(nr);
  });

  socket.on('join', ({ code, name }) => {
    const r = rooms[String(code || '').trim().toUpperCase()];
    if (!r) return socket.emit('err', 'Esa sala no existe.');
    if (r.phase !== 'pick' || Object.keys(r.p).length >= 2) return socket.emit('err', 'La sala está llena o ya empezó.');
    add(r, name); push(r);
  });

  socket.on('level', n => {
    const r = room;
    if (!r || r.host !== socket.id || r.phase !== 'pick' || Object.values(r.p).some(x => x.ready && !x.bot)) return;
    r.level = Math.max(1, Math.min(18, Number(n) || 11)); push(r);
  });
  socket.on('pick', i => {
    const r = room;
    if (!r || r.phase !== 'pick' || r.p[socket.id].ready || !champs[i]) return;
    r.p[socket.id].pick = i; push(r);
  });
  socket.on('ready', () => {
    const r = room;
    if (!r || r.phase !== 'pick' || r.p[socket.id].pick == null) return;
    r.p[socket.id].ready = true;
    const ps = Object.values(r.p);
    if (ps.length === 2 && ps.every(x => x.ready)) startBattle(r); else push(r);
  });
  socket.on('unready', () => {
    const r = room;
    if (!r || r.phase !== 'pick') return;
    r.p[socket.id].ready = false; push(r);
  });
  socket.on('action', kind => room && step(room, socket.id, kind));
  socket.on('rematch', () => {
    const r = room;
    if (!r || r.phase !== 'over') return;
    r.phase = 'pick'; r.f = null; r.log = []; r.fx = [];
    for (const i in r.p) r.p[i] = r.p[i].bot ? { pick: rnd(), ready: true, bot: true } : { pick: null, ready: false };
    push(r);
  });

  socket.on('disconnect', () => {
    const r = room;
    if (!r || !r.p[socket.id]) return;
    delete r.p[socket.id];
    const humans = Object.keys(r.p).filter(i => !r.p[i].bot);
    if (!humans.length) return void delete rooms[r.code];
    if (r.host === socket.id) r.host = humans[0];
    if (r.phase === 'battle') { r.phase = 'over'; r.winner = humans[0]; r.reason = 'abandono'; }
    else if (r.phase === 'over') r.reason = r.reason || 'abandono';
    else Object.values(r.p).forEach(x => (x.ready = x.bot ? true : false));
    push(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Duelo en http://localhost:${PORT}`));
