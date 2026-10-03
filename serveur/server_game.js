// ═══════════════════════════════════════════════════════════════════
//  Serveur autoritatif  —  simulation 60 Hz, snapshots 30 Hz
//  Netcode : file d'inputs numerotes + reconciliation client
// ═══════════════════════════════════════════════════════════════════
const WebSocket = require('ws');
const http = require('http');
const { createHmac, timingSafeEqual } = require('crypto');
const fs = require('fs');
const path = require('path');

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
const MONDE_DEFAUT = 3200, CELL = 50;
const R_JOUEUR = CELL * 0.60, VITESSE = 320, PV_MAX = 100;
const CANON_L = R_JOUEUR * 3.05, CADENCE = 0.12, V_BALLE = 1500;
const DISPERSION = 0.10, PORTEE = 800;
const R_BALLE = R_JOUEUR * 0.17;
const N_ARBRES = 26, N_BUISSONS = 32;
const R_ARBRE = CELL * 1.75, R_BUISSON = CELL * 1.36, PV_ARBRE = 100;
// L'orbe du lobby : un seul, plante au centre, long a casser au poing.
const R_ORBE = 175, PV_ORBE = 1500;
// Ce qui bloque le passage et arrete les balles.
const estSolide = (o) => o.type === 'arbre' || o.type === 'orbe';

// ─────────────── Huttes (Hu1 et Hu2) ──────────────────────────────
// Deux dessins, une seule geometrie. Mesures relevees au pixel sur le vrai
// jeu (quadrillage de 50 unites). Repere local : origine au centre du
// corps, perron vers +y (rot = 0). rot = 1, 2, 3 : quarts de tour horaires.
// Seuls les murs sont solides : on contourne la hutte ou on y entre.
const HUTTE = (() => {
  // Taille unique, comme les arbres : K agrandit toutes les cotes d'un coup
  // (mesures du vrai jeu x 1,08)
  const K = 1.08;
  const B = 116.15 * K;   // demi-cote exterieur du corps
  const I = 79.38 * K;    // demi-cote du plancher (face interieure des murs)
  const D = 62.75 * K;    // demi-largeur de la porte (entre les piliers)
  const P = 96.9 * K;    // bord exterieur des piliers
  const PV = 134.8 * K;   // bout des piliers, cote perron
  return {
    K, B, I, D, P, PV, PERRON: 168.1 * K,
    R: 250,           // R : rayon qui englobe tout (perron, zone de vue)
    murs: [
      [-B, -B,  B, -I],   // fond
      [-B, -I, -I,  B],   // gauche
      [ I, -I,  B,  B],   // droite
      [-B,  I, -D,  B],   // facade, a gauche de la porte
      [ D,  I,  B,  B],   // facade, a droite de la porte
      [-P,  B, -D, PV],   // pilier gauche
      [ D,  B,  P, PV],   // pilier droit
    ],
  };
})();
// ─────────────── Maison ───────────────────────────────────────────
// Indestructible. Une porte (perron) et deux fenetres, une de chaque cote.
// Les fenetres arretent les joueurs mais laissent passer les balles.
// Meme repere que les huttes (porte vers +y quand rot = 0). Mesures relevees
// sur le vrai jeu (tete du joueur et quadrillage de 50 unites).
const MAISON = (() => {
  const U = 203.4, V = 230.2;   // demi-cotes exterieurs du corps (u : cotes fenetres)
  const IU = 165.7, IV = 193.1; // demi-cotes du plancher
  // La porte est EXACTEMENT celle des huttes : meme largeur, memes piliers,
  // meme perron, meme zone de vue. Seul le mur autour change.
  const D = HUTTE.D, P = HUTTE.P;
  const PV = V + (HUTTE.PV - HUTTE.B), PERRON = V + (HUTTE.PERRON - HUTTE.B);
  const W = 64.2, WU = 228.4;   // fenetres : demi-largeur, bout exterieur
  return {
    U, V, IU, IV, D, PV, W, WU, PERRON,
    R: 350,
    // arretent joueurs ET balles
    murs: [
      [-U, -V, U, -IV],                          // fond
      [IU, -IV, U, -W], [IU, W, U, IV],          // cote droit, autour de la fenetre
      [-U, -IV, -IU, -W], [-U, W, -IU, IV],      // cote gauche, autour de la fenetre
      [-U, IV, -D, V], [D, IV, U, V],            // facade, de part et d'autre de la porte
      [-P, V, -D, PV], [D, V, P, PV],            // piliers
    ],
    // Fenetres : arretent seulement les joueurs, et seulement dans
    // l'epaisseur du mur. La vitre qui depasse dehors ne gene personne.
    fenetres: [[IU, -W, U, W], [-U, -W, -IU, W]],
    emprise: [-WU, -V, WU, PERRON],
  };
})();
// ─────────────── Batiments 1, 2 et 3 ────────────────────────────────
// Generes au pixel a partir des images (meme donnees cote client et
// editeur). Echelle choisie pour que chaque porte ait exactement la taille
// de celle de la maison. Repere local : centre du corps.
//  corps : contour exterieur des murs ; sol : plancher ; murs et fenetres
//  comme la maison ; portes : un element par battant (une double porte en a
//  deux, independants) : r0 fermee, r1 ouverte vers l'interieur, rm1 vers
//  l'exterieur, eb vers l'exterieur, f0 vers le bout libre (poignees).
const NOUVEAUX_BATS = {"batiment1":{"R":453.5,"corps":[-327.64,-195.13,327.64,195.13],"sol":[-287.16,-154.65,287.16,155.28],"emprise":[-383.61,-222.64,354.52,222.01],"murs":[[-347.88,-103.41,-287.79,-67.36],[-347.24,69.26,-287.79,105.31],[-327.64,-195.13,-68.94,-154.65],[68.94,-195.13,327.64,-154.65],[-327.64,155.28,-68.94,195.13],[68.94,155.28,327.64,195.13],[-327.64,-154.65,-287.16,-66.82],[-327.64,68.72,-287.16,155.28],[287.16,-154.65,327.64,-67.99],[287.16,69.89,327.64,155.28]],"fenetres":[[-68.94,-195.13,68.94,-154.65],[-68.94,155.28,68.94,195.13],[287.16,-67.99,327.64,69.89]],"portes":[{"r0":[-340.4,-74.95,-303.55,76.85],"r1":[-323.61,68.86,-171.81,105.71],"rm1":[-469.9,68.86,-318.1,105.71],"eb":[-1,0],"f0":[0,-1]}]},"batiment2":{"R":451.9,"corps":[-325.6,-193.91,325.6,193.91],"sol":[-285.37,-153.69,285.37,154.31],"emprise":[-326.54,-221.26,382.49,220.63],"murs":[[286.0,-180.09,345.71,-145.51],[286.0,143.0,345.71,178.2],[-325.6,-193.91,-75.43,-153.69],[61.6,-193.91,325.6,-153.69],[-325.6,154.31,-68.51,193.91],[68.51,154.31,325.6,193.91],[-325.6,-153.69,-285.37,154.31],[285.37,-153.69,325.6,-144.77],[285.37,142.57,325.6,154.31]],"fenetres":[[-75.43,-193.91,61.6,-153.69],[-68.51,154.31,68.51,193.91]],"portes":[{"r0":[301.44,-1.1,338.29,150.7],"r1":[169.8,142.17,321.6,179.03],"rm1":[316.13,142.17,467.93,179.03],"eb":[1,0],"f0":[0,-1]},{"r0":[301.44,-152.9,338.29,-1.1],"r1":[169.8,-181.23,321.6,-144.37],"rm1":[316.13,-181.23,467.93,-144.37],"eb":[1,0],"f0":[0,1]}]},"batiment3":{"R":648.1,"corps":[-309.27,-467.05,309.27,467.05],"sol":[-268.33,-426.74,268.33,426.74],"emprise":[-365.01,-523.43,337.3,494.45],"murs":[[-178.88,-487.21,-143.61,-427.37],[144.87,-487.21,180.14,-427.37],[-329.42,167.23,-269.59,202.5],[-329.42,339.19,-269.59,374.46],[-309.27,-467.05,-143.04,-426.74],[144.3,-467.05,309.27,-426.74],[-309.27,426.74,-190.85,467.05],[-53.54,426.74,97.63,467.05],[234.94,426.74,309.27,467.05],[-309.27,-426.74,-268.33,-244.71],[-309.27,-107.39,-268.33,203.08],[-309.27,338.62,-268.33,426.74],[268.33,-426.74,309.27,-244.71],[268.33,-107.39,309.27,212.58],[268.33,349.9,309.27,426.74],[146.13,74.64,268.33,114.95],[33.38,288.8,56.06,426.74]],"fenetres":[[-309.27,-244.71,-268.33,-107.39],[268.33,-244.71,309.27,-107.39],[268.33,212.58,309.27,349.9],[-190.85,426.74,-53.54,467.05],[97.63,426.74,234.94,467.05]],"portes":[{"r0":[0.63,-479.77,152.43,-442.92],"r1":[144.08,-463.04,180.93,-311.24],"rm1":[144.08,-609.36,180.93,-457.56],"eb":[0,-1],"f0":[-1,0]},{"r0":[-151.17,-479.77,0.63,-442.92],"r1":[-179.67,-463.04,-142.82,-311.24],"rm1":[-179.67,-609.36,-142.82,-457.56],"eb":[0,-1],"f0":[1,0]},{"r0":[-321.99,194.95,-285.13,346.75],"r1":[-305.26,338.4,-153.46,375.25],"rm1":[-451.58,338.4,-299.78,375.25],"eb":[-1,0],"f0":[0,-1]}]},"batiment4":{"R":1095.1,"corps":[-502.84,-882.97,502.84,882.97],"sol":[-461.09,-841.86,461.73,841.23],"emprise":[-535.1,-940.53,538.89,941.79],"murs":[[-179.63,-902.58,-144.21,-843.12],[145.48,-902.58,180.9,-843.12],[-178.36,843.12,-142.95,902.58],[146.74,843.12,182.16,902.58],[-502.84,-882.97,-143.04,-841.86],[144.3,-882.97,502.84,-841.86],[-502.84,841.23,-141.77,882.97],[145.57,841.23,502.84,882.97],[-502.84,-841.86,-461.09,-764.06],[-502.84,-626.18,-461.09,-419.98],[-502.84,-282.1,-461.09,-68.63],[-502.84,69.26,-461.09,282.41],[-502.84,420.3,-461.09,625.86],[-502.84,763.74,-461.09,841.23],[461.73,-841.86,502.84,-770.39],[461.73,-632.5,502.84,-426.94],[461.73,-289.05,502.84,-75.27],[461.73,62.62,502.84,275.77],[461.73,413.66,502.84,619.22],[461.73,757.1,502.84,841.23],[-219.48,-841.86,-179.0,-802.01],[177.73,-841.86,216.95,-802.01],[-461.09,-546.48,-179.0,-507.27],[-218.21,-602.14,-179.0,-451.61],[177.73,-547.75,461.73,-507.27],[177.73,-602.14,218.21,-451.61],[-461.09,-196.08,-177.73,-155.6],[-218.21,-251.74,-177.73,-99.94],[179.0,-196.08,461.73,-156.86],[179.0,-251.74,218.21,-99.94],[-461.09,155.6,-177.73,196.08],[-216.95,99.94,-177.73,251.74],[179.0,154.33,461.73,194.81],[179.0,99.94,219.48,251.74],[-461.09,507.27,-176.47,547.75],[-216.95,451.61,-176.47,602.14],[179.0,506.0,461.73,546.48],[179.0,451.61,219.48,602.14],[-216.95,803.28,-176.47,841.23],[180.26,803.28,219.48,841.23]],"fenetres":[[-502.84,-764.06,-461.09,-626.18],[-502.84,-419.98,-461.09,-282.1],[-502.84,-68.63,-461.09,69.26],[-502.84,282.41,-461.09,420.3],[-502.84,625.86,-461.09,763.74],[461.73,-770.39,502.84,-632.5],[461.73,-426.94,502.84,-289.05],[461.73,-75.27,502.84,62.62],[461.73,275.77,502.84,413.66],[461.73,619.22,502.84,757.1]],"portes":[{"r0":[0.63,-895.1,152.43,-858.25],"r1":[144.76,-878.54,181.61,-726.74],"rm1":[144.76,-1024.92,181.61,-873.12],"eb":[0,-1],"f0":[-1,0]},{"r0":[-151.17,-895.1,0.63,-858.25],"r1":[-180.35,-878.54,-143.49,-726.74],"rm1":[-180.35,-1024.92,-143.49,-873.12],"eb":[0,-1],"f0":[1,0]},{"r0":[-149.9,858.25,1.9,895.1],"r1":[-179.08,726.74,-142.23,878.54],"rm1":[-179.08,873.12,-142.23,1024.92],"eb":[0,1],"f0":[1,0]},{"r0":[1.9,858.25,153.7,895.1],"r1":[146.02,726.74,182.88,878.54],"rm1":[146.02,873.12,182.88,1024.92],"eb":[0,1],"f0":[-1,0]}],"navPlus":[[-339.65,-694.17],[-198.61,-694.17],[-92.35,-694.17],[0.0,-694.17],[92.35,-694.17],[198.61,-694.17],[339.97,-694.17],[-339.65,-351.67],[-198.61,-351.67],[-92.35,-351.67],[0.0,-351.67],[92.35,-351.67],[198.61,-351.67],[339.97,-351.67],[-339.65,0.0],[-198.61,0.0],[-92.35,0.0],[0.0,0.0],[92.35,0.0],[198.61,0.0],[339.97,0.0],[-339.65,351.67],[-198.61,351.67],[-92.35,351.67],[0.0,351.67],[92.35,351.67],[198.61,351.67],[339.97,351.67],[-339.65,694.49],[-198.61,694.49],[-92.35,694.49],[0.0,694.49],[92.35,694.49],[198.61,694.49],[339.97,694.49]]}};

