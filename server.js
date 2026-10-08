const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.get('/', (q, r) => r.sendFile(__dirname + '/index.html'));

const MAX = 25, HAND = 5, rooms = {};
const uid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const SYM = { S: '♠', H: '♥', C: '♣', D: '♦' };
const lbl = c => c.s === 'J' ? 'Joker ' + (c.c === 'black' ? 'negro' : 'rojo') : ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[c.v] || c.v) + SYM[c.s];

function newDeck() {
  const d = []; let i = 0;
  for (const s of 'SHCD') for (let v = 1; v <= 13; v++) d.push({ id: i++, s, v });
  ['black', 'black', 'red', 'red'].forEach(c => d.push({ id: i++, s: 'J', v: 0, c }));
  return shuffle(d);
}
function draw(r, p) {
  while (p.hand.length < HAND) {
    if (!r.deck.length) { r.deck = shuffle(r.disc); r.disc = []; if (!r.deck.length) return; }
    p.hand.push(r.deck.pop());
  }
}
const log = (r, t) => { r.log.push(t); if (r.log.length > 8) r.log.shift(); };
// Aplica el potenciador (x2) de un As si el jugador lo tiene para ese palo
function val(p, s, v) { if (p.boost[s]) { p.boost[s] = false; return v * 2; } return v; }
function next(r) { const n = r.players.length; let i = r.turn; do { i = (i + r.dir + n) % n; } while (r.players[i].hp <= 0); r.turn = i; }
function endTurn(r) {
  const alive = r.players.filter(p => p.hp > 0);
  if (alive.length <= 1) { r.phase = 'over'; r.winner = alive[0] ? alive[0].name : 'Nadie'; log(r, 'Gana ' + r.winner); return; }
  draw(r, r.players[r.turn]); next(r); r.phase = 'play';
}
// Devuelve true si queda esperando una defensa
function act(r, p, c, target) {
  const me = r.players[r.turn];
  if (c.v === 1 && c.s !== 'J') { p.boost[c.s] = true; log(r, `${p.name}: As ${SYM[c.s]} → su próxima carta ${SYM[c.s]} vale x2`); return false; }
  if (c.s === 'H') { const v = val(p, 'H', c.v), b = p.hp; p.hp = Math.min(MAX, p.hp + v); log(r, `${p.name} se cura ${p.hp - b}`); return false; }
  if (c.s === 'S') { const v = val(p, 'S', c.v); r.pend = { from: r.turn, to: target, v }; r.phase = 'defend'; log(r, `${p.name} ataca a ${r.players[target].name} con ${v}`); return true; }
  if (c.s === 'J' && c.c === 'black') { r.dir *= -1; log(r, `${p.name} invierte el sentido`); return false; }
  return false;
}

function view(r, p) {
  return {
    code: r.code, phase: r.phase, max: MAX, turn: r.turn, dir: r.dir, winner: r.winner, log: r.log, pend: r.pend,
    host: r.players[0] === p, me: r.players.indexOf(p), deck: r.deck.length, hand: p.hand,
    players: r.players.map(q => ({ name: q.name, hp: q.hp, n: q.hand.length, boost: q.boost, on: !!q.sid }))
  };
}
const push = r => r.players.forEach(p => p.sid && io.to(p.sid).emit('state', view(r, p)));

