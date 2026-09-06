// ═══════════════════════════════════════════════════════════════════
//  Serveur autoritatif  —  simulation 60 Hz, snapshots 30 Hz
//  Netcode : file d'inputs numerotes + reconciliation client
// ═══════════════════════════════════════════════════════════════════
const WebSocket = require('ws');
const http = require('http');

// ─────────────── Constantes (identiques au client) ───────────────
const MONDE = 3200, CELL = 50;
const R_JOUEUR = CELL * 0.60, VITESSE = 320, PV_MAX = 100;
const CANON_L = R_JOUEUR * 3.05, CADENCE = 0.12, V_BALLE = 1500;
const DISPERSION = 0.10, PORTEE = 800;
const R_BALLE = R_JOUEUR * 0.17;
const N_ARBRES = 26, N_BUISSONS = 32;
const R_ARBRE = CELL * 1.75, R_BUISSON = CELL * 1.5, PV_ARBRE = 100;
const ZONE_R0 = 1900, ZONE_R1 = 320, ZONE_ATTENTE = 12, ZONE_DUREE = 70, ZONE_DEGATS = 6;
const RECHARGE_DUREE = 1.4, CHARGEUR = 30;

const DT = 1 / 60;                 // pas de simulation fixe
const TICK_MS = 1000 / 60;         // 60 simulations/s
const SNAP_TOUS_LES = 2;           // snapshot 1 tick sur 2 => 30/s
const DT_MAX_INPUT = 0.05;         // un input ne peut pas valoir plus de 50 ms