// ─────────────── Porte ─────────────────────────────────────────────
// Fermee, elle bouche l'ouverture entre les piliers. Elle s'ouvre toujours
// du cote oppose a celui qui l'ouvre : vers l'interieur depuis dehors (+1),
// vers l'exterieur depuis dedans (-1), et se range alors contre son pilier.
// Cotes relevees au pixel sur le vrai jeu, rapportees aux piliers de
// maison.png (meme valeurs cote client) :
//  - fermee : ses deux bouts recouvrent exactement la bordure interieure
//    des piliers, son bord bas affleure le bas des piliers ;
//  - ouverte : elle recouvre exactement le pilier cote +u, le bout pivot a
//    V_DEDANS (vers l'interieur) ou V_DEHORS (vers l'exterieur).
const PORTE = (() => {
  const L = 151.8, T = L * 277 / 1141;
  return { L, T, V_FERMEE: 243.0, U_OUVERTE: 85.35, V_DEDANS: 227.1, V_DEHORS: 221.9,
           DUREE: 0.17, PORTEE: R_JOUEUR + 40 };
})();
// La porte de la maison, au meme format que celles des nouveaux batiments
MAISON.portes = [(() => {
  const L = PORTE.L, T = PORTE.T, U = PORTE.U_OUVERTE;
  return { r0: [-L / 2, PORTE.V_FERMEE - T, L / 2, PORTE.V_FERMEE],
           r1: [U - T / 2, PORTE.V_DEDANS - L, U + T / 2, PORTE.V_DEDANS],
           rm1: [U - T / 2, PORTE.V_DEHORS, U + T / 2, PORTE.V_DEHORS + L],
           eb: [0, 1], f0: [-1, 0] };
})()];
MAISON.corps = [-MAISON.U, -MAISON.V, MAISON.U, MAISON.V];
MAISON.sol = [-MAISON.IU, -MAISON.IV, MAISON.IU, MAISON.IV];
HUTTE.sol = [-HUTTE.I, -HUTTE.I, HUTTE.I, HUTTE.I];
HUTTE.portes = [];
HUTTE.corps = [-HUTTE.B, -HUTTE.B, HUTTE.B, HUTTE.B];
HUTTE.emprise = [-HUTTE.B, -HUTTE.B, HUTTE.B, HUTTE.PERRON + 2];
// Tous les batiments, par type
const BATS = Object.assign({ hutte: HUTTE, maison: MAISON }, NOUVEAUX_BATS);
for (const g of Object.values(BATS)) {
  // Boite a quitter a l'atterrissage : les murs (piliers compris), pas les vitres
  let x0 = g.corps[0], y0 = g.corps[1], x1 = g.corps[2], y1 = g.corps[3];
  for (const r of g.murs) { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]); }
  g.sortie = [x0, y0, x1, y1];
}
const estHutte = (o) => o.type === 'hutte';
const estBatiment = (o) => !!BATS[o.type];
function geoBat(o) { return BATS[o.type] || HUTTE; }
const aPorte = (o) => estBatiment(o) && geoBat(o).portes.length > 0;
// Rectangle local d'un battant au repos : 0 fermee, 1 ouverte dedans, -1 dehors
function battantRect(b, etat) { return etat === 1 ? b.r1 : etat === -1 ? b.rm1 : b.r0; }
// Battant au repos (pas en train de tourner) : alors seulement il est solide
const battantAuRepos = (s) => s.a === s.e;
// Coordonnees locales (repere du batiment) d'un point du monde
function versLocal(o, x, y) {
  const q = ((o.rot | 0) % 4 + 4) % 4;
  let u = x - o.x, v = y - o.y;
  if (q === 1) { const t = u; u = v; v = -t; }
  else if (q === 2) { u = -u; v = -v; }
  else if (q === 3) { const t = u; u = -v; v = t; }
  return [u, v];
}
function distRect(u, v, r) {
  const du = Math.max(r[0] - u, 0, u - r[2]), dv = Math.max(r[1] - v, 0, v - r[3]);
  return Math.hypot(du, dv);
}
// Battant a portee de main : distance a sa place fermee ou a sa place
// ouverte. Une double porte : c'est le battant le plus proche qui repond.
function porteProche(p, x, y) {
  let best = null, dMin = PORTE.PORTEE;
  for (const o of batimentsDe(p)) {
    if (!aPorte(o)) continue;
    const g = geoBat(o);
    if (Math.abs(o.x - x) > g.R + 100 || Math.abs(o.y - y) > g.R + 100) continue;
    const [u, v] = versLocal(o, x, y);
    g.portes.forEach((b, i) => {
      const s = o.portes[i];
      let d = distRect(u, v, b.r0);
      if (s.e) d = Math.min(d, distRect(u, v, battantRect(b, s.e)));
      if (d <= dMin) { dMin = d; best = { o, i }; }
    });
  }
  return best;
}
function basculePorte(p, a) {
  const pp = porteProche(p, a.x, a.y);
  if (!pp) return;
  const b = geoBat(pp.o).portes[pp.i], s = pp.o.portes[pp.i];
  if (s.e) s.e = 0;
  else {
    // dehors (au-dela du battant ferme) : il s'ouvre vers l'interieur
    const [u, v] = versLocal(pp.o, a.x, a.y);
    const cu = (b.r0[0] + b.r0[2]) / 2, cv = (b.r0[1] + b.r0[3]) / 2;
    s.e = (u - cu) * b.eb[0] + (v - cv) * b.eb[1] > 0 ? 1 : -1;
  }
  majMurs(p);                             // en mouvement, le battant n'arrete rien
}
// Murs et grille a refaire quand une porte se ferme, s'ouvre ou disparait
function majMurs(p) {
  p.murs = mursDe(p.obs);
  p.mursGrid = p.murs.length ? grilleMurs(p.murs) : null;
}
function majPortes(p, dt) {
  let change = false;
  for (const o of batimentsDe(p)) {
    if (!aPorte(o)) continue;
    for (const s of o.portes) {
      if (battantAuRepos(s)) continue;
      const pas = dt / PORTE.DUREE;
      s.a = Math.abs(s.e - s.a) <= pas ? s.e : s.a + Math.sign(s.e - s.a) * pas;
      // Arrivee : le battant redevient solide. Un joueur qu'il recouvre est
      // repousse par la collision normale, des le tick suivant.
      if (battantAuRepos(s)) change = true;
    }
  }
  if (change) majMurs(p);
}
// Une hutte encaisse les balles (pas les poings). A 0 PV elle devient une
// ruine : plus de toit, plus de murs, donc plus rien de solide.
const PV_HUTTE = 300;

// Rectangle local -> rectangle monde (les quarts de tour gardent les axes)
function rectMonde(o, r) {
  const q = ((o.rot | 0) % 4 + 4) % 4;
  const tr = (u, v) => q === 0 ? [u, v] : q === 1 ? [-v, u] : q === 2 ? [-u, -v] : [v, -u];
  const a = tr(r[0], r[1]), b = tr(r[2], r[3]);
  return { x0: o.x + Math.min(a[0], b[0]), y0: o.y + Math.min(a[1], b[1]),
           x1: o.x + Math.max(a[0], b[0]), y1: o.y + Math.max(a[1], b[1]) };
}
function mursDe(obs) {
  const out = [];
  for (const o of obs) {
    if (!estBatiment(o)) continue;
    const g = geoBat(o);
    for (const r of g.murs) { const w = rectMonde(o, r); w.bat = o; out.push(w); }
    for (const r of (g.fenetres || [])) { const w = rectMonde(o, r); w.bat = o; w.fen = true; out.push(w); }
    // Battant au repos : arrete joueurs et balles, comme un mur
    if (aPorte(o)) g.portes.forEach((b, i) => {
      const st = o.portes[i];
      if (!battantAuRepos(st)) return;
      const w = rectMonde(o, battantRect(b, st.e)); w.bat = o; w.porte = true; out.push(w);
    });
  }
  return out;
}
// Grille des murs : un mur long est range dans toutes les cases qu'il
// touche, marge du rayon d'un joueur comprise.
function grilleMurs(murs) {
  const g = new Map(), m = R_JOUEUR + 4;
  for (const w of murs) {
    const cx0 = Math.floor((w.x0 - m) / GRID_CELL_SZ), cx1 = Math.floor((w.x1 + m) / GRID_CELL_SZ);
    const cy0 = Math.floor((w.y0 - m) / GRID_CELL_SZ), cy1 = Math.floor((w.y1 + m) / GRID_CELL_SZ);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = cx * 10000 + cy;
      let c = g.get(k); if (!c) { c = []; g.set(k, c); }
      c.push(w);
    }
  }
  return g;
}
const VIDE = [];
function mursPres(p, x, y) {
  if (!p.mursGrid) return VIDE;
  return p.mursGrid.get(Math.floor(x / GRID_CELL_SZ) * 10000 + Math.floor(y / GRID_CELL_SZ)) || VIDE;
}
// Sort un cercle d'un mur. Centre dans le mur : par la face la plus proche.
function pousseMur(a, R, w) {
  const qx = Math.max(w.x0, Math.min(w.x1, a.x)), qy = Math.max(w.y0, Math.min(w.y1, a.y));
  const dx = a.x - qx, dy = a.y - qy, d2 = dx * dx + dy * dy;
  if (d2 >= R * R) return false;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    a.x += dx / d * (R - d); a.y += dy / d * (R - d);
  } else {
    const g = a.x - w.x0, dr = w.x1 - a.x, h = a.y - w.y0, b = w.y1 - a.y;
    const mn = Math.min(g, dr, h, b);
    if (mn === g) a.x = w.x0 - R; else if (mn === dr) a.x = w.x1 + R;
    else if (mn === h) a.y = w.y0 - R; else a.y = w.y1 + R;
  }
  return true;
}
// Le segment (x0,y0)->(x1,y1) touche-t-il le mur grossi de r ? Une balle
// parcourt 50 unites par tick, plus que l'epaisseur d'un mur (37) : tester
// le seul point d'arrivee la laisserait passer au travers.
function segmentMur(x0, y0, x1, y1, w, r) {
  return entreeMur(x0, y0, x1, y1, w, r) >= 0;
}
// Fraction du segment ou il entre dans le mur grossi de r (-1 : jamais)
function entreeMur(x0, y0, x1, y1, w, r) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const bords = [[-dx, x0 - (w.x0 - r)], [dx, (w.x1 + r) - x0],
                 [-dy, y0 - (w.y0 - r)], [dy, (w.y1 + r) - y0]];
  for (const [pp, qq] of bords) {
    if (pp === 0) { if (qq < 0) return -1; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return -1; if (t > t0) t0 = t; }
    else { if (t < t0) return -1; if (t < t1) t1 = t; }
  }
  return t0;
}
// Atterrissage au-dessus d'un batiment : impossible de se poser dedans.
// On est deplace juste a cote, par le bord exterieur le plus proche
// (corps, fenetres et piliers compris), sans rien toucher.
function batimentSous(p, x, y) {
  for (const o of batimentsDe(p)) {
    if (!estBatiment(o)) continue;
    const g = geoBat(o), c = g.corps;
    const q = ((o.rot | 0) % 4 + 4) % 4;
    const [u, v] = versLocal(o, x, y);
    // Seul le corps compte : la vitre qui depasse n'arrete plus personne
    if (u > c[0] - R_JOUEUR && u < c[2] + R_JOUEUR && v > c[1] - R_JOUEUR && v < c[3] + R_JOUEUR)
      return { o, u, v, q, g };
  }
  return null;
}
// Les quatre sorties d'un batiment depuis le point (u, v), en coordonnees monde
function sortiesDe(p, s) {
  const M = R_JOUEUR + 2, o = s.o, u = s.u, v = s.v;
  // Boite a quitter : les murs, piliers compris
  const b = s.g.sortie;
  return [[b[0] - M, v], [b[2] + M, v], [u, b[1] - M], [u, b[3] + M]].map(([lu, lv]) => {
    const w = s.q === 0 ? [lu, lv] : s.q === 1 ? [-lv, lu] : s.q === 2 ? [-lu, -lv] : [lv, -lu];
    return { x: Math.min(p.monde - R_JOUEUR, Math.max(R_JOUEUR, o.x + w[0])),
             y: Math.min(p.monde - R_JOUEUR, Math.max(R_JOUEUR, o.y + w[1])) };
  });
}
function sortDuBatiment(p, a) {
  const s0 = batimentSous(p, a.x, a.y);
  if (!s0) return;
  // On part des quatre sorties ; si une sortie tombe sur un batiment voisin
  // (deux huttes collees), on essaie aussi les sorties de ce voisin. On garde
  // le point libre le plus proche de l'endroit ou l'on tombait.
  let front = sortiesDe(p, s0), meilleur = null, dMin = Infinity;
  for (let prof = 0; prof < 3 && front.length; prof++) {
    const suite = [];
    for (const c of front) {
      const s = batimentSous(p, c.x, c.y);
      if (s) { if (prof < 2) suite.push(...sortiesDe(p, s)); continue; }
      const d = Math.hypot(c.x - a.x, c.y - a.y);
      if (d < dMin) { dMin = d; meilleur = c; }
    }
    if (meilleur) break;
    front = suite;
  }
  if (!meilleur) return;       // cas extreme : les murs feront le reste
  a.x = meilleur.x; a.y = meilleur.y;
  a._px = a.x; a._py = a.y;
}
// Dans l'emprise d'une hutte (corps + perron), pour ne rien y faire apparaitre
function dansHutte(obs, x, y, marge) {
  for (const o of obs) {
    if (!estBatiment(o)) continue;
    const [u, v] = versLocal(o, x, y);
    const e = geoBat(o).emprise;
    if (u > e[0] - marge && u < e[2] + marge && v > e[1] - marge && v < e[3] + marge) return true;
  }
  return false;
}
const ZONE_R0 = 1900, ZONE_R1 = 320, ZONE_ATTENTE = 12, ZONE_DUREE = 70, ZONE_DEGATS = 6;
const ZONE_TIC = 0.75;   // les degats de zone tombent par paliers, pas en continu
// Largage : l'avion traverse la carte, les joueurs sautent quand ils veulent
const AVION_V = 420;      // vitesse de l'avion, en unites par seconde
const PARA_DUREE = 10;      // duree de la descente en parachute
const PARA_ESPACE = 260;    // ecart entre deux joueurs largues de force
const PARA_PLONGE = 2;      // bouton de plongee maintenu : descente x2
// Une fois vide ou au bout du couloir, l'avion ne s'evanouit pas : il file
// jusqu'a cette distance au-dela des frontieres. Plus que ce que couvre la
// vue la plus large (zoom 0,75 : ~1300 unites du centre au coin) plus la
// demi-longueur de l'avion, pour que personne ne le voie disparaitre.
const AVION_SORTIE = 2200;
const EAU_LENTEUR = 0.5;    // a pied dans l'eau : deux fois plus lent
const ILE_PASSES = 3;       // passes d'arrondi de la cote (Chaikin)
const RECHARGE_DUREE = 1.4, CHARGEUR = 30;
// Med Kit : 5 s sans bouger ni changer d'emplacement, puis tous les PV
// reviennent et il disparait de l'inventaire
const SOIN_DUREE = 5;
const INV_PARTIE = () => [null, 'fusil', 'medkit', null, null, null];
const MELEE_PORTEE = R_JOUEUR * 4.0, MELEE_DEGATS = 18, MELEE_CD = 0.5;

