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
const MELEE_PORTEE = R_JOUEUR * 4.0, MELEE_DEGATS = 18, MELEE_CD = 0.5;

const DT = 1 / 30; // 30 Hz : charge CPU réduite de moitié
const TICK_MS = 1000 / 30;
const SNAP_TOUS_LES = 1; // snap chaque tick (= 30 Hz)
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
  const arbres = obs.filter(o => o.type === 'arbre');
  return {
    rng, obs, arbres, // arbres : liste pré-filtrée pour deplaceSolo
    t: 0, tick: 0, fini: false, vainqueur: null,
    demarree: false, nbMax: 0, balleId: 0,
    zone: { x: MONDE / 2, y: MONDE / 2, r: ZONE_R0 },
    balles: [], agents: {}, kills: [], evts: [],
  };
}

function ajouteJoueur(partie, pid, name, avecArme = true) {
  partie.nbMax++;
  const pos = placer(partie.rng, partie.obs);
  partie.agents[pid] = {
    id: pid, name, x: pos.x, y: pos.y,
    pv: PV_MAX, angle: 0, recharge: 0, vivant: true,
    secousse: 0, touche: 0, tirTimer: 0, recul: 0, revele: 0,
    munitions: CHARGEUR, rechargement: 0, dureeRechargeMax: 0, slot: 0,
    poingTimer: 0, punchSide: 0,
    inv: avecArme ? [null, 'fusil', null, null, null, null] : [null, null, null, null, null, null],
    ticZone: 0, lastSeq: 0, file: [], rtt: 120,
  };
}

// ─────────────── Deplacement ───────────────────────────────────────
function borne(a) {
  a.x = Math.min(MONDE - R_JOUEUR, Math.max(R_JOUEUR, a.x));
  a.y = Math.min(MONDE - R_JOUEUR, Math.max(R_JOUEUR, a.y));
}