io.on('connection', s => {
  const R = () => rooms[s.data.code], P = () => R() && R().players.find(p => p.id === s.data.token);
  function join(code, name, token) {
    const r = rooms[(code || '').toUpperCase()];
    if (!r) return s.emit('gone');
    let p = r.players.find(q => q.id === token);
    if (!p) {
      if (r.phase !== 'lobby' || r.players.length >= 4) return s.emit('err', 'No puedes entrar: la sala está llena o ya empezó');
      p = { id: uid(), name: (name || 'Jugador').slice(0, 14), hp: MAX, hand: [], boost: {}, sid: null };
      r.players.push(p);
    }
    p.sid = s.id; s.data = { code: r.code, token: p.id };
    s.emit('joined', { code: r.code, token: p.id, name: p.name }); push(r);
  }
  s.on('create', ({ name }) => {
    let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms[c]);
    rooms[c] = { code: c, players: [], deck: [], disc: [], phase: 'lobby', dir: 1, turn: 0, log: [] };
    join(c, name, null);
  });
  s.on('join', g => join(g.code, g.name, g.token));

  s.on('start', () => {
    const r = R(), p = P(); if (!r || r.phase !== 'lobby' || r.players[0] !== p) return;
    if (r.players.length < 2) return s.emit('err', 'Faltan jugadores (mínimo 2)');
    r.deck = newDeck(); r.disc = []; r.dir = 1; r.last = null; r.log = [];
    r.players.forEach(q => { q.hp = MAX; q.hand = []; q.boost = { S: false, H: false, C: false, D: false }; draw(r, q); });
    r.turn = Math.random() * r.players.length | 0; r.phase = 'play'; log(r, '¡Empieza la partida!'); push(r);
  });

  s.on('play', ({ cardId, target }) => {
    const r = R(), p = P(); if (!r || !p || r.phase !== 'play' || r.players[r.turn] !== p) return;
    const c = p.hand.find(x => x.id === cardId); if (!c || c.s === 'C' || c.s === 'D') return s.emit('err', 'Tréboles y diamantes solo sirven para defenderte');
    const red = c.s === 'J' && c.c === 'red', eff = red ? r.last : c;
    if (red && !eff) return s.emit('err', 'Todavía no hay carta que copiar');
    if (eff.s === 'S') {
      const t = r.players[target];
      if (!t || t === p || t.hp <= 0) return s.emit('err', 'Elige a quién atacar');
    }
    p.hand.splice(p.hand.indexOf(c), 1); r.disc.push(c);
    if (red) log(r, `${p.name} copia ${lbl(eff)}`); else r.last = { s: c.s, v: c.v, c: c.c };
    if (!act(r, p, eff, target)) endTurn(r);
    push(r);
  });

  s.on('discard', ({ cardId }) => {
    const r = R(), p = P(); if (!r || !p || r.phase !== 'play' || r.players[r.turn] !== p) return;
    const c = p.hand.find(x => x.id === cardId); if (!c) return;
    p.hand.splice(p.hand.indexOf(c), 1); r.disc.push(c); log(r, `${p.name} descarta y pasa`); endTurn(r); push(r);
  });

  s.on('defend', ({ cardId }) => {
    const r = R(), p = P(); if (!r || !p || r.phase !== 'defend' || r.players[r.pend.to] !== p) return;
    let dmg = r.pend.v, txt = `${p.name} recibe el golpe`;
    if (cardId != null) {
      const c = p.hand.find(x => x.id === cardId);
      if (!c || (c.s !== 'C' && c.s !== 'D')) return s.emit('err', 'Defiéndete con trébol o diamante');
      p.hand.splice(p.hand.indexOf(c), 1); r.disc.push(c);
      const d = val(p, c.s, c.v);
      if (c.s === 'D') { dmg = Math.max(0, dmg - d); txt = `${p.name} defiende con ${lbl(c)}`; }
      else if (d > dmg) { dmg = 0; txt = `${p.name} esquiva con ${lbl(c)}`; }
      else txt = `${p.name} falla el esquive con ${lbl(c)}`;
    }
    p.hp -= dmg; log(r, `${txt}: ${dmg} de daño`);
    if (p.hp > 0) draw(r, p);
    r.pend = null; endTurn(r); push(r);
  });

  s.on('disconnect', () => { const r = R(), p = P(); if (p) { p.sid = null; push(r); } });
});
srv.listen(process.env.PORT || 3000, () => console.log('Juego listo'));