const DT = 1 / 30; // 30 Hz : charge CPU réduite de moitié
const TICK_MS = 1000 / 30;
const SNAP_TOUS_LES = 1; // snap chaque tick (= 30 Hz)
const DT_MAX_INPUT = 0.05;


// ─────────────── Grille spatiale (bullets vs arbres) ──────────────
// Réduit collision O(balles×arbres) → O(balles×~4 arbres voisins)
const GRID_CELL_SZ = 220; // légèrement plus grand que R_ARBRE*1.3

function buildGrid(arbres) {
  const g = new Map();
  for (const o of arbres) {
    const cx = Math.floor(o.x / GRID_CELL_SZ);
    const cy = Math.floor(o.y / GRID_CELL_SZ);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = (cx + dx) * 10000 + (cy + dy);
      let c = g.get(k); if (!c) { c = []; g.set(k, c); }
      c.push(o);
    }
  }
  return g;
}
// Liste et grille des obstacles ronds solides, refaites des qu'un arbre
// tombe. Les remettre a null en plein tick faisait retomber les
// deplacements suivants sur le decor complet : buissons et batiments
// devenaient des cercles pleins, et les joueurs sautaient de cote.
function majArbres(p) {
  p.arbres = p.obs.filter(estSolide);
  p.arbresGrid = buildGrid(p.arbres);
}
function queryGrid(g, x, y) {
  const k = Math.floor(x / GRID_CELL_SZ) * 10000 + Math.floor(y / GRID_CELL_SZ);
  return g.get(k) || [];
}

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

// ─────────────── Decor de secours (si un fichier map est illisible) ─
function genereDecor(rng, monde) {
  const obs = [];
  const marge = 160, libre = monde - 2 * marge;
  const densite = (monde / MONDE_DEFAUT) * (monde / MONDE_DEFAUT);
  const poser = (n, r, type) => {
    let essais = 0, poses = 0;
    while (poses < n && essais < n * 200) {
      essais++;
      const x = marge + rng() * libre, y = marge + rng() * libre;
      let ok = true;
      for (const o of obs) if (Math.hypot(o.x - x, o.y - y) < o.r + r + 24) { ok = false; break; }
      if (Math.hypot(x - monde / 2, y - monde / 2) < 280) ok = false;
      if (ok) { obs.push({ x, y, r, type, seed: (rng() * 2147483647) | 0 }); poses++; }
    }
  };
  poser(Math.round(N_ARBRES * densite), R_ARBRE, 'arbre');
  poser(Math.round(N_BUISSONS * densite), R_BUISSON, 'buisson');
  return obs;
}

// ─────────────── Cartes (fichiers JSON editables) ─────────────────
// Une carte = { nom, monde, zone, spawns, obs }. Le serveur en est la
// seule source de verite : le client recoit tout via le message init.
const MAPS_DIR = path.join(__dirname, 'maps');
const R_DEFAUT = { arbre: R_ARBRE, buisson: R_BUISSON };

function nombre(v, defaut) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defaut;
}

// Taille du monde et cyclone ne se reglent plus dans l'editeur : ce sont
// toujours les memes. Une carte qui ne les donne pas prend ces valeurs.
const CARTE_DEFAUT = {
  partie: { monde: 25600, zone: {"cx": 12800, "cy": 12800, "r0": 19305, "attente": 20, "vagues": [{"r": 7500, "duree": 60, "pause": 30, "degats": 2}, {"r": 4300, "duree": 30, "pause": 15, "degats": 5}, {"r": 2400, "duree": 25, "pause": 20, "degats": 10}, {"r": 1300, "duree": 20, "pause": 15, "degats": 15}, {"r": 650, "duree": 15, "pause": 20, "degats": 15}, {"r": 0, "duree": 45, "pause": 0, "degats": 15}]} },
  lobby:  { monde: 3200,  zone: {"cx": 1600, "cy": 1600, "r0": 1900, "attente": 20, "vagues": [{"r": 700, "duree": 30, "pause": 20, "degats": 2}, {"r": 250, "duree": 20, "pause": 15, "degats": 5}, {"r": 0, "duree": 30, "pause": 0, "degats": 10}]} },
};

function valideMap(brut, nom) {
  if (!brut || typeof brut !== 'object') throw new Error('racine invalide');
  const defaut = CARTE_DEFAUT[nom] || CARTE_DEFAUT.partie;
  if (brut.monde === undefined) brut = Object.assign({}, brut, { monde: defaut.monde });
  if (!brut.zone) brut = Object.assign({}, brut, { zone: defaut.zone });
  const monde = nombre(brut.monde, NaN);
  if (!Number.isFinite(monde) || monde < 500) throw new Error('champ monde invalide');
  if (!Array.isArray(brut.obs)) throw new Error('champ obs manquant');

  const obs = [];
  for (let i = 0; i < brut.obs.length; i++) {
    const o = brut.obs[i] || {};
    const x = nombre(o.x, NaN), y = nombre(o.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('obs[' + i + '] : x/y invalide');
    // Hutte : modele 1 ou 2, orientation en quarts de tour. Taille fixe.
    if (BATS[o.type] && o.type !== 'hutte') {
      obs.push({ x, y, r: BATS[o.type].R, type: o.type,
                 rot: ((nombre(o.rot, 0) | 0) % 4 + 4) % 4, seed: nombre(o.seed, 0) | 0 });
      continue;
    }
    if (o.type === 'hutte') {
      obs.push({ x, y, r: HUTTE.R, type: 'hutte', v: o.v === 2 ? 2 : 1,
                 rot: ((nombre(o.rot, 0) | 0) % 4 + 4) % 4, seed: nombre(o.seed, 0) | 0 });
      continue;
    }
    const type = o.type === 'buisson' ? 'buisson' : 'arbre';
    // Arbres et buissons ont toujours la meme taille, quoi que dise le
    // fichier : un r arrondi ou ancien dans une carte ne change rien.
    const r = type === 'buisson' ? R_BUISSON : R_ARBRE;
    let seed = nombre(o.seed, 0) | 0;
    if (!seed) seed = Math.imul(i + 1, 2654435761) | 0;
    obs.push({ x, y, r, type, seed });
  }

  const z = brut.zone || {};
  // Une vague = un resserrement vers un nouveau centre, puis une pause.
  // Une carte sans 'vagues' garde l'ancien comportement : un seul
  // resserrement au centre, decrit par r1 et duree.
  let vagues = Array.isArray(z.vagues) ? z.vagues.filter(v => v && Number.isFinite(Number(v.r))) : [];
  if (!vagues.length) {
    vagues = [{ r: nombre(z.r1, monde * 0.10), duree: nombre(z.duree, ZONE_DUREE),
                pause: 0, degats: ZONE_DEGATS, fixe: true }];
  }
  vagues = vagues.map(v => ({
    r: Math.max(0, nombre(v.r, 0)),
    duree: Math.max(0.5, nombre(v.duree, ZONE_DUREE)),
    pause: Math.max(0, nombre(v.pause, 0)),
    degats: Math.max(0, nombre(v.degats, ZONE_DEGATS)),
    fixe: !!v.fixe,
  }));

  const zone = {
    cx: nombre(z.cx, monde / 2),
    cy: nombre(z.cy, monde / 2),
    r0: nombre(z.r0, monde * 0.60),
    r1: vagues[vagues.length - 1].r,     // rayon final, pour le client
    attente: nombre(z.attente, ZONE_ATTENTE),
    duree: Math.max(1, nombre(z.duree, ZONE_DUREE)),
    vagues,
  };
  // Au depart, le cyclone doit rester hors de la carte depliee tout entiere,
  // bande d'eau autour comprise (CARTE_MARGE = 0,025 du cote de la fenetre
  // cote client) : sinon son bord se voit des l'ouverture de la carte. On
  // l'eloigne donc au besoin jusqu'au coin le plus lointain, plus une marge.
  const bandeCarte = monde * 0.025 / (1 - 2 * 0.025);
  let coinLoin = 0;
  for (const x of [-bandeCarte, monde + bandeCarte]) for (const y of [-bandeCarte, monde + bandeCarte])
    coinLoin = Math.max(coinLoin, Math.hypot(x - zone.cx, y - zone.cy));
  zone.r0 = Math.max(zone.r0, Math.ceil(coinLoin + 250));

  // Contour de l'ile : tout ce qui est dehors est de l'eau. Pas de contour
  // = carte entierement terrestre, comme avant.
  let ile = null;
  if (Array.isArray(brut.ile)) {
    const pts = brut.ile
      .map(q => Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]) }
                                 : { x: Number(q && q.x), y: Number(q && q.y) })
      .filter(q => Number.isFinite(q.x) && Number.isFinite(q.y));
    if (pts.length >= 3) ile = pts;
  }

  // Points d'eau (lacs, rivieres...) : des contours comme la cote, mais
  // l'interieur est de l'eau. Meme arrondi.
  const contours = liste => {
    const res = [];
    if (!Array.isArray(liste)) return res;
    for (const l of liste) {
      if (!Array.isArray(l)) continue;
      const pts = l.map(q => Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]) }
                                              : { x: Number(q && q.x), y: Number(q && q.y) })
                   .filter(q => Number.isFinite(q.x) && Number.isFinite(q.y))
                   .map(q => ({ x: Math.round(q.x), y: Math.round(q.y) }));
      if (pts.length >= 3) res.push(pts);
    }
    return res;
  };
  const lacs = contours(brut.lacs);
  // Zones enneigees : memes contours, decor seulement (aucun effet ici,
  // le client ne fait que changer la couleur du sol)
  const neiges = contours(brut.neiges);
  const lacsCourbes = lacs.map(l => { const c = courbeIle(l); return { pts: c, boite: boiteDe(c) }; });

  const spawns = Array.isArray(brut.spawns)
    ? brut.spawns
        .filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        .map(p => ({ x: Number(p.x), y: Number(p.y) }))
    : [];

  // Chemins de terre : purement decoratifs (ni collision ni ralentissement).
  // traces : les lignes dessinees dans l'editeur (points + graine du trace
  // irregulier) ; raccords : les arrondis aux croisements, calcules par
  // l'editeur. Le client en deduit la forme ; ici on ne fait que verifier.
  const point = q => Array.isArray(q) ? [Number(q[0]), Number(q[1])] : [Number(q && q.x), Number(q && q.y)];
  const points = l => Array.isArray(l) ? l.map(point).filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1]))
                                              .map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]) : [];
  const chemins = { traces: [], raccords: [] };
  const bc = brut.chemins;
  if (bc && typeof bc === 'object' && !Array.isArray(bc)) {
    for (const t of (Array.isArray(bc.traces) ? bc.traces : [])) {
      const pts = points(t && t.pts);
      if (pts.length >= 2) chemins.traces.push({ seed: nombre(t.seed, 1) | 0, pts });
    }
    for (const r of (Array.isArray(bc.raccords) ? bc.raccords : [])) {
      const pts = points(r);
      if (pts.length >= 3) chemins.raccords.push(pts);
    }
  }

  // La carte ne stocke que des points de controle : la vraie cote, arrondie,
  // en est deduite ici, exactement comme cote client et dans l'editeur.
  const ileCourbe = ile ? courbeIle(ile) : null;
  return { nom: brut.nom || nom, monde, zone, spawns, obs, ile, ileCourbe, chemins, lacs, lacsCourbes, neiges,
           ileBoite: ileCourbe ? boiteDe(ileCourbe) : null };
}

function mapSecours(nom) {
  const rng = creeRng((Math.random() * 1e9) | 0);
  const monde = MONDE_DEFAUT;
  return {
    nom: nom + '(secours)', monde,
    zone: { cx: monde / 2, cy: monde / 2, r0: ZONE_R0, r1: ZONE_R1,
            attente: ZONE_ATTENTE, duree: ZONE_DUREE,
            vagues: [{ r: ZONE_R1, duree: ZONE_DUREE, pause: 0, degats: ZONE_DEGATS, fixe: true }] },
    spawns: [], obs: genereDecor(rng, monde),
  };
}

