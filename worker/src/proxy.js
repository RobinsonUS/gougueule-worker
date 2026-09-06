// Proxy Cloudflare : reecriture HTML/JS/CSS, interception fetch/XHR/WebSocket
// ─── Proxy Cloudflare Worker — Gougueule + Battle Royale ─────────────────────

const BLOCKED_HEADERS = new Set([
  'content-security-policy','content-security-policy-report-only',
  'x-frame-options','x-xss-protection','report-to','nel',
  'permissions-policy','cross-origin-opener-policy',
  'cross-origin-embedder-policy','x-content-type-options',
]);

function rw(T, W, url) {
  if (!url) return url;
  if (/^(data:|blob:|javascript:|about:|#|mailto:)/.test(url)) return url;
  try {
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = T + url;
    else if (!url.startsWith('http')) url = T + '/' + url;
    new URL(url);
    return W + '/?url=' + encodeURIComponent(url);
  } catch { return url; }
}

function rewriteImports(js, T, W) {
  js = js.replace(/\bimport\b([\s\S]*?)\bfrom\b\s*(['"])((?:\.{0,2}\/|https?:\/\/)[^'"]+)\2/g,
    (_, imp, q, url) => `import${imp}from ${q}${rw(T, W, url)}${q}`);
  js = js.replace(/\bexport\b([\s\S]*?)\bfrom\b\s*(['"])((?:\.{0,2}\/|https?:\/\/)[^'"]+)\2/g,
    (_, exp, q, url) => `export${exp}from ${q}${rw(T, W, url)}${q}`);
  js = js.replace(/\bimport\s*\(\s*(['"])((?:\.{0,2}\/|https?:\/\/)[^'"]+)\1\s*\)/g,
    (_, q, url) => `import(${q}${rw(T, W, url)}${q})`);
  return js;
}

function isJs(ct, url) {
  return ct.includes('javascript') || ct.includes('ecmascript') || /\.(js|mjs|cjs)(\?|#|$)/.test(url.split('?')[0]);
}

function mkInterceptor(W, T, WS, forPage) {
  const wsRe = String.raw`/^wss?:\/\//`;
  return `(function(){try{
var _W=${JSON.stringify(W)},_T=${JSON.stringify(T)},_WS=${JSON.stringify(WS)};
var _g=typeof globalThis!=='undefined'?globalThis:typeof self!=='undefined'?self:window;
function _p(u){if(typeof u!=='string'||u.startsWith(_W)||/^(data:|blob:|javascript:|about:)/.test(u)||u==='')return u;try{if(u.startsWith('//'))u='https:'+u;else if(u.startsWith('/'))u=_T+u;else if(!u.startsWith('http'))u=_T+'/'+u;return _W+'/?url='+encodeURIComponent(u);}catch(e){return u;}}
if(_g.fetch){var _f=_g.fetch;_g.fetch=function(i,o){if(typeof i==='string')i=_p(i);else if(i instanceof Request)i=new Request(_p(i.url),{method:i.method,headers:i.headers,body:i.body,credentials:i.credentials,mode:'cors'});return _f.call(_g,i,o);};}
if(typeof XMLHttpRequest!=='undefined'){var _x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,a,us,pw){return _x.call(this,m,_p(u),a!==undefined?a:true,us,pw);};}
if(_g.WebSocket){var _OWS=_g.WebSocket;_g.WebSocket=function(u,p){if(typeof u==='string'&&${wsRe}.test(u))u=_WS+'/?url='+encodeURIComponent(u.replace(/^wss?:/,'https:'));return p?new _OWS(u,p):new _OWS(u);};}
if(typeof Worker!=='undefined'){var _OWk=_g.Worker;_g.Worker=function(u,o){return new _OWk(_p(String(u)),o);};}
if(typeof EventSource!=='undefined'){var _OES=_g.EventSource;_g.EventSource=function(u,o){return new _OES(_p(u),o);};}
if(typeof importScripts!=='undefined'){var _is=importScripts;self.importScripts=function(){return _is.apply(self,Array.from(arguments).map(_p));};}
try{if(typeof navigator!=='undefined'&&navigator.serviceWorker){var _sr=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=function(u,o){return _sr(_p(u),o);};}}catch(_e){}
${forPage ? pageOnly() : ''}
}catch(_e){}})();`;
}

function pageOnly() {
  return `
var _osa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==='action'||n==='href'||n==='src'||n==='data-src')&&typeof v==='string')v=_p(v);return _osa.call(this,n,v);};
document.addEventListener('submit',function(e){var f=e.target,a=f.getAttribute('action')||'';if(a&&!a.startsWith(_W)&&(a.startsWith('http')||a.startsWith('/'))){e.preventDefault();f.setAttribute('action',_p(a.startsWith('http')?a:_T+a));f.submit();}},true);
try{var _ld=Object.getOwnPropertyDescriptor(Location.prototype,'href');if(_ld&&_ld.set){Object.defineProperty(Location.prototype,'href',{get:_ld.get,set:function(u){_ld.set.call(this,_p(String(u)));},configurable:true});}Location.prototype.assign=function(u){location.href=_p(String(u));};Location.prototype.replace=function(u){history.replaceState(null,'',_p(String(u)));};}catch(_e){}
try{var _hrs=history.replaceState.bind(history);history.pushState=function(s,t,u){_hrs(s,t,u?_p(String(u)):u);};}catch(_e){}
try{Object.defineProperty(window,'location',{configurable:true,get:function(){return location;},set:function(u){location.href=_p(String(u));}});}catch(_e){}`;
}

async function proxyWS(request, target, T) {
  const wsTarget = target.replace(/^https?:/, 'wss:');
  const [client, server] = Object.values(new WebSocketPair());
  const h = {'Upgrade':'websocket','Connection':'Upgrade','Sec-WebSocket-Version':'13','Origin':T,
    'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'};
  const proto = request.headers.get('Sec-WebSocket-Protocol');
  if (proto) h['Sec-WebSocket-Protocol'] = proto;
  try {
    const up = await fetch(wsTarget, { headers: h });
    const upstream = up.webSocket; upstream.accept(); server.accept();
    const bridge = (a, b) => { a.addEventListener('message', e => { try { b.send(e.data); } catch {} }); a.addEventListener('close', e => { try { b.close(e.code||1000,e.reason||''); } catch {} }); a.addEventListener('error', () => { try { b.close(); } catch {} }); };
    bridge(server, upstream); bridge(upstream, server);
  } catch (e) { server.accept(); server.close(1011, e.message); }
  return new Response(null, { status: 101, webSocket: client });
}

function buildReqHdrs(request, T) {
  const h = {'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept':request.headers.get('Accept')||'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7','Referer':T+'/','Origin':T,
    'sec-ch-ua':'"Chromium";v="127","Not)A;Brand";v="99","Google Chrome";v="127"','sec-ch-ua-mobile':'?0','sec-ch-ua-platform':'"macOS"',
    'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':request.headers.get('Sec-Fetch-Mode')||'navigate',
    'Sec-Fetch-Dest':request.headers.get('Sec-Fetch-Dest')||'document','Upgrade-Insecure-Requests':'1','DNT':'1'};
  const cookies=(request.headers.get('Cookie')||'').split(';').map(c=>c.trim()).filter(c=>c&&!c.startsWith('proxy_target=')).join('; ');
  if(cookies) h['Cookie']=cookies;
  const ct=request.headers.get('Content-Type'); if(ct) h['Content-Type']=ct;
  return h;
}

function buildOutHdrs(resp, T) {
  const out=new Headers({'access-control-allow-origin':'*','access-control-allow-credentials':'true','cross-origin-resource-policy':'cross-origin'});
  out.append('Set-Cookie',`proxy_target=${encodeURIComponent(T)}; Path=/; SameSite=Lax`);
  for (const c of resp.headers.getAll('set-cookie')) out.append('Set-Cookie',c.replace(/;\s*[Dd]omain=[^;]+/g,'').replace(/;\s*[Ss]ame[Ss]ite=None/gi,'; SameSite=Lax'));
  for (const [k,v] of resp.headers.entries()) { if(!BLOCKED_HEADERS.has(k.toLowerCase())&&k.toLowerCase()!=='set-cookie') out.set(k,v); }
  return out;
}

function corsHdrs() { return {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS','Access-Control-Allow-Headers':'*','Access-Control-Allow-Credentials':'true'}; }

function rewriteHtml(html, W, T, WS) {
  html=html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*\/?>/gi,'');
  html=html.replace(/\s+integrity=["'][^"']*["']/gi,'');
  html=html.replace(/\s+crossorigin=["'][^"']*["']/gi,'');
  html=html.replace(/\s(src|href|action|data-src|poster)=(['"])((?!data:|javascript:|about:|#)[^'"]*)\2/gi,(_,a,q,u)=>` ${a}=${q}${rw(T,W,u)}${q}`);
  html=html.replace(/\ssrcset=(['"])([^'"]+)\1/gi,(_,q,s)=>` srcset=${q}${s.replace(/([^\s,]+)(\s+[^,]+)?/g,(m,u,d)=>rw(T,W,u)+(d||''))}${q}`);
  html=html.replace(/url\(['"]?([^'")\s]+)['"]?\)/g,(_,u)=>`url('${rw(T,W,u)}')`);
  html=html.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/gi,(_,open,code,close)=>open+rewriteImports(code,T,W)+close);
  const inject=`<script>${mkInterceptor(W,T,WS,true)}<\/script>`;
  return html.includes('<head>') ? html.replace('<head>','<head>'+inject) : inject+html;
}

export { rw, rewriteImports, isJs, mkInterceptor, proxyWS,
         buildReqHdrs, buildOutHdrs, corsHdrs, rewriteHtml };
