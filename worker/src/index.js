// worker/src/index.js
import { rw, rewriteImports, isJs, mkInterceptor, proxyWS,
         buildReqHdrs, buildOutHdrs, corsHdrs, rewriteHtml } from './proxy.js';
import { uiNavigateur } from './navigateur.js';
import gameHtml from '../game/game.html';
import editeurHtml from '../game/editeur.html';
import bgAuth  from '../game/bg_auth.png';
import bgLobby from '../game/bg_lobby.png';
import bouton  from '../game/bouton.png';
import continueBtn from '../game/continue_button.png';
import avion from '../game/avion.png';
import parachute from '../game/parachute.png';
import boutonPara from '../game/bouton_para.png';
import boutonPlonge from '../game/bouton_plonge.png';
import arbreVert    from '../game/arbre_vert.png';
import arbreOrange  from '../game/arbre_orange.png';
import arbreRouge   from '../game/arbre_rouge.png';
import arbreSombre  from '../game/arbre_sombre.png';
import buissonImg   from '../game/buisson.png';
import orbeImg      from '../game/orbe.png';
import feuilleImg   from '../game/feuille.png';
import hutte1Img    from '../game/hutte1.png';
import hutte1ToitImg from '../game/hutte1_toit.png';
import hutte2Img    from '../game/hutte2.png';
import hutte2ToitImg from '../game/hutte2_toit.png';
import hutte1RuineImg from '../game/hutte1_ruine.png';
import hutte2RuineImg from '../game/hutte2_ruine.png';
import boisImg      from '../game/bois.png';
import maisonImg    from '../game/maison.png';
import maisonToitImg from '../game/maison_toit.png';
import maisonFenImg from '../game/maison_fen.png';
import porteImg     from '../game/porte.png';
import bat1Img from '../game/batiment1.png';
import bat1ToitImg from '../game/batiment1_toit.png';
import bat1FenImg from '../game/batiment1_fen.png';
import bat2Img from '../game/batiment2.png';
import bat2ToitImg from '../game/batiment2_toit.png';
import bat2FenImg from '../game/batiment2_fen.png';
import bat3Img from '../game/batiment3.png';
import bat3ToitImg from '../game/batiment3_toit.png';
import bat3FenImg from '../game/batiment3_fen.png';
import bat4Img from '../game/batiment4.png';
import bat4ToitImg from '../game/batiment4_toit.png';
import bat4FenImg from '../game/batiment4_fen.png';
import boutonInter  from '../game/bouton_inter.png';
import medkitImg    from '../game/medkit.png';
import slotMedkit    from '../game/slot_medkit.png';
import boutonSoin   from '../game/bouton_soin.png';
import arm          from '../game/arm.png';
import hand         from '../game/hand.png';
import head         from '../game/head.png';
import weapon_XM8   from '../game/weapon_XM8.png';
import xm8Full      from '../game/XM8.png';
import slotXM8      from '../game/slotXM8.png';
import bullet       from '../game/MediumProjectile.png';
import {
  signJWT, verifyJWT, hashPassword, hashAdminKey,
  randomSalt, generateSessionToken, jsonOk, jsonErr
} from './auth.js';

function uiGame(serverUrl) {
  return gameHtml.replace('${serverUrl}', serverUrl);
}

// ── /auth/register ─────────────────────────────────────────────────
async function handleRegister(request, env) {
  if (!env.JWT_SECRET) return jsonErr('Serveur mal configuré (JWT_SECRET manquant)', 500);
  let body;
  try { body = await request.json(); } catch { return jsonErr('JSON invalide'); }

  const { username, password, adminKey } = body;

  // Validation basique
  if (!username || !password || !adminKey) return jsonErr('Champs manquants');
  if (username.length < 3 || username.length > 16) return jsonErr('Pseudo : 3 à 16 caractères');
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return jsonErr('Pseudo : lettres, chiffres, _ et - uniquement');
  if (password.length < 8) return jsonErr('Mot de passe : 8 caractères minimum');

  const keyHash = await hashAdminKey(adminKey);

  // Vérifier la clé admin
  const keyRow = await env.DB.prepare(
    'SELECT id, used FROM admin_keys WHERE key_hash = ?'
  ).bind(keyHash).first();

  if (!keyRow) return jsonErr('Clé admin invalide', 403);
  if (keyRow.used) return jsonErr('Clé admin déjà utilisée', 403);

  // Vérifier que le pseudo n'existe pas
  const existing = await env.DB.prepare(
    'SELECT id FROM accounts WHERE username = ?'
  ).bind(username).first();
  if (existing) return jsonErr('Ce pseudo est déjà pris');

  // Créer le compte
  const salt = randomSalt();
  const passwordH = await hashPassword(password, salt);
  const now = Math.floor(Date.now() / 1000);

  let result;
  try {
    result = await env.DB.prepare(
      'INSERT INTO accounts (username, salt, password_h, created_at) VALUES (?, ?, ?, ?)'
    ).bind(username, salt, passwordH, now).run();
  } catch {
    return jsonErr('Ce pseudo est déjà pris');
  }

  const accountId = result.meta.last_row_id;

  // Marquer la clé admin comme utilisée
  await env.DB.prepare(
    'UPDATE admin_keys SET used = 1, account_id = ? WHERE id = ?'
  ).bind(accountId, keyRow.id).run();

  const sessionToken = generateSessionToken();
  await env.DB.prepare('UPDATE accounts SET session_token = ? WHERE id = ?')
    .bind(sessionToken, accountId).run();
  const token = await signJWT({ sub: accountId, name: username, st: sessionToken }, env.JWT_SECRET);
  return jsonOk({ token, username }, 201);
}