// Les cartes ne changent pas en cours d'execution : on les lit une fois.
const mapsCache = {};
function chargeMap(nom) {
  if (mapsCache[nom]) return mapsCache[nom];
  let m;
  try {
    const brut = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, nom + '.json'), 'utf8'));
    m = valideMap(brut, nom);
    console.log('[map] ' + nom + ' : ' + m.obs.length + ' objets, monde ' + m.monde);
  } catch (e) {
    console.error('[map] ' + nom + ' illisible (' + e.message + ') -> carte aleatoire de secours');
    m = mapSecours(nom);
  }
  mapsCache[nom] = m;
  return m;
}

function uid() { return Math.random().toString(36).slice(2, 11); }

// sansSpawns : on ignore les points d'apparition de la carte et on cherche
// n'importe quelle place libre. C'est ce que fait le lobby, pour que les
// joueurs n'arrivent pas tous au meme endroit.
function placer(rng, map, obs, sansSpawns) {
  const monde = map.monde;
  const libre = (x, y) => {
    if (x < 150 || x > monde - 150 || y < 150 || y > monde - 150) return false;
    for (const o of obs) {
      if (!estSolide(o)) continue;
      if (Math.hypot(o.x - x, o.y - y) < o.r + R_JOUEUR + 20) return false;
    }
    if (dansHutte(obs, x, y, R_JOUEUR + 20)) return false;
    return true;
  };

  if (map.spawns.length && !sansSpawns) {
    for (let i = 0; i < 200; i++) {
      const s = map.spawns[(rng() * map.spawns.length) | 0];
      const ang = rng() * Math.PI * 2, d = rng() * 140;
      const x = s.x + Math.cos(ang) * d, y = s.y + Math.sin(ang) * d;
      if (libre(x, y)) return { x, y };
    }
    return { x: map.spawns[0].x, y: map.spawns[0].y };
  }

  for (let i = 0; i < 300; i++) {
    const ang = rng() * Math.PI * 2, dist = 200 + rng() * (monde * 0.375);
    const x = monde / 2 + Math.cos(ang) * dist, y = monde / 2 + Math.sin(ang) * dist;
    if (libre(x, y)) return { x, y };
  }
  return { x: monde / 2, y: monde / 2 };
}

// Copie de travail des obstacles d'une carte. Le lobby recoit en plus son
// orbe central, qui n'est donc dans aucun fichier de carte.
function obsDeMap(map) {
  const obs = map.obs.map(o => estBatiment(o) && !estHutte(o)
    // maison et batiments 1 a 3 : indestructibles, un etat par battant
    ? { x: o.x, y: o.y, r: o.r, type: o.type, rot: o.rot, seed: o.seed, secousse: 0, _lt: o.type,
        portes: geoBat(o).portes.map(() => ({ e: 0, a: 0 })), _lp: '' }
    : estHutte(o)
    ? { x: o.x, y: o.y, r: o.r, type: 'hutte', v: o.v, rot: o.rot, seed: o.seed,
        pv: PV_HUTTE, secousse: 0, _lt: 'hutte' }
    : { x: o.x, y: o.y, r: o.r, type: o.type, seed: o.seed,
        pv: PV_ARBRE, secousse: 0, _lt: o.type });
  if (map.nom === 'lobby') {
    obs.push({ x: map.monde / 2, y: map.monde / 2, r: R_ORBE, type: 'orbe',
               seed: 424242, pv: PV_ORBE, secousse: 0, _lt: 'orbe' });
  }
  return obs;
}

function creePartie(nomMap) {
  const map = chargeMap(nomMap || 'lobby');
  const rng = creeRng((Math.random() * 1e9) | 0);
  // Des le lobby, on sait a quoi ressemblera la partie : on tire le couloir
  // de vol maintenant et on envoie la carte de partie en apercu, pour que
  // chacun puisse etudier le trajet avant le decollage. La partie reprendra
  // ce meme couloir, sinon l'apercu mentirait.
  let avionPrevu = null;
  if ((nomMap || 'lobby') === 'lobby') {
    const mp = chargeMap('partie');
    avionPrevu = creeAvion(rng, mp.monde);
  }
  // Copie de travail : la carte de reference n'est jamais modifiee
  const obs = obsDeMap(map);
  // Les huttes sont indestructibles : leurs murs ne changent jamais
  const murs = mursDe(obs);
  return {
    map, monde: map.monde, mapVer: 1, avionPrevu,
    rng, obs, arbres: obs.filter(estSolide), arbresGrid: null,   // grille : voir majArbres
    murs, mursGrid: murs.length ? grilleMurs(murs) : null,
    t: 0, tick: 0, fini: false, vainqueur: null,
    demarree: false, nbMax: 0, balleId: 0,
    zone: { x: map.zone.cx, y: map.zone.cy, r: map.zone.r0 },
    zoneCible: null, zoneDepart: null, zoneDegats: 0, zoneT: 0, zoneBouge: false,
    _bornes: null, _cibleIdx: -1,
    balles: [], agents: {}, kills: [], evts: [],
    avion: null, tVol: 0, phaseVol: false,
  };
}

function ajouteJoueur(partie, pid, name, avecArme = true) {
  partie.nbMax++;
  // Dans le lobby, chacun arrive a un endroit libre au hasard
  const pos = placer(partie.rng, partie.map, partie.obs, partie.map.nom === 'lobby');
  partie.agents[pid] = {
    id: pid, name, x: pos.x, y: pos.y,
    pv: PV_MAX, angle: 0, recharge: 0, vivant: true,
    secousse: 0, touche: 0, tirTimer: 0, recul: 0, revele: 0,
    munitions: CHARGEUR, rechargement: 0, dureeRechargeMax: 0, slot: 0,
    poingTimer: 0, punchSide: 0, _pCd: 0,
    inv: avecArme ? INV_PARTIE() : [null, null, null, null, null, null], soin: 0,
    ticZone: 0, lastSeq: 0, file: [], rtt: 120,
    enAvion: false, para: 0, plonge: false,
  };
}

// Un seul chemin pour tuer un agent : la place et le tueur sont ainsi
// toujours renseignes, quelle que soit la cause.
function tue(p, c, tueur, etiquette) {
  if (!c.vivant) return;
  c.pv = 0; c.vivant = false;
  c.tueurId = tueur ? tueur.id : null;
  let vivants = 0;
  for (const x of Object.values(p.agents)) if (x.vivant) vivants++;
  c.place = vivants + 1;           // en se comptant lui-meme
  p.kills.push({ killer: tueur ? tueur.name : (etiquette || 'Zone'), victim: c.name });
}

// Simulation des balles, isolee pour pouvoir continuer a tourner une fois
// la partie terminee.
// Une balle qui touche un mur ou un arbre n'est pas effacee sur-le-champ :
// elle est posee contre l'obstacle (pointe au contact) et envoyee une
// derniere fois, marquee fin ; le client la fait alors disparaitre en fondu.
const RECUL_IMPACT = R_JOUEUR * 0.46 - R_BALLE;   // demi-longueur du dessin moins le rayon de contact
function poseImpact(b, dx, dy, t) {
  const l = Math.hypot(dx, dy) || 1;
  const d = Math.max(0, t * l - RECUL_IMPACT);
  b.x += dx / l * d; b.y += dy / l * d;
  b.fin = 1;
}
// Fraction du segment (x0,y0)+t(dx,dy) ou il entre dans le cercle
// (cx, cy, R) ; 0 s'il part de dedans, -1 s'il ne le touche pas.
function entreeCercle(x0, y0, dx, dy, cx, cy, R) {
  const fx = x0 - cx, fy = y0 - cy;
  const C = fx * fx + fy * fy - R * R;
  if (C <= 0) return 0;
  const A = dx * dx + dy * dy;
  if (A === 0) return -1;
  const B = 2 * (fx * dx + fy * dy);
  const disc = B * B - 4 * A * C;
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : -1;
}
// Premier obstacle sur le trajet d'une balle, tout le long du segment (pas
// seulement au point d'arrivee : sinon un obstacle fin, ou colle au tireur,
// se laisse traverser). Murs et portes, arbres, joueurs. Les fenetres,
// elles, laissent passer. Retourne { t, genre, o } ou null.
function premierImpact(p, x0, y0, x1, y1, parId, joueurs) {
  const dx = x1 - x0, dy = y1 - y0;
  let best = null;
  const garde = (t, genre, o) => { if (t >= 0 && (!best || t < best.t)) best = { t, genre, o }; };
  if (p.mursGrid) {
    const vus = new Set();
    for (const q of [[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2], [x1, y1]]) {
      for (const w of mursPres(p, q[0], q[1])) {
        if (vus.has(w) || w.fen || !estBatiment(w.bat)) continue; vus.add(w);
        garde(entreeMur(x0, y0, x1, y1, w, R_BALLE), 'mur', w.bat);
      }
    }
  }
  const vusA = new Set();
  const sources = p.arbresGrid
    ? [queryGrid(p.arbresGrid, x0, y0), queryGrid(p.arbresGrid, x1, y1)]
    : [p.arbres || p.obs];
  for (const liste of sources) for (const o of liste) {
    if (vusA.has(o) || !estSolide(o)) continue; vusA.add(o);
    garde(entreeCercle(x0, y0, dx, dy, o.x, o.y, o.r + R_BALLE), 'arbre', o);
  }
  if (joueurs) for (const c of Object.values(p.agents)) {
    if (!c.vivant || c.id === parId) continue;
    if (c.enAvion || c.para > 0) continue;       // un parachutiste est hors d'atteinte
    garde(entreeCercle(x0, y0, dx, dy, c.x, c.y, R_JOUEUR + R_BALLE), 'joueur', c);
  }
  return best;
}
// Effet d'un impact sur ce qui est touche (la balle, elle, est geree a part)
function subitImpact(p, h, tireur) {
  if (h.genre === 'mur') {
    const bat = h.o;
    if (estHutte(bat)) {
      bat.pv -= p.rng() < 0.5 ? 10 : 11; bat.secousse = 0.22;
      if (bat.pv <= 0) {
        bat.pv = 0; bat.type = 'ruine'; bat.secousse = 0;
        majMurs(p);                        // les murs de la ruine disparaissent
      }
    }
  } else if (h.genre === 'arbre') {
    const o = h.o;
    o.pv -= p.rng() < 0.5 ? 10 : 11; o.secousse = 0.22;
    if (o.pv <= 0) { o.pv = 0; o.type = 'souche'; o.secousse = 0; majArbres(p); }
  } else if (h.genre === 'joueur') {
    const c = h.o;
    c.pv -= p.rng() < 0.5 ? 10 : 11;
    c.secousse = 0.16; c.touche = 0.30; c.revele = 0.35;
    if (c.pv <= 0) tue(p, c, tireur || null, '?');
  }
}
function majBalles(p, arr) {
  for (let k = p.balles.length - 1; k >= 0; k--) {
    const b = p.balles[k];
    if (b.fin) { p.balles.splice(k, 1); continue; }   // son impact a deja ete montre
    const dx = b.vx * DT, dy = b.vy * DT;
    b.reste -= Math.hypot(dx, dy);
    if (b.reste <= 0) { p.balles.splice(k, 1); continue; }
    // Supprimer si hors map
    const nx = b.x + dx, ny = b.y + dy;
    if (nx < 0 || nx > p.monde || ny < 0 || ny > p.monde) { p.balles.splice(k, 1); continue; }
    // Partie finie : les balles finissent leur trajet mais ne blessent plus
    const h = premierImpact(p, b.x, b.y, nx, ny, b.par, !p.fini);
    if (!h) { b.x = nx; b.y = ny; continue; }
    subitImpact(p, h, p.agents[b.par]);
    // Mur, porte ou arbre : la balle est posee contre, puis s'efface en
    // fondu cote client. Joueur : elle disparait dans le joueur.
    if (h.genre === 'joueur') p.balles.splice(k, 1);
    else poseImpact(b, dx, dy, h.t);
  }
}

// ─────────────── Avion de largage ──────────────────────────────────
// Un point au hasard sur un cote, un autre sur le cote oppose : la
// droite qui les relie est le couloir de vol.
// Le couloir commence et finit un peu en retrait des bords (4 % de la
// carte), comme dans le vrai jeu.
function creeAvion(rng, monde) {
  const marge = monde * 0.12, retrait = monde * 0.04;
  const surCote = (cote, u) => {
    const v = marge + u * (monde - 2 * marge);
    if (cote === 0) return { x: v, y: retrait };
    if (cote === 1) return { x: monde - retrait, y: v };
    if (cote === 2) return { x: v, y: monde - retrait };
    return { x: retrait, y: v };
  };
  const cote = (rng() * 4) | 0;
  let a = surCote(cote, rng());
  let b = surCote((cote + 2) % 4, rng());
  if (rng() < 0.5) { const t = a; a = b; b = t; }   // sens de parcours
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, len,
           duree: Math.max(1, len / AVION_V),
           angle: Math.atan2(b.y - a.y, b.x - a.x),
           x: a.x, y: a.y, enVol: true };
}

function posAvion(p) {
  const av = p.avion;
  if (!av) return { x: p.monde / 2, y: p.monde / 2 };
  // Au-dela du bout du couloir, l'avion poursuit tout droit sur sa lancee
  const w = av.duree > 0 ? p.tVol / av.duree : 1;
  return { x: av.x0 + (av.x1 - av.x0) * w, y: av.y0 + (av.y1 - av.y0) * w };
}

// Point de chute d'un bot : tire au hasard dans la carte, loin des bords.
function choisitChute(p, a) {
  const m = p.monde, marge = m * 0.10;
  a._chute = { x: marge + Math.random() * (m - 2 * marge),
               y: marge + Math.random() * (m - 2 * marge) };
}

