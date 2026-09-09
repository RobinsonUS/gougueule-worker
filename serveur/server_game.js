// ═══════════════════════════════════════════════════════════════════
//  Serveur autoritatif  —  simulation 60 Hz, snapshots 30 Hz
//  Netcode : file d'inputs numerotes + reconciliation client
// ═══════════════════════════════════════════════════════════════════
const WebSocket = require('ws');
const http = require('http');
const { createHmac, timingSafeEqual } = require('crypto');

// ─────────────── JWT (sans dépendance externe) ─────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn('[WARN] JWT_SECRET non défini — aucun joueur ne pourra se connecter !');

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const sig  = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const expected = createHmac('sha256', JWT_SECRET).update(data).digest();
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ─────────────── Constantes (identiques au client) ─────────────────
const MONDE = 3200, CELL = 50;
const R_JOUEUR = CELL * 0.60, VITESSE = 320, PV_MAX = 100;
const CANON_L = R_JOUEUR * 3.05, CADENCE = 0.12, V_BALLE = 1500;
const DISPERSION = 0.10, PORTEE = 800;
const R_BALLE = R_JOUEUR * 0.17;
const N_ARBRES = 26, N_BUISSONS = 32;
const R_ARBRE = CELL * 1.75, R_BUISSON = CELL * 1.5, PV_ARBRE = 100;
const ZONE_R0 = 1900, ZONE_R1 = 320, ZONE_ATTENTE = 12, ZONE_DUREE = 70, ZONE_DEGATS = 6;
const RECHARGE_DUREE = 1.4, CHARGEUR = 30;

const DT = 1 / 60;
const TICK_MS = 1000 / 60;
const SNAP_TOUS_LES = 2;
const DT_MAX_INPUT = 0.05;

// ─────────────── RNG deterministe ─────────────────────────────────
function creeRng(graine) {
  let a = graine | 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────── Decor ────────────────────────────────────────────
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

// ─────────────── Deplacement ───────────────────────────────────────
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

// ─────────────── Commande d'un joueur ─────────────────────────────
function appliqueCommande(p, a, cmd, mouvSeulement = false) {
  let dt = Math.min(DT_MAX_INPUT, Math.max(0, cmd.dt || DT));
  let mx = cmd.mx || 0, my = cmd.my || 0;
  const n = Math.hypot(mx, my);
  if (n > 1) { mx /= n; my /= n; }

  deplaceSolo(a, mx * VITESSE * dt, my * VITESSE * dt, p.obs);
  if (typeof cmd.angle === 'number') a.angle = cmd.angle;

  if (mouvSeulement) { a.lastSeq = cmd.seq; return; }

  if (cmd.recharger && a.rechargement <= 0 && a.munitions < CHARGEUR) {
    a.rechargement = RECHARGE_DUREE; a.dureeRechargeMax = RECHARGE_DUREE;
  }

  a.recharge -= dt;
  const armeEnMain = a.slot > 0 && a.inv && a.inv[a.slot];
  if (cmd.tire && armeEnMain && a.recharge <= 0 && a.rechargement <= 0 && a.munitions > 0) {
    a.recharge = CADENCE; a.tirTimer = 0.35; a.revele = 0.35; a.recul = 0.08;
    a.munitions--;
    const at = a.angle + (p.rng() - 0.5) * DISPERSION;
    const bx = a.x + Math.cos(a.angle) * CANON_L;
    const by = a.y + Math.sin(a.angle) * CANON_L;
    const liveArr = Object.values(p.agents);
    let spawnHit = false;
    for (const c of liveArr) {
      if (!c.vivant || c.id === a.id) continue;
      if (Math.hypot(c.x - bx, c.y - by) < R_JOUEUR + R_BALLE) {
        const dg = p.rng() < 0.5 ? 10 : 11;
        c.pv -= dg; c.secousse = 0.16; c.touche = 0.30; c.revele = 0.35;
        if (c.pv <= 0) { c.pv = 0; c.vivant = false; p.kills.push({ killer: a.name, victim: c.name }); }
        spawnHit = true; break;
      }
    }
    if (!spawnHit) {
      p.balles.push({
        id: ++p.balleId, x: bx, y: by,
        vx: Math.cos(at) * V_BALLE, vy: Math.sin(at) * V_BALLE,
        ang: at, reste: PORTEE, par: a.id,
      });
    }
    p.evts.push({ e: 'tir', id: a.id, x: a.x, y: a.y, ang: a.angle });
    if (a.munitions <= 0) { a.rechargement = RECHARGE_DUREE; a.dureeRechargeMax = RECHARGE_DUREE; }
  }
  a.lastSeq = cmd.seq;
}

// ─────────────── Un tick de simulation ────────────────────────────
function pas(p) {
  p.tick++;

  const arr = Object.values(p.agents);
  if (!p.fini) {
    if (p.demarree) p.t += DT;
  }

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

  for (const a of arr) {
    if (!a.vivant) { a.file.length = 0; continue; }
    const mouvSeulement = p.fini;
    if (a.file.length === 0) {
      appliqueCommande(p, a, { seq: a.lastSeq, mx: 0, my: 0, angle: a.angle, dt: DT }, mouvSeulement);
    } else {
      let budget = 0;
      while (a.file.length && budget < 0.10) {
        const cmd = a.file.shift();
        budget += Math.min(DT_MAX_INPUT, cmd.dt || DT);
        appliqueCommande(p, a, cmd, mouvSeulement);
      }
    }
  }
  separeJoueurs(arr);

  if (p.fini) return;

  for (const a of arr) {
    if (!a.vivant || !p.demarree) continue;
    if (Math.hypot(a.x - p.zone.x, a.y - p.zone.y) > p.zone.r) {
      a.pv -= ZONE_DEGATS * DT; a.touche = 0.30; a.revele = 0.35;
      a.ticZone -= DT;
      if (a.ticZone <= 0) { a.ticZone = 0.45; a.secousse = 0.14; }
      if (a.pv <= 0) { a.pv = 0; a.vivant = false; }
    }
  }

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
    if (p.nbMax > 1 && vivants.length <= 1) {
      p.fini = true; p.vainqueur = vivants.length ? vivants[0].id : null;
    } else if (vivants.length === 0) {
      p.fini = true; p.vainqueur = null;
    } else if (p.t >= 300) { p.fini = true; p.vainqueur = null; }
  }
}