// ── /auth/login ────────────────────────────────────────────────────
async function handleLogin(request, env) {
  if (!env.JWT_SECRET) return jsonErr('Serveur mal configuré (JWT_SECRET manquant)', 500);
  let body;
  try { body = await request.json(); } catch { return jsonErr('JSON invalide'); }

  const { username, password } = body;
  if (!username || !password) return jsonErr('Champs manquants');

  const account = await env.DB.prepare(
    'SELECT id, salt, password_h FROM accounts WHERE username = ?'
  ).bind(username).first();

  // Message volontairement identique pour éviter l'énumération de pseudos
  if (!account) return jsonErr('Identifiants incorrects', 401);

  const hash = await hashPassword(password, account.salt);
  if (hash !== account.password_h) return jsonErr('Identifiants incorrects', 401);

  const sessionToken = generateSessionToken();
  await env.DB.prepare('UPDATE accounts SET session_token = ? WHERE id = ?')
    .bind(sessionToken, account.id).run();
  const token = await signJWT({ sub: account.id, name: username, st: sessionToken }, env.JWT_SECRET);
  return jsonOk({ token, username });
}

// ── Routeur principal ──────────────────────────────────────────────
export default {
  // Cron toutes les 5 min : garder le serveur Render éveillé
  async scheduled(event, env, ctx) {
    const url = (env.GAME_SERVER_URL || '').replace('wss://', 'https://').replace('ws://', 'http://').split('/')[0] + '//' + ((env.GAME_SERVER_URL || '').replace('wss://', '').replace('ws://', '').split('/')[0]);
    try { await fetch(url, { signal: AbortSignal.timeout(8000) }); } catch {}
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const W = url.origin;
    const WS = W.replace(/^https:/, 'wss:');
    let target = url.searchParams.get('url');

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHdrs() });

    // ── Routes auth ──
    if (url.pathname === '/auth/register' && request.method === 'POST')
      return handleRegister(request, env);

    if (url.pathname === '/auth/login' && request.method === 'POST')
      return handleLogin(request, env);

    // ── Validation de session (appelée par le serveur de jeu) ──
    if (url.pathname === '/auth/validate' && request.method === 'POST') {
      if (!env.JWT_SECRET) return jsonErr('JWT_SECRET manquant', 500);
      let body2;
      try { body2 = await request.json(); } catch { return jsonErr('JSON invalide'); }
      const { token: tok } = body2;
      if (!tok) return jsonErr('Token manquant', 400);
      // 1. Vérifier la signature
      const payload = await verifyJWT(tok, env.JWT_SECRET);
      if (!payload) return jsonErr('Token invalide ou expiré', 401);
      // 2. Vérifier que le session_token est le bon en base
      const row = await env.DB.prepare('SELECT session_token FROM accounts WHERE id = ?')
        .bind(payload.sub).first();
      if (!row || row.session_token !== payload.st)
        return jsonErr('Session expirée (connexion depuis un autre appareil)', 401);
      return jsonOk({ valid: true, name: payload.name });
    }

    // ── Assets statiques (images) ──
    const imgRoutes = {
      '/game/bg_auth.png':  bgAuth,
      '/game/bg_lobby.png': bgLobby,
      '/game/bouton.png':   bouton,
      '/game/continue_button.png': continueBtn,
      '/game/avion.png':          avion,
      '/game/parachute.png':      parachute,
      '/game/bouton_para.png':    boutonPara,
      '/game/bouton_plonge.png':  boutonPlonge,
      '/game/arbre_vert.png':     arbreVert,
      '/game/arbre_orange.png':   arbreOrange,
      '/game/arbre_rouge.png':    arbreRouge,
      '/game/arbre_sombre.png':   arbreSombre,
      '/game/buisson.png':        buissonImg,
      '/game/orbe.png':           orbeImg,
      '/game/feuille.png':        feuilleImg,
      '/game/hutte1.png':         hutte1Img,
      '/game/hutte1_toit.png':    hutte1ToitImg,
      '/game/hutte2.png':         hutte2Img,
      '/game/hutte2_toit.png':    hutte2ToitImg,
      '/game/hutte1_ruine.png':   hutte1RuineImg,
      '/game/hutte2_ruine.png':   hutte2RuineImg,
      '/game/bois.png':           boisImg,
      '/game/maison.png':         maisonImg,
      '/game/maison_toit.png':    maisonToitImg,
      '/game/maison_fen.png':     maisonFenImg,
      '/game/porte.png':          porteImg,
      '/game/batiment1.png': bat1Img,
      '/game/batiment1_toit.png': bat1ToitImg,
      '/game/batiment1_fen.png': bat1FenImg,
      '/game/batiment2.png': bat2Img,
      '/game/batiment2_toit.png': bat2ToitImg,
      '/game/batiment2_fen.png': bat2FenImg,
      '/game/batiment3.png': bat3Img,
      '/game/batiment3_toit.png': bat3ToitImg,
      '/game/batiment3_fen.png': bat3FenImg,
      '/game/batiment4.png': bat4Img,
      '/game/batiment4_toit.png': bat4ToitImg,
      '/game/batiment4_fen.png': bat4FenImg,
      '/game/bouton_inter.png':   boutonInter,
      '/game/medkit.png':         medkitImg,
      '/game/slot_medkit.png':    slotMedkit,
      '/game/bouton_soin.png':    boutonSoin,
      '/game/arm.png':          arm,
      '/game/hand.png':         hand,
      '/game/head.png':         head,
      '/game/weapon_XM8.png':   weapon_XM8,
      '/game/XM8.png':          xm8Full,
      '/game/slotXM8.png':      slotXM8,
      '/game/MediumProjectile.png': bullet,
    };
    if (imgRoutes[url.pathname]) {
      return new Response(imgRoutes[url.pathname], {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }
      });
    }

    // ── Editeur de cartes ──
    // Page autonome, aucun appel au serveur de jeu : elle sert juste a
    // fabriquer les JSON de carte, qu'on recopie ensuite dans le depot.
    if (url.pathname === '/editeur') {
      return new Response(editeurHtml, {
        headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    // ── Jeu ──
    if (url.pathname === '/game') {
      const serverUrl = env.GAME_SERVER_URL || 'wss://CHANGE-ME.onrender.com';
      return new Response(uiGame(serverUrl), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

    // ── Proxy navigateur (reste inchangé) ──
    if (!target && url.pathname !== '/') {
      const m = (request.headers.get('Cookie') || '').match(/proxy_target=([^;]+)/);
      if (m) target = decodeURIComponent(m[1]) + url.pathname + url.search;
    }

    if (!target) return new Response(uiNavigateur(), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    if (!target.startsWith('http')) target = 'https://' + target;

    let T;
    try { T = new URL(target).origin; } catch { return new Response('URL invalide', { status: 400 }); }

    if (request.headers.get('Upgrade') === 'websocket') return proxyWS(request, target, T);

    try {
      const resp = await fetch(target, { method: request.method, headers: buildReqHdrs(request, T), body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
      const out = buildOutHdrs(resp, T);
      if (resp.status >= 300 && resp.status < 400) { const loc = resp.headers.get('Location'); if (loc) out.set('Location', rw(T, W, loc)); return new Response(null, { status: resp.status, headers: out }); }
      const ct = resp.headers.get('content-type') || ''; out.set('content-type', ct || 'application/octet-stream');
      if (ct.includes('text/html')) return new Response(rewriteHtml(await resp.text(), W, T, WS), { headers: out });
      if (isJs(ct, target)) { out.set('content-type', 'application/javascript'); let js = await resp.text(); js = rewriteImports(js, T, W); js = mkInterceptor(W, T, WS, false) + '\n' + js; return new Response(js, { headers: out }); }
      if (ct.includes('text/css')) { const css = (await resp.text()).replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (_, u) => `url('${rw(T, W, u)}')`); return new Response(css, { headers: out }); }
      return new Response(resp.body, { headers: out });
    } catch (e) { return new Response(`<h2>Erreur</h2><pre>${e.message}</pre>`, { status: 500, headers: { 'content-type': 'text/html' } }); }
  }
};