// Fait sauter un agent depuis la position courante de l'avion.
function largue(p, a, decalage) {
  if (!a.enAvion) return;
  a.enAvion = false;
  a.para = PARA_DUREE;
  const av = p.avion;
  const d = decalage || 0;
  // Decalage perpendiculaire au couloir, pour ne pas empiler les largages
  a.x = a.x + Math.cos(av.angle + Math.PI / 2) * d;
  a.y = a.y + Math.sin(av.angle + Math.PI / 2) * d;
  a.x = Math.min(p.monde - R_JOUEUR, Math.max(R_JOUEUR, a.x));
  a.y = Math.min(p.monde - R_JOUEUR, Math.max(R_JOUEUR, a.y));
  a._px = a.x; a._py = a.y;
}

function majVol(p) {
  // Deux choses distinctes : le LARGAGE (des passagers peuvent encore etre a
  // bord, l'horloge de partie attend) et le VOL de l'avion, qui continue
  // bien apres, meme a vide, jusqu'a sortir de la vue de tout le monde.
  if (!p.avion || !p.avion.enVol) return;
  p.tVol += DT;
  const pos = posAvion(p);
  p.avion.x = pos.x; p.avion.y = pos.y;
  const S = AVION_SORTIE;
  if (pos.x < -S || pos.y < -S || pos.x > p.monde + S || pos.y > p.monde + S) {
    p.avion.enVol = false;
  }
  if (!p.phaseVol) return;

  // Les passagers suivent l'avion tant qu'ils n'ont pas saute
  const dedans = [];
  for (const a of Object.values(p.agents)) {
    if (!a.enAvion) continue;
    a.x = pos.x; a.y = pos.y; a._px = pos.x; a._py = pos.y;
    dedans.push(a);
  }

  // Bout du couloir : tout le monde saute, espace le long de la trajectoire
  if (p.tVol >= p.avion.duree && dedans.length) {
    dedans.forEach((a, i) => {
      const k = i - (dedans.length - 1) / 2;
      largue(p, a, k * PARA_ESPACE);
    });
  }

  // Le vol s'acheve quand l'avion est au bout, ou quand il est vide
  let reste = 0;
  for (const a of Object.values(p.agents)) if (a.enAvion) reste++;
  if (reste === 0 || p.tVol >= p.avion.duree) p.phaseVol = false;
}

// ─────────────── Cyclone ───────────────────────────────────────────
// Une vague = la pause qui la precede, puis son resserrement. Rattacher
// la pause a la vague QUI SUIT permet d'annoncer le prochain cercle des
// le debut de cette pause, au lieu de le reveler au dernier moment.
function bornesVagues(zc) {
  const b = []; let t = 0;
  for (let i = 0; i < zc.vagues.length; i++) {
    const pause = i === 0 ? zc.attente : zc.vagues[i - 1].pause;
    b.push({ tDebut: t + pause, tFin: t + pause + zc.vagues[i].duree });
    t += pause + zc.vagues[i].duree;
  }
  return b;
}

// Nouveau centre : entierement dans la carte, et entierement dans le
// cercle precedent pour que le cyclone ne recrache jamais de terrain.
function choisitCentreZone(rng, monde, prec, rNew) {
  if (rNew <= 0) return { x: prec.x, y: prec.y };   // la vague finale ferme le dernier cercle
  const dMax = Math.max(0, prec.r - rNew);
  for (let i = 0; i < 300; i++) {
    const ang = rng() * Math.PI * 2;
    const dist = Math.sqrt(rng()) * dMax;
    const x = prec.x + Math.cos(ang) * dist;
    const y = prec.y + Math.sin(ang) * dist;
    if (x >= rNew && x <= monde - rNew && y >= rNew && y <= monde - rNew) return { x, y };
  }
  // Repli : le centre precedent, ramene dans la carte
  return { x: Math.min(monde - rNew, Math.max(rNew, prec.x)),
           y: Math.min(monde - rNew, Math.max(rNew, prec.y)) };
}

function majZone(p) {
  const zc = p.map.zone;
  if (!p._bornes) p._bornes = bornesVagues(zc);
  const B = p._bornes, t = p.t;

  if (!p.demarree || p.phaseVol) {
    p.zoneCible = null; p.zoneBouge = false;
    p.zoneDegats = zc.vagues[0].degats; p.zoneT = zc.attente;
    return;
  }

  // Vague courante : la premiere dont le resserrement n'est pas fini
  let idx = -1;
  for (let i = 0; i < B.length; i++) if (t < B[i].tFin) { idx = i; break; }

  if (idx === -1) {                      // plus rien a jouer : carte entierement avalee
    if (p.zoneCible) { p.zone.x = p.zoneCible.x; p.zone.y = p.zoneCible.y; }
    p.zone.r = 0;
    p.zoneCible = null; p.zoneBouge = false;
    p.zoneDegats = zc.vagues[zc.vagues.length - 1].degats;
    p.zoneT = 0;
    return;
  }

  // La cible est tiree des l'entree dans la phase, donc pendant la pause
  // qui precede : les joueurs voient ou aller avant que ca bouge.
  if (p._cibleIdx !== idx) {
    // Le dernier tick d'un resserrement tombe avant sa borne de fin : sans
    // ce recalage le cercle s'arrete quelques unites trop grand, et peut
    // alors depasser de la carte.
    if (p.zoneCible) {
      p.zone.x = p.zoneCible.x; p.zone.y = p.zoneCible.y; p.zone.r = p.zoneCible.r;
    }
    p._cibleIdx = idx;
    p.zoneDepart = { x: p.zone.x, y: p.zone.y, r: p.zone.r };
    const v0 = zc.vagues[idx];
    const c = v0.fixe ? { x: zc.cx, y: zc.cy }
                      : choisitCentreZone(p.rng, p.monde, p.zoneDepart, v0.r);
    p.zoneCible = { x: c.x, y: c.y, r: v0.r };
  }

  const v = zc.vagues[idx], b = B[idx];
  if (t < b.tDebut) {                    // pause : la cible existe mais reste secrete
    p.zoneBouge = false;
    p.zoneDegats = idx === 0 ? v.degats : zc.vagues[idx - 1].degats;
    p.zoneT = b.tDebut - t;
  } else {                               // resserrement en cours
    p.zoneBouge = true;
    const w = Math.min(1, (t - b.tDebut) / v.duree);
    p.zone.x = p.zoneDepart.x + (p.zoneCible.x - p.zoneDepart.x) * w;
    p.zone.y = p.zoneDepart.y + (p.zoneCible.y - p.zoneDepart.y) * w;
    p.zone.r = p.zoneDepart.r + (p.zoneCible.r - p.zoneDepart.r) * w;
    p.zoneDegats = v.degats;
    p.zoneT = b.tFin - t;
  }
}

// ─────────────── Deplacement ───────────────────────────────────────
// Point dans le polygone de l'ile (lancer de rayon). Sans contour, toute
// la carte est terrestre. Meme fonction, au caractere pres, cote client :
// une divergence ici ferait sautiller le joueur sur la cote.
// Arrondi de la cote : Chaikin, trois passes. Chaque passe coupe tous les
// coins au quart ; a la limite on obtient une courbe lisse (B-spline
// quadratique). Meme code, au caractere pres, dans le client et l'editeur :
// la cote que l'on voit est exactement celle qui ralentit.
function courbeIle(ctrl) {
  let pts = ctrl;
  for (let k = 0; k < ILE_PASSES; k++) {
    const q = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      q.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      q.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    pts = q;
  }
  return pts;
}
function boiteDe(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) {
    if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

function dansContour(c, b, x, y) {
  if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return false;
  let dedans = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const xi = c[i].x, yi = c[i].y, xj = c[j].x, yj = c[j].y;
    if ((yi > y) !== (yj > y) &&
        x < (xj - xi) * (y - yi) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}
// Sur la terre : dans l'ile (s'il y en a une) et hors de tout point d'eau
function dansIle(p, x, y) {
  const m = p.map;
  if (!m) return true;
  if (m.ileCourbe && !dansContour(m.ileCourbe, m.ileBoite, x, y)) return false;
  const l = m.lacsCourbes;
  if (l) for (let i = 0; i < l.length; i++) if (dansContour(l[i].pts, l[i].boite, x, y)) return false;
  return true;
}

function borne(a, monde) {
  a.x = Math.min(monde - R_JOUEUR, Math.max(R_JOUEUR, a.x));
  a.y = Math.min(monde - R_JOUEUR, Math.max(R_JOUEUR, a.y));
}

function deplaceSolo(a, dx, dy, obs, maxIter, monde, grid, p) {
  a.x += dx; a.y += dy; borne(a, monde);
  // obs doit déjà être la liste des arbres (pré-filtrée).
  // Avec une grande carte la liste complete coute cher : on interroge la
  // grille autour du joueur, recalculee a chaque iteration puisqu'il bouge.
  for (let it = 0; it < maxIter; it++) {
    let hit = false;
    const proches = grid ? queryGrid(grid, a.x, a.y) : obs;
    for (const o of proches) {
      // pas de filtre type ici (obs = arbres uniquement)
      const nx = a.x - o.x, ny = a.y - o.y;
      const d = Math.hypot(nx, ny), min = o.r + R_JOUEUR;
      if (d < min) {
        hit = true;
        if (d < 1e-6) { a.x += min; continue; }
        a.x += nx / d * (min - d); a.y += ny / d * (min - d);
      }
    }
    // murs des huttes
    if (p && p.mursGrid) for (const w of mursPres(p, a.x, a.y)) if (pousseMur(a, R_JOUEUR, w)) hit = true;
    if (!hit) break;
  }
  borne(a, monde);
}

function separeJoueurs(arr, monde) {
  for (const a of arr) {
    if (!a.vivant || a.enAvion || a.para > 0) continue;
    for (const b of arr) {
      if (b === a || !b.vivant || b.enAvion || b.para > 0) continue;
      const nx = a.x - b.x, ny = a.y - b.y;
      const d = Math.hypot(nx, ny), min = R_JOUEUR * 2;
      if (d >= min) continue;
      // Superposition exacte : sans direction de sortie les deux joueurs
      // restaient colles indefiniment. On en impose une.
      let ux = 1, uy = 0;
      if (d > 1e-6) { ux = nx / d; uy = ny / d; }
      const p = (min - d) * 0.5;
      a.x += ux * p; a.y += uy * p;
      b.x -= ux * p; b.y -= uy * p;
      borne(a, monde); borne(b, monde);
    }
  }
}

// Une commande venue du reseau : que des nombres finis, sinon un seul NaN
// (x += NaN) rendait la position du joueur definitivement invalide.
const fini = (v) => typeof v === 'number' && Number.isFinite(v);
function nettoieCmd(c) {
  if (!c || typeof c !== 'object' || !fini(c.seq)) return null;
  const out = {
    seq: c.seq,
    mx: fini(c.mx) ? Math.max(-1, Math.min(1, c.mx)) : 0,
    my: fini(c.my) ? Math.max(-1, Math.min(1, c.my)) : 0,
    dt: fini(c.dt) ? c.dt : DT,
    tire: !!c.tire, poing: !!c.poing, recharger: !!c.recharger,
    plonge: !!c.plonge, inter: !!c.inter,
  };
  if (fini(c.angle)) out.angle = c.angle;
  return out;
}

// ─────────────── Commande d'un joueur ─────────────────────────────
function appliqueCommande(p, a, cmd, mouvSeulement = false) {
  // Dans l'avion : le joueur n'a pas encore de prise sur le monde
  if (a.enAvion) { a.lastSeq = cmd.seq; if (typeof cmd.angle === 'number') a.angle = cmd.angle; return; }
  const objet = a.inv && a.inv[a.slot];
  // Bouton d'action (a pied) : Med Kit en main, il lance le soin s'il
  // manque des PV (sinon rien) ; sinon il ouvre ou ferme la porte a portee.
  if (cmd.inter && !(a.para > 0) && !(a._interCd > 0)) {
    a._interCd = 0.2;
    if (objet === 'medkit') { if (a.pv < PV_MAX && !(a.soin > 0)) a.soin = SOIN_DUREE; }
    else basculePorte(p, a);
  }
  let dt = Math.min(DT_MAX_INPUT, Math.max(0, cmd.dt || DT));
  let mx = cmd.mx || 0, my = cmd.my || 0;
  const n = Math.hypot(mx, my);
  if (n > 1) { mx /= n; my /= n; }
  // Soin en cours : se deplacer ou lacher le Med Kit l'annule ; tourner, non
  if (a.soin > 0) {
    if (mx !== 0 || my !== 0 || objet !== 'medkit' || a.para > 0) a.soin = 0;
    else {
      a.soin -= dt;
      if (a.soin <= 0) {
        a.soin = 0; a.pv = PV_MAX;
        a.inv = a.inv.slice(); a.inv[a.slot] = null;    // utilise : l'emplacement se vide
      }
    }
  }

  // En parachute on survole le decor : deplacement libre, juste borne
  if (a.para > 0) {
    a.x += mx * VITESSE * dt; a.y += my * VITESSE * dt;
    borne(a, p.monde);
    if (typeof cmd.angle === 'number') a.angle = cmd.angle;
    a.plonge = !!cmd.plonge;      // bouton maintenu : on tombe deux fois plus vite
    a.lastSeq = cmd.seq;
    return;
  }

  // Dans l'eau, on avance deux fois moins vite. A pied seulement : en
  // parachute et en avion la question ne se pose pas, ces branches sont
  // sorties plus haut.
  const vit = VITESSE * (dansIle(p, a.x, a.y) ? 1 : EAU_LENTEUR);
  // Bots : 1 itération de collision (précision réduite mais 3× plus rapide)
  // Bots comme joueurs : 3 passes de collision. Une seule laissait un bot
  // pris entre deux murs (un coin, une porte) ressortir d'un cote puis de
  // l'autre d'un tick a l'autre : il tremblait sur place.
  if (!p.arbresGrid) majArbres(p);
  deplaceSolo(a, mx * vit * dt, my * vit * dt, p.arbres, 3, p.monde, p.arbresGrid, p);
  if (typeof cmd.angle === 'number') a.angle = cmd.angle;

  if (cmd.poing && !objet && a._pCd < 0.02) {      // poing : mains vides seulement
    a._pCd = 0.35;       // cooldown court robuste au lag
    a.poingTimer = 0.60;  // animation pleine pour tous les écrans
    a.punchSide = 1 - a.punchSide;
    a.revele = 0.35;
    // Dégâts aux arbres (même en lobby) : la liste des arbres suffit, dans
    // le meme ordre que le decor
    for (const o of (p.arbres || p.obs)) {
      if (!estSolide(o)) continue;
      const ex = o.x - a.x, ey = o.y - a.y;
      const dist = Math.hypot(ex, ey);
      // Portee mesuree depuis la surface : vrai pour un arbre comme pour
      // l'orbe du lobby, bien plus grosse.
      if (dist < o.r + MELEE_PORTEE * 0.65) {
        const dot = (ex * Math.cos(a.angle) + ey * Math.sin(a.angle)) / dist;
        if (dot > 0.1) {
          o.pv -= MELEE_DEGATS; o.secousse = 0.22;
          if (o.pv <= 0) { o.pv = 0; o.type = 'souche'; o.secousse = 0; majArbres(p); }
        }
      }
    }
    // Dégâts aux joueurs (hors lobby)
    if (!mouvSeulement) {
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
          tue(p, closest, a);
        }
      }
    }
    p.evts.push({ e: 'poing', id: a.id, ang: a.angle, side: a.punchSide });
  }
  if (mouvSeulement) { a.lastSeq = cmd.seq; return; }

  if (cmd.recharger && a.rechargement <= 0 && a.munitions < CHARGEUR) {
    a.rechargement = RECHARGE_DUREE; a.dureeRechargeMax = RECHARGE_DUREE;
  }

  a.recharge -= dt;
  const armeEnMain = a.slot > 0 && objet === 'fusil';
  if (cmd.tire && armeEnMain && a.recharge <= 0 && a.rechargement <= 0 && a.munitions > 0) {
    a.recharge = CADENCE; a.tirTimer = 0.35; a.revele = 0.35; a.recul = 0.08;
    a.munitions--;
    const at = a.angle + (p.rng() - 0.5) * DISPERSION;
    // Meme bouche que les particules cote client : 0,2 R sur le cote
    const _co = R_JOUEUR * 0.2;
    const bx = a.x + Math.cos(a.angle) * CANON_L - Math.sin(a.angle) * _co;
    const by = a.y + Math.sin(a.angle) * CANON_L + Math.cos(a.angle) * _co;
    // La balle nait au bout du canon, mais le canon depasse du joueur : colle
    // a un mur fin, une porte, un arbre ou un autre joueur, sa bouche est
    // deja de l'autre cote. On suit donc le trajet depuis le centre du
    // tireur jusqu'a la bouche : le premier obstacle arrete la balle.
    const h = premierImpact(p, a.x, a.y, bx, by, a.id, true);
    const balle = { id: ++p.balleId, x: bx, y: by,
                    vx: Math.cos(at) * V_BALLE, vy: Math.sin(at) * V_BALLE,
                    ang: at, reste: PORTEE, par: a.id };
    if (!h) p.balles.push(balle);
    else {
      subitImpact(p, h, a);
      if (h.genre !== 'joueur') {
        // posee contre l'obstacle, cote tireur, pour que l'impact se voie
        balle.x = a.x; balle.y = a.y;
        poseImpact(balle, bx - a.x, by - a.y, h.t);
        p.balles.push(balle);
      }
    }
    p.evts.push({ e: 'tir', id: a.id, x: a.x, y: a.y, ang: a.angle });
    if (a.munitions <= 0) { a.rechargement = RECHARGE_DUREE; a.dureeRechargeMax = RECHARGE_DUREE; }
  }

  // Coup de poing (slot vide) — autorisé dans lobby, dégâts arbres toujours, joueurs hors lobby
  a.lastSeq = cmd.seq;
}

