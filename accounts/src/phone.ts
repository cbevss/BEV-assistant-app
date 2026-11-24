import { ICON_180, ICON_192, ICON_512 } from "./icons";

/**
 * The phone page: talk to BEV on your PC from your phone, watch what it's
 * doing, approve actions (with a second confirmation) and see your screen.
 *
 * Everything between the phone and the PC is encrypted in the browser with a
 * key derived from the account's data key, unlocked with the passphrase. This
 * service only relays ciphertext. The derived key is kept in this browser as
 * a non-extractable CryptoKey (IndexedDB), so the passphrase isn't stored.
 *
 * Text from BEV is only ever put on the page with textContent.
 */

// String.raw keeps the script's backslashes; nothing is interpolated.
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="BEV">
<meta name="referrer" content="no-referrer">
<link rel="icon" type="image/png" sizes="192x192" href="/phone/icon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="/phone/icon-180.png">
<link rel="manifest" href="/phone/manifest.webmanifest">
<title>BEV</title>
<style nonce="__NONCE__">
:root{--bg:#0b0d10;--s1:#12161b;--s2:#181d23;--line:#232a32;--ink:#e7eaee;--ink2:#a3abb5;--ink3:#6f7883;--acc:#4fb8c4;--acc2:#2c7f89;--ok:#5cc28a;--bad:#e5656a;--warn:#e0b252}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit;color:inherit}
html,body{touch-action:manipulation;-webkit-text-size-adjust:100%;text-size-adjust:100%}
/* The page itself never scrolls or bounces: only the chat (and the chip row) do. */
html,body{overflow:hidden;overscroll-behavior:none}
body{position:fixed;inset:0;width:100%}
/* 16px stops iPhones zooming in when a box is tapped. */
input,textarea{font-size:16px}
.app{display:flex;flex-direction:column;height:100%;height:100dvh;max-width:640px;margin:0 auto;overflow:hidden}
header{flex:none;display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top) + 12px) 16px 12px;border-bottom:1px solid var(--line);background:var(--bg);z-index:2;touch-action:none}
.mark{width:26px;height:26px;border-radius:50%;border:1.5px solid var(--acc);display:grid;place-items:center}
.mark i{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--acc)}
.who{flex:1;min-width:0}.who b{display:block;font-weight:600;letter-spacing:.02em}
.pc{font-size:12px;color:var(--ink3);display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ink3)}.dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.icon{background:none;border:1px solid var(--line);border-radius:10px;height:34px;padding:0 10px;color:var(--ink2);cursor:pointer}
.icon:active{background:var(--s2)}
main{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 14px 8px;-webkit-overflow-scrolling:touch}
.live{flex:none;position:relative;height:40vh;height:40dvh;background:#000;border-bottom:1px solid var(--line);overflow:hidden;touch-action:none}
.live[hidden]{display:none}
.live img:not([src]){visibility:hidden}
.zoom video{max-width:100%;max-height:100%;transform-origin:0 0;will-change:transform;pointer-events:none;background:#000}
.zoom video[hidden],.zoom img[hidden]{display:none}
.zoom{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden;touch-action:none}
.zoom img{max-width:100%;max-height:100%;transform-origin:0 0;will-change:transform;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;pointer-events:none}
.livebar{position:absolute;left:8px;right:8px;top:8px;display:flex;gap:6px;align-items:center;pointer-events:none}
.livebar>*{pointer-events:auto}
.pill{background:#000b;border:1px solid #ffffff22;border-radius:999px;padding:4px 10px;font-size:12px;color:var(--ink);display:flex;align-items:center;gap:6px}
.pill .dot.on{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.pill.btn2{cursor:pointer}.grow{flex:1}
.livemsg{position:absolute;inset:0;display:grid;place-items:center;color:var(--ink3);font-size:13px;text-align:center;padding:24px;pointer-events:none}
.chip.on{border-color:var(--bad);color:var(--ink)}
.empty{color:var(--ink3);text-align:center;margin-top:18vh;padding:0 24px}
.row{display:flex;margin:6px 0}.row.user{justify-content:flex-end}
.bubble{max-width:84%;padding:9px 12px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}
.user .bubble{background:var(--acc2);border-bottom-right-radius:5px}
.assistant .bubble{background:var(--s2);border:1px solid var(--line);border-bottom-left-radius:5px}
.pending .bubble{opacity:.6}
.meta{font-size:11px;color:var(--ink3);margin:2px 4px 0}.user .meta{text-align:right}
.col{display:flex;flex-direction:column;max-width:84%}.user .col{align-items:flex-end}
.step{display:flex;gap:8px;align-items:baseline;font-size:13px;color:var(--ink2);margin:3px 6px;padding-left:2px}
.step .s{font-size:12px;width:14px;flex:none;text-align:center}.step.ok .s{color:var(--ok)}.step.bad .s{color:var(--bad)}
.step small{color:var(--ink3);display:block;white-space:pre-wrap;word-break:break-word}
.card{background:var(--s1);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:12px;padding:12px;margin:10px 0}
.card h3{margin:0 0 4px;font-size:13px;font-weight:600;color:var(--warn)}.card p{margin:0 0 10px;white-space:pre-wrap}
.card.confirm{border-left-color:var(--bad)}.card.confirm h3{color:var(--bad)}
.card.done{border-left-color:var(--line)}.card.done h3{color:var(--ink3)}
.btns{display:flex;gap:8px}.btn{flex:1;height:42px;border-radius:10px;border:1px solid var(--line);background:var(--s2);cursor:pointer;font-weight:500}
.btn.go{background:var(--acc2);border-color:var(--acc2)}.btn.danger{background:#7a2b30;border-color:#93353b}
.btn:disabled{opacity:.5}
.shot{margin:10px 0}.shot img{width:100%;border-radius:10px;border:1px solid var(--line);display:block}.shot .meta{text-align:left}
footer{flex:none;border-top:1px solid var(--line);padding:10px 12px calc(env(safe-area-inset-bottom) + 10px);background:var(--bg)}
.compose{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;resize:none;max-height:120px;min-height:44px;border-radius:14px;border:1px solid var(--line);background:var(--s1);padding:11px 13px;outline:none}
textarea:focus{border-color:var(--acc2)}
.attach{height:44px;width:44px;flex:none;border-radius:14px;border:1px solid var(--line);background:var(--s1);color:var(--ink2);font-size:20px;cursor:pointer}
.attach:disabled{opacity:.4}
.atts{display:flex;gap:8px;margin-bottom:8px;overflow-x:auto;scrollbar-width:none}.atts::-webkit-scrollbar{display:none}
.att{flex:none;position:relative;display:flex;align-items:center;gap:6px;max-width:180px;border:1px solid var(--line);background:var(--s1);border-radius:10px;padding:4px 26px 4px 4px;font-size:12px;color:var(--ink2)}
.att img{width:40px;height:40px;border-radius:7px;object-fit:cover;display:block}
.att span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.att .fi{width:40px;height:40px;border-radius:7px;background:var(--s2);display:grid;place-items:center;font-size:18px}
.att button{position:absolute;top:2px;right:2px;width:22px;height:22px;border-radius:50%;border:0;background:var(--s2);color:var(--ink2);cursor:pointer;font-size:12px}
.files{font-size:12px;color:var(--ink2);margin-top:2px}
.send{height:44px;min-width:64px;border-radius:14px;border:0;background:var(--acc);color:#05262a;font-weight:600;cursor:pointer}
.send:disabled{opacity:.4}
.tools{display:flex;gap:8px;margin-bottom:8px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.tools::-webkit-scrollbar{display:none}
.chip{flex:none;white-space:nowrap;border:1px solid var(--line);background:var(--s1);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--ink2);cursor:pointer}
.gate{flex:1;display:flex;flex-direction:column;justify-content:center;padding:24px}
.gate h1{font-size:22px;font-weight:600;margin:16px 0 6px}.gate p{color:var(--ink2);margin:0 0 18px}
.gate input{width:100%;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--s1);padding:0 14px;margin-bottom:10px;outline:none}
.gate input:focus{border-color:var(--acc2)}
.gate .btn{width:100%;flex:none}
.mt{margin-top:10px}.err{color:var(--bad);font-size:13px;min-height:18px;margin:6px 0}
.btn.discord{background:#5865f2;border-color:#5865f2;color:#fff}
.hint{font-size:12px;color:var(--ink3);margin-top:14px}
.viewer{position:fixed;inset:0;background:#000;display:none;z-index:9;touch-action:none}.viewer.open{display:block}
.viewer .close{position:absolute;top:calc(env(safe-area-inset-top) + 10px);right:12px;z-index:2}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.row,.card,.step{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(4px)}}}
</style>
</head>
<body>
<div class="app" id="app"></div>
<div class="viewer" id="viewer" role="dialog" aria-label="Screenshot"><div class="zoom"><img alt="Your screen"></div><button class="pill btn2 close" type="button" aria-label="Close">Close</button></div>
<script nonce="__NONCE__">
"use strict";
// No pinch or double-tap zoom (iOS ignores user-scalable=no for pinches).
["gesturestart","gesturechange","gestureend"].forEach(function(t){document.addEventListener(t,function(e){e.preventDefault();},{passive:false});});
// Pinches only zoom the live screen and pictures (handled there); one finger
// only scrolls the chat, the chip row and the message box.
document.addEventListener("touchmove",function(e){if(e.touches&&e.touches.length>1){e.preventDefault();return;}var t=e.target;if(!(t&&t.closest&&t.closest("main,.tools,.atts,textarea")))e.preventDefault();},{passive:false});
var lastTouch=0;document.addEventListener("touchend",function(e){var n=Date.now();if(n-lastTouch<300&&!(e.target&&e.target.closest&&e.target.closest("textarea,input")))e.preventDefault();lastTouch=n;},{passive:false});
var te = new TextEncoder(), td = new TextDecoder();
function b64(u8){var s="";for(var i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s);}
function unb64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0);});}
function b64url(u8){return b64(u8).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function rand(n){return crypto.getRandomValues(new Uint8Array(n));}
function newId(){return b64url(rand(12));}

// ---- tiny IndexedDB store (holds the non-extractable key)
// Some browsers (private modes) block or stall storage: then the key just
// lives in memory and you unlock again next time.
var noStorage=false;
function soon(p,fallback){if(noStorage)return Promise.resolve(fallback);return Promise.race([p,new Promise(function(res){setTimeout(function(){noStorage=true;res(fallback);},2500);})]).catch(function(){noStorage=true;return fallback;});}
var dbp=null;
function idb(){return dbp=dbp||new Promise(function(res,rej){var r=indexedDB.open("bev-phone",1);r.onupgradeneeded=function(){r.result.createObjectStore("kv");};r.onsuccess=function(){res(r.result);};r.onerror=function(){rej(r.error);};});}
function kvGet(k){if(noStorage)return Promise.resolve(undefined);return soon(idb().then(function(db){return new Promise(function(res,rej){var q=db.transaction("kv").objectStore("kv").get(k);q.onsuccess=function(){res(q.result);};q.onerror=function(){rej(q.error);};});}),undefined);}
function kvSet(k,v){if(noStorage)return Promise.resolve();return soon(idb().then(function(db){return new Promise(function(res,rej){var t=db.transaction("kv","readwrite");if(v===undefined)t.objectStore("kv").delete(k);else t.objectStore("kv").put(v,k);t.oncomplete=function(){res();};t.onerror=function(){rej(t.error);};});}),undefined);}

// ---- DOM helper: text only, never HTML
function h(tag,attrs,kids){var e=document.createElement(tag);attrs=attrs||{};for(var k in attrs){if(k==="text")e.textContent=attrs[k];else if(k==="on")for(var ev in attrs.on)e.addEventListener(ev,attrs.on[ev]);else if(attrs[k]!==false&&attrs[k]!=null)e.setAttribute(k,attrs[k]===true?"":attrs[k]);}(kids||[]).forEach(function(c){if(c)e.appendChild(typeof c==="string"?document.createTextNode(c):c);});return e;}
var app=document.getElementById("app");
function show(nodes){app.textContent="";nodes.forEach(function(n){app.appendChild(n);});}

var token=localStorage.getItem("bev_token");
var key=null, userId=null, userName="";

function api(path,opts){opts=opts||{};return fetch(path,{method:opts.method||"GET",headers:Object.assign({authorization:"Bearer "+token},opts.body?{"content-type":"application/json"}:{}),body:opts.body?JSON.stringify(opts.body):undefined,cache:"no-store"}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(r.status===401){signOut();throw new Error("You were signed out. Sign in again.");}if(!r.ok)throw new Error(j.error||("Error "+r.status));return j;});});}