function deplaceSolo(a, dx, dy, obs, maxIter = 3) {
  a.x += dx; a.y += dy; borne(a);
  // obs doit déjà être la liste des arbres (pré-filtrée)
  for (let it = 0; it < maxIter; it++) {
    let hit = false;
    for (const o of obs) {
      // pas de filtre type ici (obs = arbres uniquement)
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

  // Bots : 1 itération de collision (précision réduite mais 3× plus rapide)
  deplaceSolo(a, mx * VITESSE * dt, my * VITESSE * dt, p.arbres || p.obs, a.estBot ? 1 : 3);
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

  // Coup de poing (slot vide)
  if (cmd.poing && !mouvSeulement && a.poingTimer <= 0) {
    a.poingTimer = MELEE_CD;
    a.punchSide = 1 - a.punchSide;
    a.revele = 0.35;
    const liveArr = Object.values(p.agents);
    let closest = null, closestD = Infinity;
    for (const c of liveArr) {
      if (!c.vivant || c.id === a.id) continue;
      const ex = c.x - a.x, ey = c.y - a.y;
      const dist = Math.hypot(ex, ey);
      if (dist < MELEE_PORTEE) {
        const dot = (ex * Math.cos(a.angle) + ey * Math.sin(a.angle)) / dist;
        if (dot > 0.2 && dist < closestD) { closestD = dist; closest = c; }
      }
    }
    if (closest) {
      closest.pv -= MELEE_DEGATS;
      closest.secousse = 0.20; closest.touche = 0.30; closest.revele = 0.35;
      if (closest.pv <= 0) {
        closest.pv = 0; closest.vivant = false;
        p.kills.push({ killer: a.name, victim: closest.name });
      }
    }
    p.evts.push({ e: 'poing', id: a.id, ang: a.angle, side: a.punchSide });
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
    if (a.poingTimer > 0) a.poingTimer = Math.max(0, a.poingTimer - DT);
    if (a.rechargement > 0) {
      a.rechargement -= DT;
      if (a.rechargement <= 0) { a.munitions = CHARGEUR; a.dureeRechargeMax = 0; }
    }
  }

  // Cache arbres (mis à jour si une souche apparaît, max toutes les 5s)
  if (!p.arbres || p.tick % 150 === 0) {
    p.arbres = p.obs.filter(o => o.type === 'arbre');
  }

  // Suivi de vitesse + précalcul _inBush en une seule passe
  for (const a of arr) {
    a._vx = (a.x - (a._px ?? a.x)) / DT;
    a._vy = (a.y - (a._py ?? a.y)) / DT;
    a._px = a.x; a._py = a.y;
    // _inBush supprimé (IA bot simplifiée)
  }

  // Bot AI toutes les 3 ticks — la commande est réutilisée entre les ticks
  // (le mouvement reste fluide car appliqueCommande reçoit une commande valide)
  for (const a of arr) {
    if (a.estBot && a.vivant) {
      if (p.tick % 3 === 0) {
        a._dernCmd = calculeBotCmd(p, a, arr);
      }
      if (a._dernCmd) a.file = [{ ...a._dernCmd, seq: a.lastSeq + 1, dt: DT }];
    }
  }

  for (const a of arr) {
    if (!a.vivant) { a.file.length = 0; continue; }
    const mouvSeulement = p.fini || (p.phaseLobby === true);
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
    for (const o of (p.arbres || p.obs)) {
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
let soloRoomId = null; // gid de la room solo ouverte (accepte de nouveaux joueurs)
// activeSessions[accountId] = { gid, pid } — un compte = une seule session
const activeSessions = {};

// ─── Utilitaire : retirer proprement un joueur d'une room ──────────
function nettoyeJoueur(roomId, playerId) {
  const room = rooms[roomId];
  if (!room || !room.players[playerId]) return; // idempotent

  if (room.etat === 'attente') {
    // Salle d'attente amis
    delete room.players[playerId];
    if (playerId === room.createur && Object.keys(room.players).length > 0)
      room.createur = Object.keys(room.players)[0];
    if (!Object.keys(room.players).length) { delete rooms[roomId]; return; }
    diffuseAttente(room, roomId);

  } else if (room.etat === 'lobby') {
    // Phase lobby solo : retirer le joueur de la room ET de la partie
    delete room.players[playerId];
    if (room.partie && room.partie.agents[playerId]) {
      delete room.partie.agents[playerId];
    }
    // Si plus personne : supprimer la room
    if (!Object.keys(room.players).length) {
      if (roomId === soloRoomId) soloRoomId = null;
      delete rooms[roomId];
      return;
    }
    // Si moins de 2 joueurs : annuler le countdown
    if (Object.keys(room.players).length < 2) room.countdownStart = null;
    // Diffuser l'état lobby aux joueurs restants
    diffuseLobby(room, roomId);

  } else {
    // Partie en cours ou terminée
    if (room.partie) {
      const a = room.partie.agents[playerId];
      if (a && a.vivant) { a.vivant = false; a.pv = 0; room.partie.kills.push({ killer: 'Déconnexion', victim: a.name }); }
    }
    delete room.players[playerId];
    if (!Object.keys(room.players).length) {
      if (roomId === soloRoomId) soloRoomId = null;
      delete rooms[roomId];
    }
  }
}

function diffuseAttente(room, gid) {
  const joueurs = Object.entries(room.players).map(([id, pl]) => ({ id, name: pl.name }));
  for (const [plPid, pl] of Object.entries(room.players)) {
    if (pl.ws.readyState !== WebSocket.OPEN) continue;
    try { pl.ws.send(JSON.stringify({ type: 'attente', joueurs, createur: room.createur, gameId: gid, yourId: plPid })); } catch {}
  }
}

// Diffuser l'état lobby (nombre de joueurs + countdown) à tous les joueurs solo

// ─────────────── Intelligence Artificielle des Bots ──────────────
const BOT_NOMS = ['Wang', 'Vladimir', 'Gratien', 'Yanis']; // 4 bots max

function lerpAngle(a, b, maxTurn) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) > maxTurn) d = Math.sign(d) * maxTurn;
  return a + d;
}

function calculeBotCmd(p, bot, arr) {
  bot._tick = (bot._tick || 0) + 1;
  const t = bot._tick;
  let recharger = bot.munitions === 0 && bot.rechargement <= 0;

  // Lobby : errance libre
  if (p.phaseLobby) {
    if (t % 150 === 1) bot._wA = Math.random() * Math.PI * 2;
    const wa = bot._wA || 0;
    return { seq: bot.lastSeq + 1, mx: Math.cos(wa), my: Math.sin(wa),
             angle: lerpAngle(bot.angle, wa, 3 * DT), tire: false, recharger: false, dt: DT };
  }

  // Ennemi le plus proche
  let nearest = null, nearestDist = Infinity;
  for (const a of arr) {
    if (a.id === bot.id || !a.vivant) continue;
    const d = Math.hypot(a.x - bot.x, a.y - bot.y);
    if (d < nearestDist) { nearestDist = d; nearest = a; }
  }

  let tmx = 0, tmy = 0, angle = bot.angle, tire = false;

  // 1. Fuir la zone si dehors
  const dz = Math.hypot(bot.x - p.zone.x, bot.y - p.zone.y);
  if (p.demarree && dz > p.zone.r * 0.88) {
    const dx = p.zone.x - bot.x, dy = p.zone.y - bot.y;
    const d = Math.hypot(dx, dy);
    tmx = dx / d; tmy = dy / d; angle = Math.atan2(dy, dx);

  } else if (nearest) {
    // 2. Chasser l'ennemi à distance idéale
    const dx = nearest.x - bot.x, dy = nearest.y - bot.y;
    const IDEAL = 380;
    if (nearestDist > IDEAL + 80) { tmx = dx / nearestDist; tmy = dy / nearestDist; }
    else if (nearestDist < IDEAL - 80) { tmx = -dx / nearestDist * 0.5; tmy = -dy / nearestDist * 0.5; }
    angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.30;
    bot._vu = (bot._vu || 0) + 1;
    if (bot._vu > 42 && nearestDist < 520 && bot.munitions > 0 && bot.rechargement <= 0) tire = true;

  } else {
    // 3. Errance
    bot._vu = 0;
    if (t % 150 === 1) bot._wA = Math.random() * Math.PI * 2;
    const wa = bot._wA || 0;
    const tzx = p.zone.x - bot.x, tzy = p.zone.y - bot.y;
    const tzd = Math.hypot(tzx, tzy);
    if (tzd > 450) { tmx = tzx / tzd * 0.8 + Math.cos(wa) * 0.2; tmy = tzy / tzd * 0.8 + Math.sin(wa) * 0.2; }
    else { tmx = Math.cos(wa); tmy = Math.sin(wa); }
    angle = Math.atan2(tmy, tmx);
  }

  if (!nearest) bot._vu = 0;
  const n = Math.hypot(tmx, tmy);
  if (n > 0.01) { tmx /= n; tmy /= n; }

  bot._smx = (bot._smx || 0) * 0.70 + tmx * 0.30;
  bot._smy = (bot._smy || 0) * 0.70 + tmy * 0.30;
  angle = lerpAngle(bot.angle, angle, 4 * DT);
  return { seq: bot.lastSeq + 1, mx: bot._smx, my: bot._smy, angle, tire, recharger, dt: DT };
}
function spawnBot(partie, nom) {
  const pid = 'bot_' + Math.random().toString(36).slice(2, 7);
  ajouteJoueur(partie, pid, nom, false); // pas d'arme en lobby
  const a = partie.agents[pid];
  a.estBot = true;
  a._tick = 0;
  a._wanderAngle = Math.random() * Math.PI * 2;
  return pid;
}

function diffuseLobby(room, gid) {
  if (!room || room.etat !== 'lobby') return;
  const nb = Object.keys(room.players).length;
  let compteARebours = null;
  if (room.countdownStart && nb >= 2) {
    compteARebours = Math.max(0, 10 - (Date.now() - room.countdownStart) / 1000);
  }
  const snap = JSON.stringify({ type: 'lobbyStatus', nb, compteARebours });
  for (const pl of Object.values(room.players)) {
    if (pl.ws.readyState !== WebSocket.OPEN) continue;
    try { pl.ws.send(snap); } catch {}
  }
}

// Lancer la partie solo après le countdown
function demarrePartie(room, gid) {
  const p = room.partie;
  p.phaseLobby = false;
  p.demarree = true;
  room.etat = 'en_cours';
  room.countdownStart = null;
  if (gid === soloRoomId) soloRoomId = null; // libérer pour les prochains
  // Téléporter + équiper chaque joueur vivant
  for (const a of Object.values(p.agents)) {
    if (!a.vivant) continue;
    const pos = placer(p.rng, p.obs);
    a.x = pos.x; a.y = pos.y; a.pv = PV_MAX;
    a.inv = [null, 'fusil', null, null, null, null]; // donner l'arme
    a.slot = 1; a.munitions = CHARGEUR; a.rechargement = 0;
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

      // ── solo : rejoindre la matchmaking automatique ─────────────
      if (msg.type === 'solo') {
        if (!JWT_SECRET) { ws.close(4003, 'JWT_SECRET manquant'); return; }
        const payload = verifyJWT(msg.token || '');
        if (!payload) { ws.close(4001, 'Token invalide ou expiré'); return; }

        const sub = payload.sub;
        if (activeSessions[sub]) {
          const prev = activeSessions[sub];
          const prevRoom = rooms[prev.gid];
          if (prevRoom && prevRoom.players[prev.pid]) {
            try { prevRoom.players[prev.pid].ws.close(4009, 'Reconnecté depuis un autre onglet'); } catch {}
          }
          nettoyeJoueur(prev.gid, prev.pid);
          delete activeSessions[sub];
        }

        const playerName = (payload.name || 'Joueur').slice(0, 16);
        accountId = sub;

        // Trouver ou créer la room solo ouverte
        if (!soloRoomId || !rooms[soloRoomId] || rooms[soloRoomId].etat !== 'lobby') {
          const newGid = uid();
          const partie = creePartie();
          partie.phaseLobby = true; // bloque tir + zone
          rooms[newGid] = { etat: 'lobby', mode: 'solo', createur: null, players: {}, partie, countdownStart: null };
          soloRoomId = newGid;
          gid = newGid;
        } else {
          gid = soloRoomId;
        }

        pid = uid();
        ajouteJoueur(rooms[gid].partie, pid, playerName, false); // pas d'arme en lobby
        rooms[gid].players[pid] = { ws, name: playerName, accountId };
        activeSessions[accountId] = { gid, pid };

        const a = rooms[gid].partie.agents[pid];
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'init', playerId: pid, gameId: gid, map: MONDE,
              spawn: { x: a.x, y: a.y }, st: Date.now(),
              cfg: { VITESSE, R_JOUEUR, CADENCE, CHARGEUR, RECHARGE_DUREE, DT, ZONE_ATTENTE, ZONE_DUREE, ZONE_R0, ZONE_R1, MONDE },
              decor: rooms[gid].partie.obs.map(o => ({ x: o.x, y: o.y, r: o.r, type: o.type, pv: o.pv, lobes: o.lobes, phase: o.phase, teinte: o.teinte, taches: o.taches })),
            }));
          } catch {}
        }
        diffuseLobby(rooms[gid], gid);
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
  try {
    const maintenant = Date.now();
    let tours = 0;
    while (prochain <= maintenant && tours < 2) {
      for (const [roomId, room] of Object.entries(rooms)) {
        // Détecter les connexions mortes
        try {
          const morts = Object.entries(room.players).filter(([, pl]) => pl.ws.readyState !== WebSocket.OPEN);
          for (const [plId, pl] of morts) {
            if (pl.accountId) delete activeSessions[pl.accountId];
            nettoyeJoueur(roomId, plId);
            if (!rooms[roomId]) break;
          }
        } catch (e) { console.error('[boucle/morts]', e.message); }

        if (!rooms[roomId]) continue;

        // Phase lobby solo : physique + gestion countdown
        if (room.etat === 'lobby' && room.mode === 'solo' && room.partie) {
          try {
            const nb = Object.keys(room.players).length;
            if (nb >= 2 && !room.countdownStart) {
              room.countdownStart = Date.now();
              room.botsSpawnes = 0;
              diffuseLobby(room, roomId);
            } else if (nb < 2 && room.countdownStart) {
              // Countdown annulé : retirer les bots
              room.countdownStart = null;
              if (room.partie) {
                for (const pid of Object.keys(room.partie.agents)) {
                  if (room.partie.agents[pid].estBot) {
                    delete room.partie.agents[pid];
                  }
                }
                room.partie.nbMax = Object.keys(room.partie.agents).length;
              }
              room.botsSpawnes = 0;
              diffuseLobby(room, roomId);
            }
            if (room.countdownStart) {
              const elapsed = (Date.now() - room.countdownStart) / 1000;
              // Spawn 1 bot par seconde : bot 1 à t=0s, bot 5 à t=4s
              const botsVoulus = Math.min(4, Math.floor(elapsed) + 1); // 4 bots max
              room.botsSpawnes = room.botsSpawnes || 0;
              while (room.botsSpawnes < botsVoulus) {
                spawnBot(room.partie, BOT_NOMS[room.botsSpawnes]);
                room.botsSpawnes++;
              }
              if (elapsed >= 10) demarrePartie(room, roomId);
            }
            pas(room.partie);
            if (room.partie.tick % SNAP_TOUS_LES === 0) envoieSnapshot(room);
          } catch (e) { console.error('[boucle/lobby]', e.message); }
        }

        if (room.etat === 'en_cours' || room.etat === 'fini') {
          if (!room.partie) continue;
          try {
            pas(room.partie);
            if (room.etat === 'en_cours' && room.partie.fini) room.etat = 'fini';
          } catch (e) { console.error('[boucle/pas]', e.message); }
          try {
            if (room.partie.tick % SNAP_TOUS_LES === 0) envoieSnapshot(room);
          } catch (e) { console.error('[boucle/snap]', e.message); }
        }
      }
      prochain += TICK_MS; tours++;
    }
    if (tours >= 5) prochain = maintenant + TICK_MS;
  } catch (e) {
    console.error('[boucleServeur]', e.message);
    prochain = Date.now() + TICK_MS; // éviter la boucle infinie sur erreur
  }
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
  // Champs lobby solo
  let compteARebours = null;
  const phaseLobby = !!p.phaseLobby;
  if (phaseLobby && room.countdownStart) {
    compteARebours = Math.max(0, 10 - (Date.now() - room.countdownStart) / 1000);
  }
  const nbJoueursLobby = phaseLobby ? Object.keys(room.players).length : undefined;

  const base = {
    type: 'snap', tick: p.tick, t: p.t, st: Date.now(), attente: !p.demarree,
    retard: retardCommun(p), fini: p.fini, vainqueur: p.vainqueur, zone: p.zone,
    phaseLobby, compteARebours, nbJoueursLobby,
    balles: p.balles.map(b => ({ id: b.id, x: b.x, y: b.y, ang: b.ang, reste: b.reste, par: b.par })),
    kills: p.kills, evts: p.evts, decorMaj,
  };
  const agents = {};
  for (const [id, a] of Object.entries(p.agents)) {
    agents[id] = { id: a.id, name: a.name, x: a.x, y: a.y, angle: a.angle, pv: a.pv, vivant: a.vivant,
      munitions: a.munitions, rechargement: a.rechargement, dureeRechargeMax: a.dureeRechargeMax,
      secousse: a.secousse, touche: a.touche, tirTimer: a.tirTimer, recul: a.recul,
      revele: a.revele, slot: a.slot, inv: a.inv,
      poingTimer: a.poingTimer, punchSide: a.punchSide };
  }
  base.agents = agents;
  // Sérialiser UNE FOIS puis injecter l'ack par joueur (string replace = O(1))
  base.ack = 0;
  const snapStr = JSON.stringify(base);
  for (const [id, pl] of Object.entries(room.players)) {
    if (pl.ws.readyState !== WebSocket.OPEN) continue;
    const a = p.agents[id];
    const ack = a ? a.lastSeq : 0;
    try { pl.ws.send(ack === 0 ? snapStr : snapStr.replace('"ack":0', '"ack":' + ack)); } catch {}
  }
  p.kills = []; p.evts = [];
}

server.listen(PORT, () => console.log('Serveur sur le port ' + PORT));
boucleServeur();