// ─────────────── Un tick de simulation ────────────────────────────
function pas(p) {
  p.tick++;

  const arr = Object.values(p.agents);
  majVol(p);
  if (!p.fini) {
    // L'horloge de partie ne demarre qu'une fois l'avion vide ou arrive
    if (p.demarree && !p.phaseVol) p.t += DT;
  }

  majZone(p);

  for (const o of p.obs) if (o.secousse > 0) o.secousse = Math.max(0, o.secousse - DT);
  majPortes(p, DT);
  for (const a of arr) {
    if (a._interCd > 0) a._interCd = Math.max(0, a._interCd - DT);
    if (a.para > 0) {
      a.para = Math.max(0, a.para - DT * (a.plonge ? PARA_PLONGE : 1));
      if (a.para === 0) { a.plonge = false; sortDuBatiment(p, a); }
    } else a.plonge = false;
    if (a.secousse > 0) a.secousse = Math.max(0, a.secousse - DT);
    if (a.touche > 0)   a.touche   = Math.max(0, a.touche - DT);
    if (a.tirTimer > 0) a.tirTimer = Math.max(0, a.tirTimer - DT);
    if (a.recul > 0)    a.recul    = Math.max(0, a.recul - DT);
    if (a.revele > 0)   a.revele   = Math.max(0, a.revele - DT);
    if (a.poingTimer > 0) a.poingTimer = Math.max(0, a.poingTimer - DT);
    if (a._pCd > 0) a._pCd = Math.max(0, a._pCd - DT);
    if (a.rechargement > 0) {
      a.rechargement -= DT;
      if (a.rechargement <= 0) { a.munitions = CHARGEUR; a.dureeRechargeMax = 0; }
    }
  }

  // Cache arbres (mis à jour si une souche apparaît, max toutes les 5s)
  if (!p.arbres || !p.arbresGrid || p.tick % 150 === 0) majArbres(p);

  // Suivi de vitesse + précalcul _inBush en une seule passe
  for (const a of arr) {
    a._vx = (a.x - (a._px ?? a.x)) / DT;
    a._vy = (a.y - (a._py ?? a.y)) / DT;
    a._px = a.x; a._py = a.y;
    // _inBush supprimé (IA bot simplifiée)
  }

  // Bot AI toutes les 3 ticks — la commande est réutilisée entre les ticks
  // (le mouvement reste fluide car appliqueCommande reçoit une commande valide)
  // Partie terminee : personne ne bouge plus, tout le monde passe en Idle.
  // On continue en revanche de simuler les balles encore en vol, pour
  // qu'elles finissent leur course au lieu de rester suspendues.
  if (p.fini) {
    if (!p._figes) {
      p._figes = true;
      for (const a of arr) {
        // On fige le mouvement et les animations en cours, mais on ne
        // touche pas a l'inventaire : le vainqueur garde l'arme en main
        // s'il en avait une, et reste les mains vides sinon.
        a.file.length = 0; a._cible = null;
        a.tirTimer = 0; a.recul = 0; a.poingTimer = 0;
        a.secousse = 0; a.rechargement = 0; a.dureeRechargeMax = 0;
      }
    }
    majBalles(p, arr);
    return;
  }

  // Saut des bots : chacun quitte l'avion au plus pres de SON point de
  // chute, tire au hasard sur la carte. Aucun ne suit le joueur.
  for (const a of arr) {
    if (!a.estBot || !a.vivant || !a.enAvion || !p.phaseVol) continue;
    if (!a._chute) choisitChute(p, a);
    const d = Math.hypot(a._chute.x - a.x, a._chute.y - a.y);
    const sEloigne = a._dChute !== undefined && d > a._dChute + 1;
    a._dChute = d;
    // Il saute des que l'avion s'eloigne de sa cible, ou quand le parachute
    // suffit a l'atteindre. La minuterie reste un garde-fou.
    if (sEloigne || d < VITESSE * PARA_DUREE * 0.75 || p.tVol >= (a._tSaut || 0)) {
      largue(p, a, 0);
    }
  }

  for (const a of arr) {
    if (a.estBot && a.vivant) {
      if (p.tick % 3 === 0 || !a._cible) a._cible = calculeBotCmd(p, a, arr);
      a.file = [commandeBot(a)];
      // Un bot ouvre la porte fermee qu'il touche presque (il passe par
      // l'ouverture pour entrer ou sortir). Il ne referme jamais.
      if (p.tick % 6 === 0 && !a.enAvion && !(a.para > 0)) {
        const pp = porteProche(p, a.x, a.y);
        if (pp) { const st = pp.o.portes[pp.i]; if (!st.e && battantAuRepos(st)) a.file[0].inter = true; }
      }
    }
  }

  for (const a of arr) {
    if (!a.vivant) { a.file.length = 0; continue; }
    const mouvSeulement = (p.phaseLobby === true);
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
  separeJoueurs(arr, p.monde);

  for (const a of arr) {
    if (!a.vivant || !p.demarree) continue;
    if (a.enAvion || a.para > 0) continue;        // en l'air, le cyclone n'atteint personne
    if (Math.hypot(a.x - p.zone.x, a.y - p.zone.y) > p.zone.r) {
      // Un palier toutes les ZONE_TIC secondes, d'un coup
      a.ticZone -= DT;
      if (a.ticZone <= 0) {
        a.ticZone = ZONE_TIC;
        a.pv -= (p.zoneDegats === undefined ? ZONE_DEGATS : p.zoneDegats);
        a.touche = 0.30; a.revele = 0.35; a.secousse = 0.14;
        if (a.pv <= 0) tue(p, a, null, 'Zone');
      }
    }
  }

  majBalles(p, arr);

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
// Compression des messages : un snapshot (noms de champs repetes, positions
// voisines d'un tick a l'autre) passe d'environ 12 Ko a moins de 1 Ko avec
// 30 joueurs. Moins de donnees a faire passer, moins d'a-coups sur un
// reseau mobile. Niveau 1 : le plus rapide ; les petits messages (pong,
// statut du lobby) partent tels quels. Un navigateur qui ne la propose pas
// recoit simplement les messages non compresses.
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1, memLevel: 7 },
    threshold: 1024,
    concurrencyLimit: 10,
  },
});

// Heartbeat protocol-level : termine les connexions mortes en ~25s
// Résout les rooms fantômes quand le client ferme la page sans close frame
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// rooms[gid] = { etat:'lobby'|'en_cours'|'fini', mode:'solo', players:{pid:{ws,name,accountId}}, partie:null|{} }
const rooms = {};
let soloRoomId = null; // gid de la room solo ouverte (accepte de nouveaux joueurs)
// activeSessions[accountId] = { gid, pid } — un compte = une seule session
const activeSessions = {};