// ─────────────── Serveur WebSocket ────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => { res.writeHead(200); res.end('OK'); });
const wss = new WebSocket.Server({ server });

// Heartbeat protocol-level : termine les connexions mortes en ~25s
// Résout les rooms fantômes quand le client ferme la page sans close frame
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// rooms[gid] = { etat:'attente'|'en_cours'|'fini', createur:pid, players:{pid:{ws,name,accountId}}, partie:null|{} }
const rooms = {};
// activeSessions[accountId] = { gid, pid } — un compte = une seule session
const activeSessions = {};

// ─── Utilitaire : retirer proprement un joueur d'une room ──────────
function nettoyeJoueur(roomId, playerId) {
  const room = rooms[roomId];
  if (!room || !room.players[playerId]) return; // idempotent
  if (room.etat === 'attente') {
    delete room.players[playerId];
    if (playerId === room.createur && Object.keys(room.players).length > 0)
      room.createur = Object.keys(room.players)[0];
    if (!Object.keys(room.players).length) { delete rooms[roomId]; return; }
    diffuseAttente(room, roomId);
  } else {
    if (room.partie) {
      const a = room.partie.agents[playerId];
      if (a && a.vivant) { a.vivant = false; a.pv = 0; room.partie.kills.push({ killer: 'Déconnexion', victim: a.name }); }
    }
    delete room.players[playerId];
    if (!Object.keys(room.players).length) delete rooms[roomId];
  }
}

function diffuseAttente(room, gid) {
  const joueurs = Object.entries(room.players).map(([id, pl]) => ({ id, name: pl.name }));
  for (const [plPid, pl] of Object.entries(room.players)) {
    if (pl.ws.readyState !== WebSocket.OPEN) continue;
    try { pl.ws.send(JSON.stringify({ type: 'attente', joueurs, createur: room.createur, gameId: gid, yourId: plPid })); } catch {}
  }
}