// ---- encryption (same scheme as the app)
function kek(secret,salt,it){return crypto.subtle.importKey("raw",te.encode(secret),"PBKDF2",false,["deriveKey"]).then(function(base){return crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt:salt,iterations:it},base,{name:"AES-GCM",length:256},false,["decrypt"]);});}
function unwrapW(w,secret){return kek(secret,unb64(w.salt),w.iterations).then(function(k){return crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(w.iv),additionalData:te.encode("bev-vault-v1")},k,unb64(w.ct));}).then(function(b){return new Uint8Array(b);});}
function normRecovery(s){return s.toUpperCase().replace(/[\s-]+/g,"").replace(/O/g,"0").replace(/[IL]/g,"1").replace(/U/g,"V");}
function unlockVault(vault,secret){var n=normRecovery(secret);var tryPass=function(){return unwrapW(vault.passphrase,secret);};if(/^[0-9A-HJKMNP-TV-Z]{32}$/.test(n))return unwrapW(vault.recovery,n).catch(tryPass);return tryPass();}
function phoneKey(dek){return crypto.subtle.importKey("raw",dek,"HKDF",false,["deriveKey"]).then(function(base){return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt:new Uint8Array(0),info:te.encode("bev-phone-v1")},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);});}
function aad(dir){return te.encode("bev-phone:"+dir+":"+userId);}
function seal(obj){var iv=rand(12);return crypto.subtle.encrypt({name:"AES-GCM",iv:iv,additionalData:aad("to_pc")},key,te.encode(JSON.stringify(obj))).then(function(ct){return {iv:b64(iv),ct:b64(new Uint8Array(ct))};});}
function openMsg(m){return crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(m.iv),additionalData:aad("to_phone")},key,unb64(m.ct)).then(function(pt){return JSON.parse(td.decode(pt));});}
function sendToPc(obj){obj.t=Date.now();return seal(obj).then(function(e){return api("/phone/messages",{method:"POST",body:{dir:"to_pc",iv:e.iv,ct:e.ct}});});}