// ─── Utilitaire : retirer proprement un joueur d'une room ──────────
function nettoyeJoueur(roomId, playerId) {
  const room = rooms[roomId];
  if (!room || !room.players[playerId]) return; // idempotent

  if (room.etat === 'lobby') {
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
      if (a && a.vivant) tue(room.partie, a, null, 'Déconnexion');
    }
    delete room.players[playerId];
    if (!Object.keys(room.players).length) {
      if (roomId === soloRoomId) soloRoomId = null;
      delete rooms[roomId];
    }
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

// ─── Deplacement des bots autour des huttes ───
// Un bot qui fonce droit sur sa cible bute contre les murs. On cherche donc
// un chemin par quelques points de passage autour de chaque hutte proche :
// ses 4 coins exterieurs, le devant de la porte et l'interieur. Plus court
// chemin (Dijkstra) entre ces points, en ne gardant que les segments qui ne
// traversent aucun mur.
const NAV_MARGE = HUTTE.B + R_JOUEUR + 10;        // coins, a distance des murs
const NAV_MAISON = (() => {
  const mu = MAISON.WU + R_JOUEUR + 10, mv = MAISON.V + R_JOUEUR + 10;
  return [[-mu, -mv], [mu, -mv],
          [-mu, MAISON.PV + R_JOUEUR + 10], [mu, MAISON.PV + R_JOUEUR + 10],
          [0, MAISON.PERRON + R_JOUEUR + 8], [0, 40]];
})();
const NAV_POINTS = [
  [-NAV_MARGE, -NAV_MARGE], [NAV_MARGE, -NAV_MARGE],   // coins du fond
  [-NAV_MARGE, HUTTE.PV + R_JOUEUR + 10], [NAV_MARGE, HUTTE.PV + R_JOUEUR + 10],  // coins de facade
  [0, HUTTE.PERRON + R_JOUEUR + 8],                  // devant la porte
  [0, 20 * HUTTE.K],                                 // dedans
];
HUTTE.nav = NAV_POINTS; MAISON.nav = NAV_MAISON;
// Batiments 1 a 4 : les coins (hors des murs et des piliers), devant et
// derriere chaque battant, et le milieu du plancher
for (const nom of Object.keys(NOUVEAUX_BATS)) {
  const g = BATS[nom], b = g.sortie, m = R_JOUEUR + 10;
  const pts = [[b[0] - m, b[1] - m], [b[2] + m, b[1] - m], [b[0] - m, b[3] + m], [b[2] + m, b[3] + m],
               [(g.sol[0] + g.sol[2]) / 2, (g.sol[1] + g.sol[3]) / 2]];
  for (const bt of g.portes) {
    const cu = (bt.r0[0] + bt.r0[2]) / 2, cv = (bt.r0[1] + bt.r0[3]) / 2;
    pts.push([cu + bt.eb[0] * (R_JOUEUR + 90), cv + bt.eb[1] * (R_JOUEUR + 90)]);
    pts.push([cu - bt.eb[0] * (R_JOUEUR + 45), cv - bt.eb[1] * (R_JOUEUR + 45)]);
  }
  // Batiment a plusieurs pieces : un point dans chacune, un dans son
  // ouverture et un dans le couloir, pour que les bots y entrent et en sortent
  if (g.navPlus) for (const q of g.navPlus) pts.push(q);
  g.nav = pts;
}
// Pour marcher : murs et fenetres. Pour tirer : les murs seulement.
function mursHutte(o) {
  if (!o._murs) {
    const g = geoBat(o);
    o._murs = g.murs.concat(g.fenetres || []).map(r => rectMonde(o, r));
  }
  return o._murs;
}
function mursBalle(o) {
  if (!o._mursB) o._mursB = geoBat(o).murs.map(r => rectMonde(o, r));
  return o._mursB;
}
// Batiments de la carte (ruines comprises), tenus a part : inutile de
// parcourir tout le decor pour les retrouver.
function batimentsDe(p) {
  if (p._batsObs !== p.obs) { p._bats = p.obs.filter(o => BATS[o.type] || o.type === 'ruine'); p._batsObs = p.obs; }
  return p._bats;
}
// Les 3 batiments les plus proches (et non les 3 premiers de la liste) :
// un batiment voisin oublie laissait le bot foncer dans ses murs.
function huttesPres(p, x, y, gx, gy) {
  if (!p.mursGrid) return VIDE;
  const cands = [];
  for (const o of batimentsDe(p)) {
    if (!estBatiment(o)) continue;
    const g = geoBat(o), m = Math.max(0, g.R - HUTTE.R);
    const d1 = Math.hypot(o.x - x, o.y - y), d2 = Math.hypot(o.x - gx, o.y - gy);
    if (d1 < 650 + m || d2 < 400 + m) cands.push({ o, d: Math.min(d1, d2) - m });
  }
  if (cands.length > 3) cands.sort((u, v) => u.d - v.d);
  const out = [];
  for (let i = 0; i < cands.length && i < 3; i++) out.push(cands[i].o);
  return out;
}
// Marge un peu sous le rayon du joueur : un bot colle a un mur (pousse
// pile a R) ne doit pas se croire bloque par lui.
function voieLibre(murs, x0, y0, x1, y1, r) {
  for (const w of murs) if (segmentMur(x0, y0, x1, y1, w, r)) return false;
  return true;
}
// Prochain point a viser pour aller de (x, y) a (gx, gy)
function prochainPas(p, x, y, gx, gy) {
  const hs = huttesPres(p, x, y, gx, gy);
  if (!hs.length) return { x: gx, y: gy };
  const murs = [];
  for (const o of hs) for (const w of mursHutte(o)) murs.push(w);
  const r = R_JOUEUR - 2;
  if (voieLibre(murs, x, y, gx, gy, r)) return { x: gx, y: gy };
  const pts = [{ x, y }, { x: gx, y: gy }];
  for (const o of hs) {
    const q = ((o.rot | 0) % 4 + 4) % 4;
    for (const [u, v] of geoBat(o).nav) {
      const [dx, dy] = q === 0 ? [u, v] : q === 1 ? [-v, u] : q === 2 ? [-u, -v] : [v, -u];
      pts.push({ x: o.x + dx, y: o.y + dy });
    }
  }
  const n = pts.length, dist = new Array(n).fill(Infinity), prec = new Array(n).fill(-1), fait = new Array(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!fait[k] && dist[k] < Infinity && (i < 0 || dist[k] < dist[i])) i = k;
    if (i < 0 || i === 1) break;
    fait[i] = true;
    for (let k = 0; k < n; k++) {
      if (fait[k] || k === i) continue;
      const d = dist[i] + Math.hypot(pts[k].x - pts[i].x, pts[k].y - pts[i].y);
      if (d >= dist[k]) continue;
      if (!voieLibre(murs, pts[i].x, pts[i].y, pts[k].x, pts[k].y, r)) continue;
      dist[k] = d; prec[k] = i;
    }
  }
  if (prec[1] < 0) return { x: gx, y: gy };       // aucun chemin : tout droit
  let k = 1;
  while (prec[k] !== 0) k = prec[k];
  return pts[k];
}
// Direction a prendre vers (gx, gy), detours compris
function dirVers(p, bot, gx, gy) {
  const c = prochainPas(p, bot.x, bot.y, gx, gy);
  const dx = c.x - bot.x, dy = c.y - bot.y, d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d, detour: c.x !== gx || c.y !== gy };
}
// ─── Evitement des arbres, de l'orbe et des buissons ───
// Avant d'avancer, le bot regarde un peu devant lui. Si un arbre, l'orbe ou
// un buisson barre le chemin, il essaie des caps de plus en plus ecartes,
// d'abord du cote qu'il a deja choisi (sinon il hesite a chaque decision).
// Les buissons ne bloquent personne : le bot les contourne juste, comme un
// joueur qui ne veut pas s'y perdre.
const EVITE_PORTEE = 170, EVITE_MARGE = R_JOUEUR + 4;
function obstaclesPres(p, x, y, x2, y2) {
  if (!p.arbresGrid) return VIDE;
  if (!p.buissonsGrid) p.buissonsGrid = buildGrid(p.obs.filter(o => o.type === 'buisson'));
  const vus = new Set();
  for (const g of [p.arbresGrid, p.buissonsGrid])
    for (const q of [[x, y], [x2, y2]]) for (const o of queryGrid(g, q[0], q[1])) vus.add(o);
  return vus;
}
function segmentCercle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / l2));
  const px = x0 + dx * t - cx, py = y0 + dy * t - cy;
  return px * px + py * py < r * r;
}
function evite(p, bot, mx, my) {
  const n = Math.hypot(mx, my);
  if (n < 0.01) return { x: mx, y: my };
  const a0 = Math.atan2(my, mx);
  const L = EVITE_PORTEE;
  const obs = obstaclesPres(p, bot.x, bot.y, bot.x + Math.cos(a0) * L, bot.y + Math.sin(a0) * L);
  let aussiBuissons = true;
  const libre = (a) => {
    const x1 = bot.x + Math.cos(a) * L, y1 = bot.y + Math.sin(a) * L;
    for (const o of obs) {
      if (o.type !== 'arbre' && o.type !== 'orbe' && (o.type !== 'buisson' || !aussiBuissons)) continue;
      const r = o.r + EVITE_MARGE;
      // deja dedans (un buisson) : on le laisse sortir
      if (Math.hypot(o.x - bot.x, o.y - bot.y) < r) continue;
      if (segmentCercle(bot.x, bot.y, x1, y1, o.x, o.y, r)) return false;
    }
    return true;
  };
  const cote = bot._cote || (Math.random() < 0.5 ? 1 : -1);
  // Deux passes : tout eviter ; sinon, faute de mieux, traverser un buisson
  // plutot que buter contre un arbre.
  for (const tous of [true, false]) {
    aussiBuissons = tous;
    if (libre(a0)) return { x: mx, y: my };
    for (let k = 1; k <= 6; k++) {
      for (const s of [cote, -cote]) {
        const a = a0 + s * k * 0.26;        // pas de 15 degres, jusqu'a 90
        if (libre(a)) { bot._cote = s; return { x: Math.cos(a) * n, y: Math.sin(a) * n }; }
      }
    }
  }
  return { x: mx, y: my };                  // cerne : on laisse la collision faire
}

// Un mur de hutte entre deux points ? (pour ne pas tirer dans le vide)
function murEntre(p, x0, y0, x1, y1) {
  if (!p.mursGrid) return false;
  for (const o of huttesPres(p, x0, y0, x1, y1))
    if (!voieLibre(mursBalle(o), x0, y0, x1, y1, R_BALLE)) return true;
  return false;
}

function calculeBotCmd(p, bot, arr) {
  bot._tick = (bot._tick || 0) + 1;
  const t = bot._tick;
  let recharger = bot.munitions === 0 && bot.rechargement <= 0;

  // Lobby : errance libre
  if (p.phaseLobby) {
    // coince contre un mur : il repart ailleurs
    const coince = t > 20 && Math.hypot(bot._vx || 0, bot._vy || 0) < VITESSE * 0.25;
    if (t % 150 === 1 || (coince && t % 15 === 0)) bot._wA = Math.random() * Math.PI * 2;
    const wa = bot._wA || 0;
    const ev = evite(p, bot, Math.cos(wa), Math.sin(wa));
    return { mx: ev.x, my: ev.y, ang: Math.atan2(ev.y, ev.x),
             tire: false, recharger: false, vitesseRot: 3 };
  }

  // Ennemi le plus proche
  let nearest = null, nearestDist = Infinity;
  for (const a of arr) {
    if (a.id === bot.id || !a.vivant) continue;
    const d = Math.hypot(a.x - bot.x, a.y - bot.y);
    if (d < nearestDist) { nearestDist = d; nearest = a; }
  }

  // 0. En parachute : cap sur son propre point de chute, sans se soucier
  //    des autres. Un bot ne doit pas descendre sur le dos du joueur.
  if (bot.para > 0) {
    if (!bot._chute) choisitChute(p, bot);
    const cx = bot._chute.x - bot.x, cy = bot._chute.y - bot.y;
    const cd = Math.hypot(cx, cy);
    const ca = cd > 1 ? Math.atan2(cy, cx) : bot.angle;
    const v = cd > 40 ? 1 : 0;              // arrive : il se laisse tomber
    return { mx: cx / (cd || 1) * v, my: cy / (cd || 1) * v, ang: ca,
             tire: false, recharger: false, vitesseRot: 6 };
  }

  let tmx = 0, tmy = 0, angle = bot.angle, tire = false;

  // 1. Fuir la zone si dehors
  const dz = Math.hypot(bot.x - p.zone.x, bot.y - p.zone.y);
  if (p.demarree && dz > p.zone.r * 0.88) {
    const dv = dirVers(p, bot, p.zone.x, p.zone.y);
    tmx = dv.x; tmy = dv.y; angle = Math.atan2(dv.y, dv.x);

  } else if (nearest) {
    // 2. Chasser l'ennemi à distance idéale
    const dx = nearest.x - bot.x, dy = nearest.y - bot.y;
    const IDEAL = 380;
    // Un mur entre les deux : inutile de tirer, on va le chercher (par la
    // porte s'il est dans une hutte)
    const cache = murEntre(p, bot.x, bot.y, nearest.x, nearest.y);
    if (cache || nearestDist > IDEAL + 80) {
      const dv = dirVers(p, bot, nearest.x, nearest.y);
      tmx = dv.x; tmy = dv.y;
    }
    else if (nearestDist < IDEAL - 80) { tmx = -dx / nearestDist * 0.5; tmy = -dy / nearestDist * 0.5; }
    // Le tremblement de visee derive doucement au lieu de sauter a chaque
    // decision : sinon le bot pivote par a-coups meme avec un cap lisse.
    // Visee un peu moins sure : environ 20 % de balles au but en moins
    bot._jit = (bot._jit || 0) + ((Math.random() - 0.5) * 1.25 - (bot._jit || 0)) * 0.13;
    angle = cache ? Math.atan2(tmy, tmx) : Math.atan2(dy, dx) + bot._jit;
    if (!cache && nearestDist < 520 && bot.munitions > 0 && bot.rechargement <= 0) tire = true;

  } else {
    // 3. Errance
    bot._vu = 0;
    if (t % 150 === 1) bot._wA = Math.random() * Math.PI * 2;
    const wa = bot._wA || 0;
    const tzx = p.zone.x - bot.x, tzy = p.zone.y - bot.y;
    const tzd = Math.hypot(tzx, tzy);
    if (tzd > 450) {
      const dv = dirVers(p, bot, p.zone.x, p.zone.y);
      // en plein detour on suit le detour, sans derive aleatoire
      const k = dv.detour ? 0 : 0.2;
      tmx = dv.x * (1 - k) + Math.cos(wa) * k; tmy = dv.y * (1 - k) + Math.sin(wa) * k;
    }
    else {
      const coince = Math.hypot(bot._vx || 0, bot._vy || 0) < VITESSE * 0.25;
      if (coince && t % 15 === 0) bot._wA = Math.random() * Math.PI * 2;
      tmx = Math.cos(bot._wA || 0); tmy = Math.sin(bot._wA || 0);
    }
    angle = Math.atan2(tmy, tmx);
  }

  if (!nearest) bot._vu = 0;
  const n = Math.hypot(tmx, tmy);
  if (n > 0.01) { tmx /= n; tmy /= n; }
  // arbres, orbe et buissons : on les contourne au lieu de foncer dedans
  const ev = evite(p, bot, tmx, tmy);
  tmx = ev.x; tmy = ev.y;
  return { mx: tmx, my: tmy, ang: angle, tire, recharger, vitesseRot: 4 };
}

