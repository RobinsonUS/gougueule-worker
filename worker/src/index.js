// worker/src/index.js
import { rw, rewriteImports, isJs, mkInterceptor, proxyWS,
         buildReqHdrs, buildOutHdrs, corsHdrs, rewriteHtml } from './proxy.js';
import { uiNavigateur } from './navigateur.js';
import gameHtml from '../game/game.html';
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