function signOut(){if(live.on&&live.panel)stopLive();var t=token;token=null;localStorage.removeItem("bev_token");kvSet("key",undefined);kvSet("user",undefined);if(t)fetch("/auth/logout",{method:"POST",headers:{authorization:"Bearer "+t}}).catch(function(){});stopPolling();gateSignIn();}

// ---- pinch-to-zoom for one picture (the live screen or a screenshot)
function zoomable(box,img){
  var z={s:1,x:0,y:0},start=null,lastTap=0;
  function apply(){img.style.transform="translate("+z.x+"px,"+z.y+"px) scale("+z.s+")";}
  function clamp(){var bw=box.clientWidth,bh=box.clientHeight,iw=img.offsetWidth*z.s,ih=img.offsetHeight*z.s,ox=img.offsetLeft,oy=img.offsetTop;
    if(z.s<=1){z.s=1;z.x=0;z.y=0;return;}
    var minX=bw-iw-ox,maxX=-ox,minY=bh-ih-oy,maxY=-oy;
    if(iw<=bw)z.x=(bw-iw)/2-ox;else z.x=Math.min(maxX,Math.max(minX,z.x));
    if(ih<=bh)z.y=(bh-ih)/2-oy;else z.y=Math.min(maxY,Math.max(minY,z.y));}
  function pt(t){var r=box.getBoundingClientRect();return {x:t.clientX-r.left-img.offsetLeft,y:t.clientY-r.top-img.offsetTop};}
  box.addEventListener("touchstart",function(e){var t=e.touches;
    if(t.length===2){var a=pt(t[0]),b=pt(t[1]);start={d:Math.hypot(a.x-b.x,a.y-b.y),mx:(a.x+b.x)/2,my:(a.y+b.y)/2,s:z.s,x:z.x,y:z.y};}
    else if(t.length===1){var p=pt(t[0]),n=Date.now();
      if(n-lastTap<300){/* double tap: zoom in to 2.5x there, or back out */var ns=z.s>1?1:2.5;z.x=p.x-(p.x-z.x)*ns/z.s;z.y=p.y-(p.y-z.y)*ns/z.s;z.s=ns;clamp();apply();lastTap=0;start=null;return;}
      lastTap=n;start={px:p.x,py:p.y,x:z.x,y:z.y};}},{passive:true});
  box.addEventListener("touchmove",function(e){if(!start)return;e.preventDefault();var t=e.touches;
    if(t.length===2&&start.d){var a=pt(t[0]),b=pt(t[1]),d=Math.hypot(a.x-b.x,a.y-b.y),mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      var ns=Math.min(6,Math.max(1,start.s*d/start.d));
      // keep the point between the fingers under the fingers
      z.x=mx-(start.mx-start.x)*ns/start.s;z.y=my-(start.my-start.y)*ns/start.s;z.s=ns;clamp();apply();}
    else if(t.length===1&&start.px!==undefined&&z.s>1){var p=pt(t[0]);z.x=start.x+(p.x-start.px);z.y=start.y+(p.y-start.py);clamp();apply();}},{passive:false});
  box.addEventListener("touchend",function(e){if(e.touches.length===0)start=null;else if(e.touches.length===1){var p=pt(e.touches[0]);start={px:p.x,py:p.y,x:z.x,y:z.y};}});
  return {reset:function(){z={s:1,x:0,y:0};apply();},zoomed:function(){return z.s>1;},target:function(el){img.style.transform="";img=el;z={s:1,x:0,y:0};apply();}};
}