// ─────────────── RNG deterministe ───────────────
function creeRng(graine) {
  let a = graine | 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────── Decor ───────────────
function genereDecor(rng) {
  const obs = [];
  const marge = 160, libre = MONDE - 2 * marge;
  const poser = (n, r, type) => {
    let essais = 0, poses = 0;
    while (poses < n && essais < n * 100) {
      essais++;
      const x = marge + rng() * libre, y = marge + rng() * libre;
      let ok = true;
      for (const o of obs) if (Math.hypot(o.x - x, o.y - y) < o.r + r + 24) { ok = false; break; }
      if (Math.hypot(x - MONDE / 2, y - MONDE / 2) < 280) ok = false;
      if (ok) {
        obs.push({
          x, y, r, type, pv: PV_ARBRE, secousse: 0,
          lobes: 9 + ((rng() * 3) | 0), phase: rng() * Math.PI * 2, teinte: (rng() * 4) | 0,
          taches: [
            { a: rng() * 6.28, d: 0.30 + rng() * 0.35, t: rng() * 6.28 },
            { a: rng() * 6.28, d: 0.30 + rng() * 0.35, t: rng() * 6.28 },
            { a: rng() * 6.28, d: 0.30 + rng() * 0.35, t: rng() * 6.28 },
          ],
        });
        poses++;
      }
    }
  };
  poser(N_ARBRES, R_ARBRE, 'arbre');
  poser(N_BUISSONS, R_BUISSON, 'buisson');
  return obs;
}

function uid() { return Math.random().toString(36).slice(2, 11); }

function placer(rng, obs) {
  for (let i = 0; i < 300; i++) {
    const ang = rng() * Math.PI * 2, dist = 200 + rng() * 1200;
    const x = MONDE / 2 + Math.cos(ang) * dist, y = MONDE / 2 + Math.sin(ang) * dist;
    if (x < 150 || x > MONDE - 150 || y < 150 || y > MONDE - 150) continue;
    let ok = true;
    for (const o of obs) {
      if (o.type !== 'arbre') continue;
      if (Math.hypot(o.x - x, o.y - y) < o.r + R_JOUEUR + 20) { ok = false; break; }
    }
    if (ok) return { x, y };
  }
  return { x: MONDE / 2, y: MONDE / 2 };
}

function creePartie() {
  const rng = creeRng((Math.random() * 1e9) | 0);
  const obs = genereDecor(rng);
  obs.forEach(o => { o._lt = o.type; });
  return {
    rng, obs, t: 0, tick: 0, fini: false, vainqueur: null,
    demarree: false, nbMax: 0, balleId: 0,
    zone: { x: MONDE / 2, y: MONDE / 2, r: ZONE_R0 },
    balles: [], agents: {}, kills: [], evts: [],
  };
}

function ajouteJoueur(partie, pid, name) {
  partie.nbMax++;
  const pos = placer(partie.rng, partie.obs);
  partie.agents[pid] = {
    id: pid, name, x: pos.x, y: pos.y,
    pv: PV_MAX, angle: 0, recharge: 0, vivant: true,
    secousse: 0, touche: 0, tirTimer: 0, recul: 0, revele: 0,
    munitions: CHARGEUR, rechargement: 0, dureeRechargeMax: 0, slot: 1,
    inv: [null, 'fusil', null, null, null, null],
    ticZone: 0, lastSeq: 0, file: [], rtt: 120,
  };
}

// ─────────────── Deplacement (DOIT rester identique cote client) ───────────────
function borne(a) {
  a.x = Math.min(MONDE - R_JOUEUR, Math.max(R_JOUEUR, a.x));
  a.y = Math.min(MONDE - R_JOUEUR, Math.max(R_JOUEUR, a.y));
}

function deplaceSolo(a, dx, dy, obs) {
  a.x += dx; a.y += dy; borne(a);
  for (let it = 0; it < 3; it++) {
    let hit = false;
    for (const o of obs) {
      if (o.type !== 'arbre') continue;
      const nx = a.x - o.x, ny = a.y - o.y;
      const d = Math.hypot(nx, ny), min = o.r + R_JOUEUR;
      if (d < min) {
        hit = true;
        if (d < 1e-6) { a.x += min; continue; }
        a.x += nx / d * (min - d); a.y += ny / d * (min - d);
      }
    }
    if (!hit) break;
  }
  borne(a);
}

function separeJoueurs(arr) {
  for (const a of arr) {
    if (!a.vivant) continue;
    for (const b of arr) {
      if (b === a || !b.vivant) continue;
      const nx = a.x - b.x, ny = a.y - b.y;
      const d = Math.hypot(nx, ny), min = R_JOUEUR * 2;
      if (d < min && d > 1e-6) {
        const p = (min - d) * 0.5;
        a.x += nx / d * p; a.y += ny / d * p;
        b.x -= nx / d * p; b.y -= ny / d * p;
        borne(a); borne(b);
      }
    }
  }
}

// ─────────────── Une commande d'un joueur ───────────────
function appliqueCommande(p, a, cmd) {
  let dt = Math.min(DT_MAX_INPUT, Math.max(0, cmd.dt || DT));
  let mx = cmd.mx || 0, my = cmd.my || 0;
  const n = Math.hypot(mx, my);
  if (n > 1) { mx /= n; my /= n; }

  deplaceSolo(a, mx * VITESSE * dt, my * VITESSE * dt, p.obs);
  if (typeof cmd.angle === 'number') a.angle = cmd.angle;

  if (cmd.recharger && a.rechargement <= 0 && a.munitions < CHARGEUR) {
    a.rechargement = RECHARGE_DUREE; a.dureeRechargeMax = RECHARGE_DUREE;
  }

  a.recharge -= dt;
  if (cmd.tire && a.recharge <= 0 && a.rechargement <= 0 && a.munitions > 0) {
    a.recharge = CADENCE; a.tirTimer = 0.35; a.revele = 0.35; a.recul = 0.08;
    a.munitions--;
    const at = a.angle + (p.rng() - 0.5) * DISPERSION;
    p.balles.push({
      id: ++p.balleId,
      x: a.x + Math.cos(a.angle) * CANON_L, y: a.y + Math.sin(a.angle) * CANON_L,
      vx: Math.cos(at) * V_BALLE, vy: Math.sin(at) * V_BALLE,
      ang: at, reste: PORTEE, par: a.id,
    });
    p.evts.push({ e: 'tir', id: a.id, x: a.x, y: a.y, ang: a.angle });
    if (a.munitions <= 0) { a.rechargement = RECHARGE_DUREE; a.dureeRechargeMax = RECHARGE_DUREE; }
  }
  a.lastSeq = cmd.seq;
}

// ─────────────── Un tick de simulation ───────────────
function pas(p) {
  if (p.fini) return;
  p.tick++;

  const arr = Object.values(p.agents);
  // la partie ne demarre vraiment qu'a partir de 2 joueurs :
  // un joueur seul peut se deplacer, mais la zone ne le ronge pas
  if (!p.demarree && arr.length >= 2) p.demarree = true;
  if (p.demarree) p.t += DT;

  const t = p.t - ZONE_ATTENTE;
  p.zone.r = (!p.demarree || t <= 0)
    ? ZONE_R0
    : ZONE_R0 + (ZONE_R1 - ZONE_R0) * Math.min(1, t / ZONE_DUREE);
  for (const o of p.obs) if (o.secousse > 0) o.secousse = Math.max(0, o.secousse - DT);
  for (const a of arr) {
    if (a.secousse > 0) a.secousse = Math.max(0, a.secousse - DT);
    if (a.touche > 0)   a.touche   = Math.max(0, a.touche - DT);
    if (a.tirTimer > 0) a.tirTimer = Math.max(0, a.tirTimer - DT);
    if (a.recul > 0)    a.recul    = Math.max(0, a.recul - DT);
    if (a.revele > 0)   a.revele   = Math.max(0, a.revele - DT);
    if (a.rechargement > 0) {
      a.rechargement -= DT;
      if (a.rechargement <= 0) { a.munitions = CHARGEUR; a.dureeRechargeMax = 0; }
    }
  }

  // toutes les commandes en attente sont consommees ce tick : zero retard
  for (const a of arr) {
    if (!a.vivant) { a.file.length = 0; continue; }
    if (a.file.length === 0) {
      appliqueCommande(p, a, { seq: a.lastSeq, mx: 0, my: 0, angle: a.angle, dt: DT });
    } else {
      let budget = 0;
      while (a.file.length && budget < 0.10) {
        const cmd = a.file.shift();
        budget += Math.min(DT_MAX_INPUT, cmd.dt || DT);
        appliqueCommande(p, a, cmd);
      }
    }
  }
  separeJoueurs(arr);

  // zone (aucun degat tant que la partie n'a pas demarre)
  for (const a of arr) {
    if (!a.vivant || !p.demarree) continue;
    if (Math.hypot(a.x - p.zone.x, a.y - p.zone.y) > p.zone.r) {
      a.pv -= ZONE_DEGATS * DT; a.touche = 0.30; a.revele = 0.35;
      a.ticZone -= DT;
      if (a.ticZone <= 0) { a.ticZone = 0.45; a.secousse = 0.14; }
      if (a.pv <= 0) { a.pv = 0; a.vivant = false; }
    }
  }

  // balles
  for (let k = p.balles.length - 1; k >= 0; k--) {
    const b = p.balles[k];
    const dx = b.vx * DT, dy = b.vy * DT;
    b.reste -= Math.hypot(dx, dy);
    if (b.reste <= 0) { p.balles.splice(k, 1); continue; }
    const nx = b.x + dx, ny = b.y + dy;
    let mort = false;
    for (const o of p.obs) {
      if (o.type !== 'arbre') continue;
      if (Math.hypot(o.x - nx, o.y - ny) < o.r + R_BALLE) {
        o.pv -= p.rng() < 0.5 ? 10 : 11; o.secousse = 0.22;
        if (o.pv <= 0) { o.pv = 0; o.type = 'souche'; o.secousse = 0; }
        mort = true; break;
      }
    }
    if (!mort) for (const c of arr) {
      if (!c.vivant || c.id === b.par) continue;
      if (Math.hypot(c.x - nx, c.y - ny) < R_JOUEUR + R_BALLE) {
        c.pv -= p.rng() < 0.5 ? 10 : 11;
        c.secousse = 0.16; c.touche = 0.30; c.revele = 0.35;
        if (c.pv <= 0) {
          c.pv = 0; c.vivant = false;
          const k2 = p.agents[b.par];
          p.kills.push({ killer: k2 ? k2.name : '?', victim: c.name });
        }
        mort = true; break;
      }
    }
    if (mort) p.balles.splice(k, 1); else { b.x = nx; b.y = ny; }
  }

  const vivants = arr.filter(a => a.vivant);
  if (p.demarree && arr.length > 0) {
    // couvre aussi la deconnexion : s'il ne reste qu'un joueur, il gagne
    if (p.nbMax > 1 && vivants.length <= 1) {
      p.fini = true; p.vainqueur = vivants.length ? vivants[0].id : null;
    } else if (vivants.length === 0) {
      p.fini = true; p.vainqueur = null;
    } else if (p.t >= 300) { p.fini = true; p.vainqueur = null; }
  }
}

// ─────────────── Serveur ───────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => { res.writeHead(200); res.end('OK'); });
const wss = new WebSocket.Server({ server });
const rooms = {};

wss.on('connection', (ws) => {
  let pid = null, gid = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      pid = uid(); gid = msg.gameId || uid();
      if (!rooms[gid]) rooms[gid] = { partie: creePartie(), players: {} };
      const room = rooms[gid];
      ajouteJoueur(room.partie, pid, (msg.name || 'Joueur').slice(0, 16));
      room.players[pid] = { ws };
      const a = room.partie.agents[pid];
      ws.send(JSON.stringify({
        type: 'init', playerId: pid, gameId: gid, map: MONDE,
        spawn: { x: a.x, y: a.y }, st: Date.now(),
        cfg: { VITESSE, R_JOUEUR, CADENCE, CHARGEUR, RECHARGE_DUREE, DT },
        decor: room.partie.obs.map(o => ({
          x: o.x, y: o.y, r: o.r, type: o.type, pv: o.pv,
          lobes: o.lobes, phase: o.phase, teinte: o.teinte, taches: o.taches,
        })),
      }));
      return;
    }

    // paquet d'entrees : on empile, le tick les consommera toutes
    if (msg.type === 'in' && pid && rooms[gid]) {
      const a = rooms[gid].partie.agents[pid];
      if (!a) return;
      const cmds = msg.c || [];
      for (const c of cmds) {
        if (c.seq > a.lastSeq + a.file.length) a.file.push(c);
      }
      if (a.file.length > 40) a.file.splice(0, a.file.length - 40);
      return;
    }

    if (msg.type === 'ping' && ws.readyState === WebSocket.OPEN) {
      // le client nous communique son aller-retour mesure
      if (pid && rooms[gid] && typeof msg.rtt === 'number') {
        const a = rooms[gid].partie.agents[pid];
        if (a) a.rtt = Math.min(600, Math.max(0, msg.rtt));
      }
      ws.send(JSON.stringify({ type: 'pong', c: msg.c, st: Date.now() }));
    }
  });

  ws.on('close', () => {
    if (pid && rooms[gid]) {
      const r = rooms[gid];
      delete r.partie.agents[pid];
      delete r.players[pid];
      if (!Object.keys(r.players).length) delete rooms[gid];
    }
  });
});