// La decision d'un bot ne se prend que toutes les 3 ticks, mais son cap et
// sa direction doivent evoluer a CHAQUE tick : sinon il pivote par paliers
// de 10 Hz, ce qui se voit tout de suite, surtout sous le parachute.
// 0,888 par tick equivaut au 0,70 d'avant pris une fois sur trois.
function commandeBot(a) {
  const c = a._cible;
  if (!c) return { seq: a.lastSeq + 1, mx: 0, my: 0, angle: a.angle, dt: DT };
  a._smx = (a._smx || 0) * 0.888 + c.mx * 0.112;
  a._smy = (a._smy || 0) * 0.888 + c.my * 0.112;
  // Deux etages : le cap vise glisse vers la consigne, puis le bot glisse
  // vers ce cap. Un seul etage laisserait passer les sauts de consigne.
  a._angC = (a._angC === undefined) ? c.ang : lerpAngle(a._angC, c.ang, 6 * DT);
  const angle = lerpAngle(a.angle, a._angC, (c.vitesseRot || 4) * DT);
  return { seq: a.lastSeq + 1, mx: a._smx, my: a._smy, angle,
           tire: c.tire, recharger: c.recharger, plonge: false, dt: DT };
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
// Bascule complete vers une autre carte. Tout ce qui reference
// l'ancienne est jete : les index de p.obs changent, donc un client qui
// garderait l'ancienne liste verrait des hitbox fantomes. Le compteur
// mapVer permet justement de reperer les snapshots en vol.
function changeMap(p, nomMap) {
  const map = chargeMap(nomMap);
  p.map = map;
  p.monde = map.monde;
  p.mapVer++;
  p.obs = obsDeMap(map);
  p.arbres = null;        // caches de collision invalides
  p.arbresGrid = null;
  p.buissonsGrid = null;
  p.murs = mursDe(p.obs);
  p.mursGrid = p.murs.length ? grilleMurs(p.murs) : null;
  p.balles = [];          // balles encore en vol sur l'ancienne carte
  p.evts = [];            // impacts rattaches a l'ancien decor
  p.zone = { x: map.zone.cx, y: map.zone.cy, r: map.zone.r0 };
  p.zoneCible = null; p.zoneDepart = null; p.zoneDegats = 0; p.zoneT = 0; p.zoneBouge = false;
  p._bornes = null; p._cibleIdx = -1;   // la nouvelle carte a ses propres vagues
}

function demarrePartie(room, gid) {
  const p = room.partie;
  p.phaseLobby = false;
  p.demarree = true;
  room.etat = 'en_cours';
  room.countdownStart = null;
  if (gid === soloRoomId) soloRoomId = null; // libérer pour les prochains

  // On quitte la carte d'attente pour la carte de partie
  changeMap(p, 'partie');

  // Couloir de vol et embarquement : celui annonce des le lobby
  p.avion = (p.avionPrevu && p.avionPrevu.x1 !== undefined) ? p.avionPrevu
                                                           : creeAvion(p.rng, p.monde);
  p.avionPrevu = null;
  p.tVol = 0;
  p.phaseVol = true;

  // Téléporter + équiper chaque joueur vivant (sur la NOUVELLE carte)
  for (const a of Object.values(p.agents)) {
    if (!a.vivant) continue;
    const pos = placer(p.rng, p.map, p.obs);
    a.x = pos.x; a.y = pos.y; a.pv = PV_MAX;
    a._px = a.x; a._py = a.y; a._vx = 0; a._vy = 0;   // historique de vitesse
    a.file = [];   // commandes en attente calculees pour l'ancienne carte
    // lastSeq n'est PAS remis a zero : il doit rester monotone, sinon les
    // commandes encore en vol le font remonter et toutes les suivantes,
    // reparties d'un numero plus bas, sont rejetees pour toujours.
    a.inv = INV_PARTIE(); a.soin = 0;
    a.slot = 1; a.munitions = CHARGEUR; a.rechargement = 0;
    a.tueurId = null; a.place = 0;
    // Tout le monde part dans l'avion, personne n'est encore sur la carte
    a.enAvion = true; a.para = 0;
    a.x = p.avion.x0; a.y = p.avion.y0;
    // Les bots sautent chacun a un moment different du trajet
    if (a.estBot) {
      a._tSaut = p.avion.duree * (0.15 + p.rng() * 0.85);
      a._dChute = undefined;
      choisitChute(p, a);
    }
    p._figes = false;
    if (a.estBot) { a._smx = 0; a._smy = 0; a._vu = 0; a._tick = 0; a._cible = null; a._angC = undefined; a._jit = 0; }
  }

  // Envoyer la nouvelle carte a chaque client, avec son point d'arrivee
  const carte = payloadCarte(p);
  for (const [plPid, pl] of Object.entries(room.players)) {
    if (!pl.ws || pl.ws.readyState !== WebSocket.OPEN) continue;
    const a = p.agents[plPid];
    pl.ws.send(JSON.stringify(Object.assign({ type: 'mapSwitch' }, carte,
      { spawn: a ? { x: a.x, y: a.y } : null })));
  }
}

// Carte de partie montree pendant le lobby, couloir de vol compris.
function apercuPartie(p) {
  if (!p.phaseLobby || !p.avionPrevu) return null;
  const mp = chargeMap('partie');
  const av = p.avionPrevu;
  return {
    monde: mp.monde, ile: mp.ile, lacs: mp.lacs || [], neiges: mp.neiges || [], chemins: mp.chemins || { traces: [], raccords: [] },
    decor: mp.obs.map(o => ({ x: o.x, y: o.y, r: o.r, type: o.type, seed: o.seed, v: o.v, rot: o.rot })),
    avion: { x0: av.x0, y0: av.y0, x1: av.x1, y1: av.y1, angle: av.angle, v: AVION_V },
  };
}

// Bloc carte commun aux messages init et mapSwitch
function payloadCarte(p) {
  const zc = p.map.zone;
  return {
    map: p.monde, mapNom: p.map.nom, mapVer: p.mapVer,
    cfg: {
      VITESSE, R_JOUEUR, CADENCE, CHARGEUR, RECHARGE_DUREE, DT,
      MONDE: p.monde,
      ZONE_ATTENTE: zc.attente, ZONE_DUREE: zc.duree, ZONE_R0: zc.r0, ZONE_R1: zc.r1,
    },
    ile: p.map.ile,
    lacs: p.map.lacs || [],
    neiges: p.map.neiges || [],
    chemins: p.map.chemins || { traces: [], raccords: [] },
    decor: p.obs.map(o => ({ x: o.x, y: o.y, r: o.r, type: o.type, pv: o.pv, seed: o.seed, v: o.v, rot: o.rot,
                             portes: o.portes ? o.portes.map(st => [st.e, st.a]) : undefined })),
    // Apercu de la carte de partie pendant l'attente : de quoi ouvrir la
    // vraie carte depuis le lobby et y lire le trajet de l'avion.
    apercu: apercuPartie(p),
  };
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
      if (!msg || typeof msg !== 'object') return;

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
          const partie = creePartie('lobby');
          partie.phaseLobby = true; // bloque tir + zone
          rooms[newGid] = { etat: 'lobby', mode: 'solo', players: {}, partie, countdownStart: null };
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
              type: 'init', playerId: pid, gameId: gid,
              ...payloadCarte(rooms[gid].partie),
              spawn: { x: a.x, y: a.y }, st: Date.now(),
            }));
          } catch {}
        }
        diffuseLobby(rooms[gid], gid);
        return;
      }

      // ── invChange ─────────────────────────────────────────────────
      if (msg.type === 'invChange' && pid && rooms[gid] && rooms[gid].partie) {
        const a = rooms[gid].partie.agents[pid];
        if (a) {
          if (Number.isInteger(msg.slot) && msg.slot >= 0 && msg.slot < 6) {
            if (msg.slot !== a.slot) a.soin = 0;          // changer d'emplacement annule le soin
            a.slot = msg.slot;
          }
          // Le client ne fait que reordonner ses objets : on n'accepte que les
          // memes objets, autrement ranges (pas d'objet invente ou duplique)
          if (Array.isArray(msg.inv) && msg.inv.length === 6) {
            const nv = msg.inv.map(x => (x === 'fusil' || x === 'medkit') ? x : null);
            const sac = l => l.filter(Boolean).sort().join(',');
            if (sac(nv) === sac(a.inv || [])) a.inv = nv;
          }
        }
        return;
      }

      // ── inputs de jeu ─────────────────────────────────────────────
      // ── saut : quitter l'avion ────────────────────────────────────
      if (msg.type === 'saut' && pid && rooms[gid] && rooms[gid].partie) {
        const p2 = rooms[gid].partie;
        const a2 = p2.agents[pid];
        if (a2 && a2.enAvion && p2.phaseVol) largue(p2, a2, 0);
        return;
      }

      if (msg.type === 'in' && pid && rooms[gid] && rooms[gid].partie) {
        const a = rooms[gid].partie.agents[pid];
        if (!a) return;
        // Commandes produites avant la bascule : elles visaient l'ancienne
        // carte, on les jette au lieu de les appliquer ici.
        if (msg.mv && msg.mv !== rooms[gid].partie.mapVer) return;
        if (!Array.isArray(msg.c)) return;
        for (const c0 of msg.c) {
          const c = nettoieCmd(c0);
          if (c && c.seq > a.lastSeq + a.file.length) a.file.push(c);
        }
        if (a.file.length > 40) a.file.splice(0, a.file.length - 40);
        return;
      }

      // ── ping ──────────────────────────────────────────────────────
      if (msg.type === 'ping' && ws.readyState === WebSocket.OPEN) {
        if (pid && rooms[gid] && rooms[gid].partie) {
          const a = rooms[gid].partie.agents[pid];
          if (a && typeof msg.rtt === 'number') a.rtt = Math.min(600, Math.max(0, msg.rtt));
        }
        try {
          const ag = (pid && rooms[gid] && rooms[gid].partie) ? rooms[gid].partie.agents[pid] : null;
          ws.send(JSON.stringify({ type: 'pong', c: msg.c, st: Date.now(), retard: retardPour(ag) }));
        } catch {}
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
    // Gros retard (machine gelee un instant) : on ne rattrape pas une
    // rafale de ticks, qui ferait tout avancer d'un coup chez les clients.
    // Au-dela de quelques ticks, on repart de maintenant.
    if (maintenant - prochain > TICK_MS * 6) prochain = maintenant;
  } catch (e) {
    console.error('[boucleServeur]', e.message);
    prochain = Date.now() + TICK_MS; // éviter la boucle infinie sur erreur
  }
  setTimeout(boucleServeur, Math.max(1, prochain - Date.now()));
}

// Retard d'interpolation propre a UN joueur. Auparavant une seule valeur
// commune etait calculee sur le pire ping de la partie : un seul joueur
// mal connecte degradait la fluidite de tous les autres, et les bots
// comptaient dans le calcul avec un ping fictif de 120 ms.
function retardPour(a) {
  const moitie = ((a && a.rtt) || 120) / 2;
  return Math.round(Math.min(320, Math.max(90, moitie + 60)));
}

// Arrondis pour l'envoi : un flottant complet prend 17 chiffres, deux
// decimales suffisent largement a l'ecran (1/100 d'unite monde). Le
// snapshot, envoye 30 fois par seconde a chaque joueur, fond de moitie.
const r2 = (v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v;
const r3 = (v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
const r4 = (v) => typeof v === 'number' ? Math.round(v * 10000) / 10000 : v;

function envoieSnapshot(room) {
  if (!room.partie) return;
  const p = room.partie;
  const decorMaj = [];
  p.obs.forEach((o, idx) => {
    const sig = aPorte(o) ? o.portes.map(st => st.e).join(',') : '';
    const porteChange = aPorte(o) && o._lp !== sig;
    if (o._lt !== o.type || o.secousse > 0 || porteChange) {
      const m = { idx, type: o.type, pv: o.pv, secousse: r3(o.secousse) };
      if (aPorte(o)) { m.portes = o.portes.map(st => st.e); o._lp = sig; }
      decorMaj.push(m);
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
    type: 'snap', tick: p.tick, t: r3(p.t), st: Date.now(), attente: !p.demarree, mapVer: p.mapVer,
    fini: p.fini, vainqueur: p.vainqueur, zone: { x: r2(p.zone.x), y: r2(p.zone.y), r: r2(p.zone.r) },
    // Le cercle d'arrivee n'est revele qu'au moment ou le cyclone se met
    // en marche, pas pendant la pause qui precede.
    zoneCible: p.zoneBouge && p.zoneCible ? { x: r2(p.zoneCible.x), y: r2(p.zoneCible.y), r: r2(p.zoneCible.r) } : null,
    zoneT: r3(p.zoneT),
    avion: p.avion ? { x: r2(p.avion.x), y: r2(p.avion.y), angle: r4(p.avion.angle), v: AVION_V,
                       x0: r2(p.avion.x0), y0: r2(p.avion.y0), x1: r2(p.avion.x1), y1: r2(p.avion.y1),
                       vol: !!p.avion.enVol, largage: p.phaseVol,
                       fin: p.tVol >= p.avion.duree } : null,
    paraDuree: PARA_DUREE,
    phaseLobby, compteARebours, nbJoueursLobby,
    balles: p.balles.map(b => b.fin
      ? { id: b.id, x: r2(b.x), y: r2(b.y), ang: r4(b.ang), reste: r2(b.reste), par: b.par, fin: 1 }
      : { id: b.id, x: r2(b.x), y: r2(b.y), ang: r4(b.ang), reste: r2(b.reste), par: b.par }),
    // (p.evts reste interne : le client ne s'en sert pas, inutile de l'envoyer)
    kills: p.kills, decorMaj,
  };
  const agents = {};
  for (const [id, a] of Object.entries(p.agents)) {
    agents[id] = { id: a.id, name: a.name, x: r2(a.x), y: r2(a.y), angle: r4(a.angle), pv: a.pv, vivant: a.vivant,
      tueurId: a.tueurId || null, place: a.place || 0,
      enAvion: !!a.enAvion, para: r4(a.para || 0), plonge: !!a.plonge,
      munitions: a.munitions, rechargement: r4(a.rechargement), dureeRechargeMax: a.dureeRechargeMax,
      secousse: r3(a.secousse), touche: r3(a.touche), tirTimer: r3(a.tirTimer), recul: r3(a.recul),
      revele: r3(a.revele), slot: a.slot, inv: a.inv, soin: r3(a.soin || 0),
      poingTimer: r3(a.poingTimer), punchSide: a.punchSide };
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

// Prechargement : un JSON casse doit se voir au demarrage, pas a la
// premiere connexion.
chargeMap('lobby');
chargeMap('partie');

server.listen(PORT, () => console.log('Serveur sur le port ' + PORT));
boucleServeur();