// ---- attachments: pictures are shrunk on the phone; other files go as they are
var pend=[], attsEl=null, attachBtn=null, fileInput=null;
var MAX_FILES=4, BUDGET=1000*1024, FILE_MAX=900*1024;
function readB64(file){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(String(r.result).split(",")[1]||"");};r.onerror=function(){rej(r.error);};r.readAsDataURL(file);});}
function shrinkPic(file,edge,q){return new Promise(function(res,rej){var url=URL.createObjectURL(file),img=new Image();img.onload=function(){var s=Math.min(1,edge/Math.max(img.width,img.height)),c=document.createElement("canvas");c.width=Math.max(1,Math.round(img.width*s));c.height=Math.max(1,Math.round(img.height*s));var g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,c.width,c.height);g.drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);res(c.toDataURL("image/jpeg",q).split(",")[1]);};img.onerror=function(){URL.revokeObjectURL(url);rej(new Error("That picture couldn't be opened."));};img.src=url;});}
function pendBytes(){return pend.reduce(function(n,p){return n+p.data.length*0.75;},0);}
function addFiles(list){
  var files=Array.prototype.slice.call(list||[]);
  files.reduce(function(p,f){return p.then(function(){
    if(pend.length>=MAX_FILES){toast("You can send up to "+MAX_FILES+" at once.");return;}
    var isPic=/^image\//.test(f.type);
    var make=isPic?shrinkPic(f,1600,0.8).then(function(d){return d.length*0.75>350*1024?shrinkPic(f,1280,0.65):d;}):(f.size>FILE_MAX?Promise.reject(new Error(f.name+" is too big to send from your phone (up to 900 KB).")):readB64(f));
    return make.then(function(data){
      if(pendBytes()+data.length*0.75>BUDGET)throw new Error("That's too much for one message. Send it on its own.");
      pend.push({id:newId(),name:f.name||(isPic?"Photo.jpg":"File"),mime:isPic?"image/jpeg":(f.type||"application/octet-stream"),data:data,thumb:isPic?"data:image/jpeg;base64,"+data:null});
    });
  }).catch(function(e){toast(e.message||String(e));});},Promise.resolve()).then(renderAtts);
}
function renderAtts(){
  if(!attsEl)return;attsEl.textContent="";attsEl.hidden=!pend.length;
  pend.forEach(function(p){attsEl.appendChild(h("div",{class:"att",title:p.name},[p.thumb?h("img",{src:p.thumb,alt:""}):h("div",{class:"fi","aria-hidden":"true",text:"📄"}),h("span",{text:p.name}),h("button",{type:"button","aria-label":"Remove "+p.name,on:{click:function(){pend=pend.filter(function(x){return x!==p;});renderAtts();}}},["✕"])]));});
  attachBtn.disabled=pend.length>=MAX_FILES;
  sendBtn.disabled=!input.value.trim()&&!pend.length;
}

function toast(msg){var id=newId();feed.set(id,{id:id,role:"tool",label:"Couldn't attach",text:msg,ok:false,at:Date.now(),local:true});stickToBottom=true;render();}

// ---- live screen
var live={on:false,seq:0,display:"current",lastAt:0,frameTimer:null,beatTimer:null,panel:null,img:null,video:null,msg:null,state:null,zoom:null,chip:null};