// ─────────────── Boucle a pas fixe, sans derive ───────────────
let prochain = Date.now();
function boucleServeur() {
  const maintenant = Date.now();
  let tours = 0;
  while (prochain <= maintenant && tours < 5) {
    for (const room of Object.values(rooms)) {
      const p = room.partie;
      pas(p);
      if (p.tick % SNAP_TOUS_LES === 0) envoieSnapshot(room);
    }
    prochain += TICK_MS; tours++;
  }
  if (tours >= 5) prochain = maintenant + TICK_MS;
  setTimeout(boucleServeur, Math.max(1, prochain - Date.now()));
}

// Retard d'interpolation commun : dicte par le joueur le plus lent,
// pour que TOUS les ecrans affichent le meme instant serveur.
function retardCommun(p) {
  let pire = 0;
  for (const a of Object.values(p.agents)) pire = Math.max(pire, (a.rtt || 120) / 2);
  return Math.round(Math.min(320, Math.max(90, pire + 60)));
}

function envoieSnapshot(room) {
  const p = room.partie;
  const decorMaj = [];
  p.obs.forEach((o, idx) => {
    if (o._lt !== o.type || o.secousse > 0) {
      decorMaj.push({ idx, type: o.type, pv: o.pv, secousse: o.secousse });
      o._lt = o.type;
    }
  });

  const base = {
    type: 'snap', tick: p.tick, t: p.t, st: Date.now(), attente: !p.demarree,
    retard: retardCommun(p),
    fini: p.fini, vainqueur: p.vainqueur, zone: p.zone,
    balles: p.balles.map(b => ({ id: b.id, x: b.x, y: b.y, ang: b.ang, reste: b.reste, par: b.par })),
    kills: p.kills, evts: p.evts, decorMaj,
  };

  const agents = {};
  for (const [id, a] of Object.entries(p.agents)) {
    agents[id] = {
      id: a.id, name: a.name, x: a.x, y: a.y, angle: a.angle, pv: a.pv, vivant: a.vivant,
      munitions: a.munitions, rechargement: a.rechargement, dureeRechargeMax: a.dureeRechargeMax,
      secousse: a.secousse, touche: a.touche, tirTimer: a.tirTimer, recul: a.recul,
      revele: a.revele, slot: a.slot, inv: a.inv,
    };
  }
  base.agents = agents;

  for (const [id, pl] of Object.entries(room.players)) {
    if (pl.ws.readyState !== WebSocket.OPEN) continue;
    const a = p.agents[id];
    base.ack = a ? a.lastSeq : 0;
    pl.ws.send(JSON.stringify(base));
  }
  p.kills = []; p.evts = [];
}

server.listen(PORT, () => console.log('Serveur sur le port ' + PORT));
boucleServeur();