// ─── Connexion ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let pid = null, gid = null, accountId = null;

  ws.on('message', (raw) => {
    // Handler SYNCHRONE — plus d'await, plus de race conditions
    try {
      let msg; try { msg = JSON.parse(raw); } catch { return; }

      // ── creer / rejoindre ─────────────────────────────────────────
      if (msg.type === 'creer' || msg.type === 'rejoindre') {
        if (!JWT_SECRET) { ws.close(4003, 'JWT_SECRET manquant'); return; }
        const payload = verifyJWT(msg.token || '');
        if (!payload) { ws.close(4001, 'Token invalide ou expiré'); return; }

        // Kick l'ancienne session du même compte si elle existe
        const sub = payload.sub;
        if (activeSessions[sub]) {
          const prev = activeSessions[sub];
          const prevRoom = rooms[prev.gid];
          if (prevRoom && prevRoom.players[prev.pid]) {
            try { prevRoom.players[prev.pid].ws.close(4009, 'Connecté depuis un autre onglet'); } catch {}
          }
          nettoyeJoueur(prev.gid, prev.pid);
          delete activeSessions[sub];
        }

        const playerName = (payload.name || 'Joueur').slice(0, 16);
        const roomId = (String(msg.gameId || '')).trim().toUpperCase().slice(0, 10);
        if (!roomId) { ws.close(4004, 'Code room invalide'); return; }
        gid = roomId;
        accountId = sub;

        if (msg.type === 'creer') {
          if (rooms[gid] && rooms[gid].etat !== 'fini') {
            try { ws.send(JSON.stringify({ type: 'erreur', msg: 'Ce code est déjà utilisé' })); } catch {}
            ws.close(4005, 'Code déjà utilisé'); return;
          }
          if (rooms[gid]) delete rooms[gid]; // libérer room terminée
          pid = uid();
          rooms[gid] = { etat: 'attente', createur: pid, players: {}, partie: null };
          rooms[gid].players[pid] = { ws, name: playerName, accountId };
        } else {
          if (!rooms[gid] || rooms[gid].etat === 'fini') {
            try { ws.send(JSON.stringify({ type: 'erreur', msg: 'Room introuvable' })); } catch {}
            ws.close(4007, 'Room introuvable'); return;
          }
          if (rooms[gid].etat !== 'attente') {
            try { ws.send(JSON.stringify({ type: 'erreur', msg: 'Partie déjà en cours' })); } catch {}
            ws.close(4008, 'Partie en cours'); return;
          }
          pid = uid();
          rooms[gid].players[pid] = { ws, name: playerName, accountId };
        }

        activeSessions[accountId] = { gid, pid };
        if (ws.readyState === WebSocket.OPEN) diffuseAttente(rooms[gid], gid);
        return;
      }

      // ── quitter la salle d'attente ────────────────────────────────
      if (msg.type === 'quitter') {
        if (accountId) delete activeSessions[accountId];
        if (pid && gid) nettoyeJoueur(gid, pid);
        pid = null; gid = null; accountId = null;
        return;
      }

      // ── start : le créateur lance la partie ───────────────────────
      if (msg.type === 'start' && pid && rooms[gid]) {
        const room = rooms[gid];
        if (room.etat !== 'attente' || room.createur !== pid) return;
        if (Object.keys(room.players).length < 2) {
          try { ws.send(JSON.stringify({ type: 'erreur', msg: 'Il faut au moins 2 joueurs' })); } catch {}
          return;
        }
        room.partie = creePartie();
        room.partie.demarree = true;
        room.etat = 'en_cours';
        for (const [plPid, pl] of Object.entries(room.players)) ajouteJoueur(room.partie, plPid, pl.name);
        for (const [plPid, pl] of Object.entries(room.players)) {
          if (pl.ws.readyState !== WebSocket.OPEN) continue;
          const a = room.partie.agents[plPid];
          try {
            pl.ws.send(JSON.stringify({
              type: 'init', playerId: plPid, gameId: gid, map: MONDE,
              spawn: { x: a.x, y: a.y }, st: Date.now(),
              cfg: { VITESSE, R_JOUEUR, CADENCE, CHARGEUR, RECHARGE_DUREE, DT, ZONE_ATTENTE, ZONE_DUREE, ZONE_R0, ZONE_R1, MONDE },
              decor: room.partie.obs.map(o => ({ x: o.x, y: o.y, r: o.r, type: o.type, pv: o.pv, lobes: o.lobes, phase: o.phase, teinte: o.teinte, taches: o.taches })),
            }));
          } catch {}
        }
        return;
      }

      // ── invChange ─────────────────────────────────────────────────
      if (msg.type === 'invChange' && pid && rooms[gid] && rooms[gid].partie) {
        const a = rooms[gid].partie.agents[pid];
        if (a) {
          if (typeof msg.slot === 'number' && msg.slot >= 0 && msg.slot < 6) a.slot = msg.slot;
          if (Array.isArray(msg.inv) && msg.inv.length === 6)
            a.inv = msg.inv.map(x => [null,'fusil','mains'].includes(x) ? x : null);
        }
        return;
      }

      // ── inputs de jeu ─────────────────────────────────────────────
      if (msg.type === 'in' && pid && rooms[gid] && rooms[gid].partie) {
        const a = rooms[gid].partie.agents[pid];
        if (!a) return;
        for (const c of (msg.c || [])) { if (c.seq > a.lastSeq + a.file.length) a.file.push(c); }
        if (a.file.length > 40) a.file.splice(0, a.file.length - 40);
        return;
      }

      // ── ping ──────────────────────────────────────────────────────
      if (msg.type === 'ping' && ws.readyState === WebSocket.OPEN) {
        if (pid && rooms[gid] && rooms[gid].partie) {
          const a = rooms[gid].partie.agents[pid];
          if (a && typeof msg.rtt === 'number') a.rtt = Math.min(600, Math.max(0, msg.rtt));
        }
        try { ws.send(JSON.stringify({ type: 'pong', c: msg.c, st: Date.now() })); } catch {}
      }
    } catch (err) {
      console.error('[WS error]', err.message);
      try { if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Erreur serveur'); } catch {}
    }
  });

  ws.on('close', () => {
    if (accountId) delete activeSessions[accountId];
    if (pid && gid) nettoyeJoueur(gid, pid);
  });
});