// ---- live video (WebRTC): the real stream, up to 60 fps. The picture-every-second
// feed keeps going underneath until the video is playing, and takes over if it drops.
var rtc={pc:null,sid:"",cursor:-1,timer:null,playing:false,pending:[]};
function rtcAad(side){return te.encode("bev-phone:rtc_"+side+":"+userId);}
function rtcSend(obj){var iv=rand(12);return crypto.subtle.encrypt({name:"AES-GCM",iv:iv,additionalData:rtcAad("pc")},key,te.encode(JSON.stringify(obj))).then(function(ct){return api("/phone/rtc",{method:"POST",body:{to:"pc",iv:b64(iv),ct:b64(new Uint8Array(ct))}});});}
function rtcOpen(m){return crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(m.iv),additionalData:rtcAad("phone")},key,unb64(m.ct)).then(function(pt){return JSON.parse(td.decode(pt));});}
function rtcStart(){
  if(!window.RTCPeerConnection||!key)return;
  rtcStop(false);
  rtc.sid=b64url(rand(9));rtc.cursor=-1;rtc.playing=false;rtc.pending=[];
  api("/phone/rtc?for=phone&after=999999999999").then(function(r){rtc.cursor=r.latest||0;}).catch(function(){rtc.cursor=0;}).then(function(){
    rtcSend({type:"hello",sid:rtc.sid,display:live.display}).catch(function(){});rtcPoll();});
}
function rtcPoll(){
  clearTimeout(rtc.timer);
  if(!live.on||!rtc.sid)return;
  api("/phone/rtc?for=phone&after="+Math.max(0,rtc.cursor)).then(function(r){
    var chain=Promise.resolve();
    (r.messages||[]).forEach(function(m){rtc.cursor=Math.max(rtc.cursor,m.id);chain=chain.then(function(){return rtcOpen(m).then(rtcOn,function(){});});});
    return chain;
  }).catch(function(){}).then(function(){rtc.timer=setTimeout(rtcPoll,rtc.playing?2000:350);});
}
function rtcOn(s){
  if(!s||s.sid!==rtc.sid)return;
  if(s.type==="offer"){
    return api("/phone/ice").catch(function(){return {iceServers:[{urls:"stun:stun.cloudflare.com:3478"}]};}).then(function(ice){
      var pc=new RTCPeerConnection({iceServers:ice.iceServers});rtc.pc=pc;
      pc.onicecandidate=function(e){if(e.candidate)rtcSend({type:"ice",sid:rtc.sid,c:e.candidate.toJSON()}).catch(function(){});};
      pc.ontrack=function(e){var v=live.video;v.srcObject=e.streams[0]||new MediaStream([e.track]);v.play().catch(function(){});};
      pc.onconnectionstatechange=function(){if(pc!==rtc.pc)return;
        if(pc.connectionState==="failed"||pc.connectionState==="disconnected"){rtcFallback();}};
      return pc.setRemoteDescription({type:"offer",sdp:s.sdp}).then(function(){var p=rtc.pending.splice(0);return Promise.all(p.map(function(c){return pc.addIceCandidate(c).catch(function(){});}));})
        .then(function(){return pc.createAnswer();}).then(function(a){return pc.setLocalDescription(a).then(function(){return rtcSend({type:"answer",sid:rtc.sid,sdp:a.sdp});});});
    });
  }
  if(s.type==="ice"){if(rtc.pc&&rtc.pc.remoteDescription)return rtc.pc.addIceCandidate(s.c).catch(function(){});rtc.pending.push(s.c);}
}
function rtcPlaying(){
  if(!live.on)return;
  rtc.playing=true;clearTimeout(live.frameTimer);
  live.img.hidden=true;live.video.hidden=false;live.zoom.target(live.video);
  live.msg.textContent="";live.state.textContent="Live video";
}
function rtcFallback(){
  if(!rtc.playing)return;
  rtc.playing=false;live.video.hidden=true;live.img.hidden=false;live.zoom.target(live.img);
  live.state.textContent="Live (pictures)";if(live.on)pollFrame();
}
function rtcStop(tell){
  clearTimeout(rtc.timer);
  if(tell&&rtc.sid)rtcSend({type:"bye",sid:rtc.sid}).catch(function(){});
  if(rtc.pc){rtc.pc.onconnectionstatechange=null;rtc.pc.close();rtc.pc=null;}
  rtc.sid="";rtc.playing=false;
  if(live.video){live.video.srcObject=null;live.video.hidden=true;}
  if(live.img)live.img.hidden=false;
  if(live.zoom)live.zoom.target(live.img);
}
var DISPLAY_NAMES={current:"Active screen",all:"All screens",primary:"Main screen"};
function liveBeat(){if(!live.on||document.hidden)return;api("/phone/live",{method:"POST",body:{on:true,display:live.display}}).catch(function(){});}
function startLive(){live.on=true;live.seq=0;live.lastAt=0;live.waitSince=0;live.panel.hidden=false;live.chip.classList.add("on");live.chip.textContent="Stop live screen";live.msg.textContent="Connecting to your PC…";live.img.removeAttribute("src");live.zoom.reset();
  liveBeat();clearInterval(live.beatTimer);live.beatTimer=setInterval(liveBeat,15000);pollFrame();rtcStart();keepChatAtBottom();}
function stopLive(){rtcStop(true);live.on=false;clearInterval(live.beatTimer);clearTimeout(live.frameTimer);live.panel.hidden=true;live.chip.classList.remove("on");live.chip.textContent="Live screen";
  api("/phone/live",{method:"POST",body:{on:false}}).catch(function(){});keepChatAtBottom();}
// The chat gets shorter or taller when the live panel opens or closes: stay at the newest message.
function keepChatAtBottom(){if(stickToBottom&&mainEl)requestAnimationFrame(function(){mainEl.scrollTop=mainEl.scrollHeight;});}
function openFrame(f){return crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(f.iv),additionalData:aad("frame")},key,unb64(f.ct)).then(function(pt){return JSON.parse(td.decode(pt));});}
function pollFrame(){
  clearTimeout(live.frameTimer);
  if(!live.on||document.hidden||!key||rtc.playing)return;
  var got=false;
  api("/phone/frame?after="+live.seq).then(function(f){
    if(f.ct){got=true;live.seq=f.seq;return openFrame(f).then(function(p){if(p&&p.type==="frame"&&p.data){live.img.src="data:image/jpeg;base64,"+p.data;live.lastAt=Date.now();live.msg.textContent="";live.state.textContent=String(p.label||"Your screen");}},function(){});}
    if(!live.lastAt){var on=f.pc_last_seen&&f.now-f.pc_last_seen<30000;live.waitSince=live.waitSince||Date.now();
      live.msg.textContent=!on?"Your PC isn't connected. Is BEV open with Phone control on?":Date.now()-live.waitSince>20000?"Still no picture. Check the chat below for a message from your PC, or stop and start the live screen.":"Waiting for the first picture…";}
  }).catch(function(){}).then(function(){
    if(live.lastAt&&Date.now()-live.lastAt>8000)live.state.textContent="Paused (no new picture)";
    live.frameTimer=setTimeout(pollFrame,got?250:700);});
}
function liveNode(){
  live.img=h("img",{alt:"Your PC's screen, live",draggable:"false"});
  live.video=h("video",{muted:"",playsinline:"",autoplay:"",hidden:true,"aria-label":"Your PC's screen, live video"});
  live.video.muted=true;
  live.video.addEventListener("playing",rtcPlaying);
  var box=h("div",{class:"zoom"},[live.img,live.video]);
  live.zoom=zoomable(box,live.img);
  live.msg=h("div",{class:"livemsg",role:"status"});
  live.state=h("span",{text:"Live"});
  var which=h("button",{class:"pill btn2",type:"button",on:{click:function(){var order=["current","all","primary"];live.display=order[(order.indexOf(live.display)+1)%3];which.textContent=DISPLAY_NAMES[live.display];live.zoom.reset();liveBeat();if(live.on)rtcStart();}}},[DISPLAY_NAMES[live.display]]);
  var close=h("button",{class:"pill btn2",type:"button","aria-label":"Stop live screen",on:{click:stopLive}},["✕"]);
  live.panel=h("section",{class:"live",hidden:true,"aria-label":"Live screen"},[box,live.msg,h("div",{class:"livebar"},[h("span",{class:"pill"},[h("span",{class:"dot on"}),live.state]),h("span",{class:"grow"}),which,close])]);
  return live.panel;
}
document.addEventListener("visibilitychange",function(){if(!live.on)return;if(document.hidden)clearTimeout(live.frameTimer);else{liveBeat();pollFrame();if(!rtc.playing)rtcStart();}});

