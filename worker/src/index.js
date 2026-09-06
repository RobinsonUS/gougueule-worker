// Point d'entree du Worker
import { rw, rewriteImports, isJs, mkInterceptor, proxyWS,
         buildReqHdrs, buildOutHdrs, corsHdrs, rewriteHtml } from './proxy.js';
import { uiNavigateur } from './navigateur.js';
import gameHtml from '../game/game.html';

function uiGame(serverUrl) {
  return gameHtml.replace('${serverUrl}', serverUrl);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const W = url.origin;
    const WS = W.replace(/^https:/, 'wss:');
    let target = url.searchParams.get('url');

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHdrs() });

    if (url.pathname === '/game') {
      const serverUrl = env.GAME_SERVER_URL || 'wss://CHANGE-ME.onrender.com';
      return new Response(uiGame(serverUrl), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }

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
      const resp = await fetch(target, { method: request.method, headers: buildReqHdrs(request, T), body: ['GET','HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
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