// ─────────────── Boucle à pas fixe ────────────────────────────────
let prochain = Date.now();
function boucleServeur() {
  const maintenant = Date.now();
  let tours = 0;
  while (prochain <= maintenant && tours < 5) {
    for (const [roomId, room] of Object.entries(rooms)) {
      // Détecter les connexions mortes
      const morts = Object.entries(room.players).filter(([, pl]) => pl.ws.readyState !== WebSocket.OPEN);
      for (const [plId, pl] of morts) {
        if (pl.accountId) delete activeSessions[pl.accountId];
        nettoyeJoueur(roomId, plId);
        if (!rooms[roomId]) break; // room supprimée
      }
      if (!rooms[roomId]) continue;

      if (room.etat === 'en_cours' || room.etat === 'fini') {
        if (!room.partie) continue;
        pas(room.partie);
        if (room.etat === 'en_cours' && room.partie.fini) room.etat = 'fini';
        if (room.partie.tick % SNAP_TOUS_LES === 0) envoieSnapshot(room);
      }
    }
    prochain += TICK_MS; tours++;
  }
  if (tours >= 5) prochain = maintenant + TICK_MS;
  setTimeout(boucleServeur, Math.max(1, prochain - Date.now()));
}

function retardCommun(p) {
  let pire = 0;
  for (const a of Object.values(p.agents)) pire = Math.max(pire, (a.rtt || 120) / 2);
  return Math.round(Math.min(320, Math.max(90, pire + 60)));
}

function envoieSnapshot(room) {
  if (!room.partie) return;
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
    retard: retardCommun(p), fini: p.fini, vainqueur: p.vainqueur, zone: p.zone,
    balles: p.balles.map(b => ({ id: b.id, x: b.x, y: b.y, ang: b.ang, reste: b.reste, par: b.par })),
    kills: p.kills, evts: p.evts, decorMaj,
  };
  const agents = {};
  for (const [id, a] of Object.entries(p.agents)) {
    agents[id] = { id: a.id, name: a.name, x: a.x, y: a.y, angle: a.angle, pv: a.pv, vivant: a.vivant,
      munitions: a.munitions, rechargement: a.rechargement, dureeRechargeMax: a.dureeRechargeMax,
      secousse: a.secousse, touche: a.touche, tirTimer: a.tirTimer, recul: a.recul,
      revele: a.revele, slot: a.slot, inv: a.inv };
  }
  base.agents = agents;
  for (const [id, pl] of Object.entries(room.players)) {
    if (pl.ws.readyState !== WebSocket.OPEN) continue;
    const a = p.agents[id];
    base.ack = a ? a.lastSeq : 0;
    try { pl.ws.send(JSON.stringify(base)); } catch {}
  }
  p.kills = []; p.evts = [];
}

server.listen(PORT, () => console.log('Serveur sur le port ' + PORT));
boucleServeur();