// ---- screens
function logo(){return h("div",{class:"mark","aria-hidden":"true"},[h("i")]);}
function gateSignIn(msg){
  show([h("div",{class:"gate"},[logo(),h("h1",{text:"BEV on your phone"}),h("p",{text:"Ask BEV to do things on your PC, see what it's doing and approve actions while you're away. Sign in with the Discord account you use in the BEV app."}),
    h("div",{class:"err",role:"alert",text:msg||""}),
    h("button",{class:"btn go discord",on:{click:startSignIn}},["Sign in with Discord"]),
    h("p",{class:"hint",text:"Messages between your phone and PC are encrypted with your passphrase. The BEV service only passes them along."})])]);
}
function startSignIn(){var verifier=b64url(rand(32)),state=b64url(rand(18));sessionStorage.setItem("bev_pkce",JSON.stringify({verifier:verifier,state:state}));crypto.subtle.digest("SHA-256",te.encode(verifier)).then(function(d){location.href="/auth/discord?"+new URLSearchParams({redirect:location.origin+"/phone",state:state,challenge:b64url(new Uint8Array(d))});});}
function finishSignIn(q){
  var saved={};try{saved=JSON.parse(sessionStorage.getItem("bev_pkce")||"{}");}catch(e){}
  sessionStorage.removeItem("bev_pkce");history.replaceState(null,"","/phone");
  if(q.get("error"))return gateSignIn(q.get("error")==="cancelled"?"Sign-in was cancelled.":"Discord sign-in didn't work. Try again.");
  if(!saved.state||q.get("state")!==saved.state)return gateSignIn("That sign-in didn't match. Try again.");
  return fetch("/auth/token",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:q.get("code"),verifier:saved.verifier,device:"Phone (browser)"})}).then(function(r){return r.json().then(function(j){if(!r.ok||!j.token)throw new Error(j.error||"Sign-in failed");token=j.token;localStorage.setItem("bev_token",token);return boot();});}).catch(function(e){gateSignIn(e.message);});
}
function gateUnlock(vault){
  var input=h("input",{type:"password",autocomplete:"current-password",placeholder:"Passphrase or recovery key","aria-label":"Passphrase or recovery key"});
  var err=h("div",{class:"err",role:"alert"});
  var btn=h("button",{class:"btn go"},["Unlock"]);
  function go(){if(!input.value)return;btn.disabled=true;btn.textContent="Unlocking…";err.textContent="";
    Promise.resolve().then(function(){return unlockVault(vault,input.value);}).then(phoneKey).then(function(k){key=k;return kvSet("key",k);}).then(function(){input.value="";startMain();})
    .catch(function(){btn.disabled=false;btn.textContent="Unlock";err.textContent="That passphrase or recovery key didn't work.";});}
  btn.addEventListener("click",go);input.addEventListener("keydown",function(e){if(e.key==="Enter")go();});
  show([h("div",{class:"gate"},[logo(),h("h1",{text:"Unlock BEV"}),h("p",{text:"Enter the passphrase you chose in the BEV app. It's used here to unlock the encryption key and isn't saved or sent anywhere."}),input,err,btn,
    h("button",{class:"btn mt",on:{click:signOut}},["Sign out"])])]);
  input.focus();
}

// ---- main
var feed=new Map(), approvals=new Map(), shots=[], cursor=0, pollTimer=null, statusTimer=null, pcSeen=null, now0=Date.now();
var mainEl, statusDot, statusText, input, sendBtn, stickToBottom=true;

