// Page d'accueil Gougueule
export function uiNavigateur() {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gougueule</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;font-family:arial,sans-serif;background:#fff;color:#202124}
body{display:flex;flex-direction:column}
.center-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0}
.logo{font-size:clamp(40px,10vw,90px);font-weight:400;letter-spacing:-2px;margin-bottom:32px;user-select:none;font-family:-apple-system,"Helvetica Neue",arial,sans-serif;line-height:1}
.logo span:nth-child(1){color:#4285F4}.logo span:nth-child(2){color:#EA4335}.logo span:nth-child(3){color:#FBBC05}.logo span:nth-child(4){color:#4285F4}.logo span:nth-child(5){color:#34A853}.logo span:nth-child(6){color:#EA4335}.logo span:nth-child(7){color:#4285F4}.logo span:nth-child(8){color:#34A853}
.search-wrap{width:min(90%,590px)}
.search-box{display:flex;align-items:center;border:1px solid #dfe1e5;border-radius:24px;padding:8px 16px;height:48px;transition:box-shadow .18s,border-color .18s}
.search-box:hover,.search-box.focused{box-shadow:0 1px 6px rgba(32,33,36,.28);border-color:transparent}
.search-box svg{flex-shrink:0;margin:0 4px}.il{margin-right:8px}.ilp{margin-right:12px}
.search-box input{flex:1;border:none;outline:none;font-size:16px;background:transparent;color:#202124;padding:0 4px;min-width:0}
.ir{display:flex;align-items:center;gap:2px;margin-left:8px}
.buttons{display:flex;justify-content:center;gap:12px;margin-top:28px;flex-wrap:wrap}
.buttons button{background:#f8f9fa;border:1px solid #f8f9fa;border-radius:4px;color:#3c4043;font-size:14px;padding:0 16px;height:36px;cursor:pointer;white-space:nowrap}
.buttons button:hover{box-shadow:0 1px 1px rgba(0,0,0,.1);border-color:#dadce0}
.lr{text-align:center;font-size:13px;margin-top:18px;color:#202124}
.lr a{color:#4285F4;text-decoration:none;padding:0 3px}
footer{background:#f2f2f2;color:#70757a;font-size:14px;flex-shrink:0}
footer .lo{padding:12px 24px;border-bottom:1px solid #dadce0}
footer .lk{display:flex;justify-content:space-between;padding:0 24px;flex-wrap:wrap}
footer .lk>div{display:flex;padding:12px 0;flex-wrap:wrap;gap:4px 0}
footer span,footer a{margin-right:22px;cursor:pointer;color:#70757a;text-decoration:none;padding:3px 0}
footer span:hover{text-decoration:underline}
@media(max-width:560px){footer .lk{flex-direction:column}}
@media(max-height:500px){.logo{font-size:clamp(28px,6vw,56px);margin-bottom:16px}footer{display:none}}
</style></head><body>
<div class="center-wrap">
  <div class="logo"><span>G</span><span>o</span><span>u</span><span>g</span><span>u</span><span>e</span><span>u</span><span>l</span><span>e</span></div>
  <div class="search-wrap">
    <div class="search-box" id="box">
      <svg class="il ilp" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M19 13h-6v6h-2v-6h-6v-2h6V5h2v6h6v2z"/></svg>
      <svg class="il" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path fill="#9aa0a6" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <input id="u" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="ir">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3z"/><path fill="#34A853" d="M11 20.93c-3.94-.49-7-3.86-7-7.93h2c0 3.31 2.69 6 6 6s6-2.69 6-6h2c0 4.07-3.06 7.44-7 7.93V22h-2v-1.07z"/></svg>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M5 13c1.654 0 3-1.346 3-3s-1.346-3-3-3-3 1.346-3 3 1.346 3 3 3zm12-1.5H12v3h4.5V11.5z"/><path fill="#4285F4" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 12.5c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm4-8h-2v-2h-2v2h-2v2h2v2h2v-2h2v-2z"/></svg>
      </div>
    </div>
    <div class="buttons">
      <button onclick="go()">Recherche Gougueule</button>
      <button onclick="goGame()">J'ai de la chance</button>
    </div>
  </div>
  <div class="lr">Gougueule propose en : <a href="#">Francais</a> <a href="#">English</a></div>
</div>
<footer>
  <div class="lo">France</div>
  <div class="lk">
    <div><span>A propos</span><span>Publicite</span><span>Entreprise</span><span>Comment ca marche ?</span></div>
    <div><span>Confidentialite</span><span>Conditions</span><span>Parametres</span></div>
  </div>
</footer>
<script>
var box=document.getElementById('box'),inp=document.getElementById('u');
inp.addEventListener('focus',function(){box.classList.add('focused');});
inp.addEventListener('blur',function(){box.classList.remove('focused');});
function go(){var v=inp.value.trim();if(!v)return;var u=v;if(u.indexOf('://')===-1)u='https://'+u;window.location.replace('/?url='+encodeURIComponent(u));}
function goGame(){window.location.href='/game';}
inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});
inp.focus();
<\/script></body></html>`;
}
