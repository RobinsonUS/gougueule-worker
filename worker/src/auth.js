// worker/src/auth.js
// Fonctions d'authentification pour le Cloudflare Worker.
// Utilise uniquement l'API Web Crypto (disponible nativement dans CF Workers).

const EXP_SECONDES = 30 * 24 * 3600; // 30 jours

// ── Utilitaires base64url ──────────────────────────────────────────

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// ── JWT HS256 ──────────────────────────────────────────────────────

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

export async function signJWT(payload, secret) {
  const header  = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body    = b64url(new TextEncoder().encode(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + EXP_SECONDES,
  })));
  const data    = `${header}.${body}`;
  const key     = await importHmacKey(secret);
  const sig     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const key  = await importHmacKey(secret);
    const sig  = b64urlDecode(parts[2]);
    const ok   = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── Hachage mot de passe (PBKDF2‑SHA256) ──────────────────────────

export function randomSalt() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100_000 },
    key, 256
  );
  return b64url(bits);
}

// ── Hachage clé admin (SHA‑256 hex) ───────────────────────────────

export async function hashAdminKey(key) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key.trim().toUpperCase()));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Réponses JSON ──────────────────────────────────────────────────

export function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export function jsonErr(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