function startMain(){
  statusDot=h("span",{class:"dot"});statusText=h("span",{text:"Checking your PC…"});
  mainEl=h("main",{"aria-live":"polite"});
  mainEl.addEventListener("scroll",function(){stickToBottom=mainEl.scrollHeight-mainEl.scrollTop-mainEl.clientHeight<80;});
  input=h("textarea",{rows:"1",placeholder:"Ask BEV…","aria-label":"Message BEV",enterkeyhint:"send"});
  input.addEventListener("input",function(){input.style.height="auto";input.style.height=Math.min(120,input.scrollHeight)+"px";sendBtn.disabled=!input.value.trim()&&!pend.length;});
  fileInput=h("input",{type:"file",multiple:true,hidden:true,"aria-hidden":"true"});
  fileInput.addEventListener("change",function(){addFiles(fileInput.files);fileInput.value="";});
  attachBtn=h("button",{class:"attach",type:"button","aria-label":"Attach pictures or files",on:{click:function(){fileInput.click();}}},["+"]);
  attsEl=h("div",{class:"atts",hidden:true});
  input.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&window.matchMedia("(pointer:fine)").matches){e.preventDefault();send();}});
  sendBtn=h("button",{class:"send",disabled:true,on:{click:send}},["Send"]);
  var screenBtn=h("button",{class:"chip",on:{click:askScreen}},["Show my screen"]);
  live.chip=h("button",{class:"chip",on:{click:function(){if(live.on)stopLive();else startLive();}}},["Live screen"]);
  // One-tap requests; they go through BEV like typed ones.
  var quick=[["Play / pause","Play or pause the music"],["Next track","Skip to the next track"],["Mute","Mute the PC's sound"],["Lock PC","Lock my PC"],["Today","What did I do today?"]].map(function(q){return h("button",{class:"chip",on:{click:function(){input.value=q[1];send();}}},[q[0]]);});
  show([
    h("header",{},[logo(),h("div",{class:"who"},[h("b",{text:"BEV"}),h("div",{class:"pc"},[statusDot,statusText])]),h("button",{class:"icon",on:{click:function(){if(confirm("Sign out of BEV on this phone?"))signOut();}}},["Sign out"])]),
    liveNode(),
    mainEl,
    h("footer",{},[h("div",{class:"tools"},[live.chip,screenBtn].concat(quick)),attsEl,h("div",{class:"compose"},[attachBtn,input,sendBtn,fileInput])])
  ]);
  render();
  poll(true);
  checkStatus();
  statusTimer=setInterval(checkStatus,10000);
}
function stopPolling(){clearTimeout(pollTimer);clearInterval(statusTimer);pollTimer=null;}

function ago(t){var s=Math.round((Date.now()-t)/1000);if(s<60)return "just now";var m=Math.round(s/60);if(m<60)return m+" min ago";var hr=Math.round(m/60);return hr<24?hr+" h ago":Math.round(hr/24)+" d ago";}
function clock(t){return new Date(t).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});}
function checkStatus(){api("/phone/status").then(function(s){pcSeen=s.pc_last_seen;var on=pcSeen&&s.now-pcSeen<30000;statusDot.className="dot"+(on?" on":"");statusText.textContent=on?"Your PC is online":pcSeen?"PC last seen "+ago(Date.now()-(s.now-pcSeen)):"PC not connected yet: turn on Phone control in BEV";}).catch(function(){});}

function poll(first){
  clearTimeout(pollTimer);
  if(!token||!key)return;
  api("/phone/messages?dir=to_phone&since="+cursor).then(function(r){
    var ms=r.messages||[];
    return ms.reduce(function(p,m){return p.then(function(){cursor=Math.max(cursor,m.id);return openMsg(m).then(handle,function(){});});},Promise.resolve()).then(function(){if(ms.length||first)render();});
  }).catch(function(){}).then(function(){pollTimer=setTimeout(poll,document.hidden?15000:2500);});
}
document.addEventListener("visibilitychange",function(){if(!document.hidden&&key&&token){poll();checkStatus();}});

function handle(p){
  if(!p||typeof p!=="object")return;
  if(p.type==="feed")(p.items||[]).forEach(function(it){if(it&&it.id)feed.set(it.id,it);});
  else if(p.type==="approval"&&p.id)approvals.set(p.id,{id:p.id,text:String(p.text||""),expires:p.expires||0,at:p.t||Date.now(),stage:approvals.has(p.id)?approvals.get(p.id).stage:"ask"});
  else if(p.type==="approval_done"&&approvals.has(p.re)){var a=approvals.get(p.re);a.stage="done";a.outcome=p.outcome;}
  else if(p.type==="screen"&&p.data){shots.push({id:p.id||newId(),data:p.data,label:String(p.label||"Your screen"),at:p.t||Date.now()});if(shots.length>3)shots.shift();}
}

function send(){
  var text=input.value.trim();if(!text&&!pend.length)return;
  var files=pend.map(function(p){return {name:p.name,mime:p.mime,data:p.data};});
  var id=newId();feed.set(id,{id:id,role:"user",text:text,files:files.map(function(f){return f.name;}),at:Date.now(),source:"phone",pending:true});
  input.value="";input.style.height="auto";pend=[];renderAtts();sendBtn.disabled=true;stickToBottom=true;render();
  sendToPc(files.length?{type:"ask",id:id,text:text,files:files}:{type:"ask",id:id,text:text}).then(function(){poll();}).catch(function(e){var it=feed.get(id);if(it&&it.pending){it.failed=e.message;render();}});
}
function askScreen(){var id=newId();feed.set(id,{id:id,role:"tool",label:"Asked your PC for a screenshot",text:"",ok:true,at:Date.now(),local:true});stickToBottom=true;render();sendToPc({type:"screen",id:id}).then(function(){poll();}).catch(function(e){var it=feed.get(id);it.ok=false;it.text=e.message;render();});}
function answer(a,allow){a.stage=allow?"sent-allow":"sent-deny";render();sendToPc({type:"approve",id:newId(),re:a.id,allow:allow}).then(function(){poll();}).catch(function(e){a.stage="ask";a.err=e.message;render();});}

