# Gougueule — proxy + Battle Royale

Deux choses a deployer : un serveur de jeu sur Render, un Worker sur Cloudflare.

## 1. Serveur de jeu (Render)

Dossier `serveur/`.

- Render → New → Web Service → connecte ce depot
- Root Directory : `serveur`
- Build Command : `npm install`
- Start Command : `node server_game.js`
- Region : **Frankfurt** (la plus proche de la France)

Recupere l'URL, du type `https://xxx.onrender.com`, et remplace `https` par `wss`.

> Le plan gratuit met le service en veille apres 15 min d'inactivite, avec 30 a 50 s
> de reveil. Connecte-toi quelques minutes avant une demo, ou passe au plan Starter.

## 2. Worker (Cloudflare)

Dossier `worker/`. Mets ton URL `wss://...` dans `GAME_SERVER_URL` de `wrangler.jsonc`.

### Depuis ton ordi

```bash
cd worker
npm install
npx wrangler login     # une seule fois
npx wrangler deploy
```

`npx wrangler dev` lance un serveur local sur http://localhost:8787 avec rechargement.

### Depuis GitHub, a chaque push

Cloudflare Dashboard → Workers & Pages → ton Worker → Settings → Build →
Connect a repository. Root directory : `worker`, Deploy command : `npx wrangler deploy`.

## Routes

| Route   | Contenu                        |
|---------|--------------------------------|
| `/`     | Accueil Gougueule              |
| `/game` | Battle Royale multijoueur      |
| `/?url=`| Proxy vers un site             |

## Organisation

```
serveur/server_game.js   simulation autoritative 60 Hz, snapshots 30 Hz
worker/src/index.js      routes du Worker
worker/src/proxy.js      reecriture HTML/JS/CSS + WebSocket
worker/src/navigateur.js page d'accueil
worker/game/game.html    le jeu (rendu, netcode, images en base64)
```

## Netcode

- Le serveur est seul juge : deplacements, tirs, degats, morts.
- Le client predit son propre personnage et rejoue ses commandes non confirmees,
  d'ou une reaction immediate meme a ping eleve.
- Les autres joueurs et les balles sont interpoles sur l'horloge serveur,
  avec un retard commun calcule d'apres le joueur le plus lent : tous les
  ecrans affichent le meme instant.
