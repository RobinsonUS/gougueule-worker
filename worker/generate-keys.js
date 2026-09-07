#!/usr/bin/env node
// Génère 50 clés admin au format PYLAB-XXXX-XXXX-XXXX
// Usage : node generate-keys.js
// → affiche les clés (à distribuer) + le SQL pour D1
// → écrit schema-data.sql (prêt à être passé à wrangler d1 execute)

const crypto = require('crypto');

// Alphabet sans les caractères ambigus (0/O, 1/I)
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const N = 50;

function randomGroup() {
  let g = '';
  for (let i = 0; i < 4; i++) g += ALPHA[crypto.randomInt(ALPHA.length)];
  return g;
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

const keys = Array.from({ length: N }, () =>
  `PYLAB-${randomGroup()}-${randomGroup()}-${randomGroup()}`
);

console.log('╔══════════════════════════════════════════════════╗');
console.log('║          CLÉs ADMIN – À conserver précieusement  ║');
console.log('╚══════════════════════════════════════════════════╝');
keys.forEach((k, i) => console.log(`${String(i + 1).padStart(2, ' ')}. ${k}`));

const values = keys.map(k => `('${sha256hex(k)}')`).join(',\n');
const sql = `-- Insérer les clés admin (hachées SHA-256) dans D1\nINSERT INTO admin_keys (key_hash) VALUES\n${values};\n`;

const fs = require('fs');
fs.writeFileSync('schema-data.sql', sql);
console.log('\n✓ schema-data.sql écrit — exécute :');
console.log('  wrangler d1 execute gougueule-db --file=schema-data.sql');