function render(){
  if(!mainEl)return;
  var items=[];
  feed.forEach(function(it){items.push({at:it.at||0,kind:"feed",it:it});});
  approvals.forEach(function(a){items.push({at:a.at,kind:"approval",a:a});});
  shots.forEach(function(s){items.push({at:s.at,kind:"shot",s:s});});
  items.sort(function(x,y){return x.at-y.at;});
  mainEl.textContent="";
  if(!items.length)mainEl.appendChild(h("p",{class:"empty",text:"Ask BEV anything, like “is my download finished?” or “pause the music”. What BEV does on your PC shows up here, from here or from the PC."}));
  items.forEach(function(x){mainEl.appendChild(x.kind==="feed"?feedNode(x.it):x.kind==="approval"?approvalNode(x.a):shotNode(x.s));});
  if(stickToBottom)mainEl.scrollTop=mainEl.scrollHeight;
}
function feedNode(it){
  if(it.role==="tool"){var ok=it.ok!==false;return h("div",{class:"step "+(ok?"ok":"bad")},[h("span",{class:"s","aria-hidden":"true",text:ok?"✓":"✕"}),h("div",{},[h("span",{text:it.label||"Did something"}),it.text?h("small",{text:it.text}):null])]);}
  var who=it.role==="user"?(it.source==="phone"?"You, from your phone":"You, at the PC"):"BEV";
  var meta=who+" · "+clock(it.at||Date.now())+(it.pending?(it.failed?" · didn't send: "+it.failed:" · sending…"):"");
  var files=Array.isArray(it.files)&&it.files.length?h("div",{class:"files",text:"📎 "+it.files.map(String).join(", ")}):null;
  return h("div",{class:"row "+it.role+(it.pending?" pending":"")},[h("div",{class:"col"},[it.text?h("div",{class:"bubble",text:it.text}):null,files,h("div",{class:"meta",text:meta})])]);
}
function approvalNode(a){
  var expired=a.stage!=="done"&&a.expires&&Date.now()>a.expires;
  if(a.stage==="done"||expired){var out=expired?"Not answered in time, so BEV didn't do it.":a.outcome==="allowed"?"You allowed this.":a.outcome==="expired"?"Not answered in time, so BEV didn't do it.":"You said no, so BEV didn't do it.";
    return h("div",{class:"card done"},[h("h3",{text:"Approval"}),h("p",{text:a.text}),h("div",{class:"meta",text:out})]);}
  if(a.stage==="confirm")return h("div",{class:"card confirm",role:"alertdialog","aria-label":"Confirm"},[h("h3",{text:"Are you sure?"}),h("p",{text:a.text}),
    h("div",{class:"btns"},[h("button",{class:"btn",on:{click:function(){a.stage="ask";render();}}},["Cancel"]),h("button",{class:"btn danger",on:{click:function(){answer(a,true);}}},["Yes, do it"])])]);
  if(a.stage==="sent-allow"||a.stage==="sent-deny")return h("div",{class:"card"},[h("h3",{text:"Approval"}),h("p",{text:a.text}),h("div",{class:"meta",text:a.stage==="sent-allow"?"Allowed. Waiting for BEV…":"Declined. Waiting for BEV…"})]);
  return h("div",{class:"card",role:"alertdialog","aria-label":"BEV needs your OK"},[h("h3",{text:"BEV needs your OK"}),h("p",{text:a.text}),a.err?h("div",{class:"err",text:a.err}):null,
    h("div",{class:"btns"},[h("button",{class:"btn",on:{click:function(){answer(a,false);}}},["Don't"]),h("button",{class:"btn go",on:{click:function(){a.stage="confirm";render();}}},["Allow"])])]);
}
var viewer=document.getElementById("viewer"),viewerImg=viewer.querySelector("img"),viewerZoom=zoomable(viewer.querySelector(".zoom"),viewerImg);
function shotNode(s){var img=h("img",{src:"data:image/jpeg;base64,"+s.data,alt:s.label,loading:"lazy"});img.addEventListener("click",function(){viewerImg.src=img.src;viewerZoom.reset();viewer.classList.add("open");});return h("div",{class:"shot"},[img,h("div",{class:"meta",text:s.label+" · "+clock(s.at)})]);}
viewer.querySelector(".close").addEventListener("click",function(){viewer.classList.remove("open");});
setInterval(function(){if(approvals.size)render();},15000);

function boot(){
  return api("/me").then(function(me){userId=me.user.id;userName=me.user.name;
    return kvGet("user").then(function(u){if(u&&u!==userId){key=null;return kvSet("key",undefined);}return kvGet("key").then(function(k){key=k||null;});}).then(function(){return kvSet("user",userId);});
  }).then(function(){
    if(key)return startMain();
    return api("/vault").then(function(r){gateUnlock(r.vault);},function(e){show([h("div",{class:"gate"},[logo(),h("h1",{text:"Finish setting up in BEV"}),h("p",{text:"Open BEV on your PC and finish setting up your account (choose a passphrase), then come back here."}),h("button",{class:"btn",on:{click:boot}},["Try again"]),h("button",{class:"btn mt",on:{click:signOut}},["Sign out"])])]);});
  }).catch(function(e){if(token)show([h("div",{class:"gate"},[logo(),h("h1",{text:"Can't reach BEV"}),h("p",{text:e.message||"Check your connection."}),h("button",{class:"btn go",on:{click:boot}},["Try again"])])]);});
}

var q=new URLSearchParams(location.search);
if(q.get("code")||q.get("error"))finishSignIn(q);
else if(token)boot();
else gateSignIn();
</script>
</body>
</html>`;

/** Home-screen icons and the web app manifest for the phone page. */
export function phoneAsset(path: string): Response | null {
  const png = (b64: string) =>
    new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  if (path === "/phone/icon-180.png") return png(ICON_180);
  if (path === "/phone/icon-192.png") return png(ICON_192);
  if (path === "/phone/icon-512.png") return png(ICON_512);
  if (path === "/phone/manifest.webmanifest")
    return new Response(
      JSON.stringify({
        name: "BEV",
        short_name: "BEV",
        start_url: "/phone",
        scope: "/phone",
        display: "standalone",
        background_color: "#0b0d10",
        theme_color: "#0b0d10",
        icons: [
          { src: "/phone/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/phone/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      }),
      { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" } },
    );
  return null;
}

export function phonePage(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(HTML.replaceAll("__NONCE__", nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data: 'self'; media-src blob: mediastream:; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
