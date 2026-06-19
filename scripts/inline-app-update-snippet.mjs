/** bump-app-version.mjs 가 HTML <head> 에 삽입하는 인라인 스니펫 (모듈 로드 전 실행) */

export const CRITICAL_SHELL_STYLE_TAG = `<style id="han-pit-critical-shell">html{color-scheme:dark;background:#060c17}body{margin:0;min-height:100%;background:#060c17;color:#eef2ff}.page-boot-loading{display:none!important}.layout-canvas-viewport,.canvas.pc-canvas{background:#0a1022}</style>`;

export const BOOT_DISMISS_MARKER = "<!-- han-pit-boot-dismiss -->";

/** 모듈 로드 전 HTML 인라인 스피너 제거 */
export function buildBootDismissSnippet() {
  return `${BOOT_DISMISS_MARKER}
<script id="han-pit-boot-dismiss">
(function(){
  function dismiss(){
    var list=document.querySelectorAll(".page-boot-loading");
    for(var i=0;i<list.length;i++)list[i].remove();
    ["indexRoot","eventList","app"].forEach(function(id){
      var el=document.getElementById(id);
      if(el)el.dataset.pageBootLoaded="1";
    });
  }
  dismiss();
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",dismiss,{once:true});
  }
})();
</script>
<!-- /han-pit-boot-dismiss -->`;
}

export const APP_ASSET_FIX_MARKER = "<!-- han-pit-asset-fix -->";

export function buildAppAssetInlineFixSnippet() {
  return `<script id="han-pit-asset-fix">
(function(){
  function appBase(){
    var p=location.pathname||"/";
    var i=p.lastIndexOf("/");
    return i<0?"/":p.slice(0,i+1);
  }
  function appUrl(rel){
    rel=String(rel||"").replace(/^\\.\\//,"");
    return location.origin+appBase()+rel;
  }
  function applyMarks(){
    var meta=document.querySelector('meta[name="han-pit-build"]');
    var tag=meta?String(meta.getAttribute("content")||"").trim():"";
    var q=tag?"?v="+encodeURIComponent(tag):"";
    var url=appUrl("icons/han-pit-wordmark.png")+q;
    document.querySelectorAll("img.app-mark-img").forEach(function(img){
      if(img.getAttribute("src")!==url)img.setAttribute("src",url);
    });
  }
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",applyMarks);
  }else{
    applyMarks();
  }
})();
</script>`;
}

export function buildInlineAppUpdateSnippet(v) {
  return `<script id="han-pit-inline-update">
(function(){
  try{
    document.documentElement.style.backgroundColor="#060c17";
    document.documentElement.style.colorScheme="dark";
  }catch(e){}
  var BUILD="${v}";
  var KEY="hanPitAppVersion";
  var meta=document.querySelector('meta[name="han-pit-build"]');
  var pageBuild=meta?String(meta.getAttribute("content")||"").trim():"";
  var loc=new URL(location.href);
  var bust=loc.searchParams.get("_hanpit_v")||"";

  function appBase(){
    var p=location.pathname||"/";
    var i=p.lastIndexOf("/");
    return i<0?"/":p.slice(0,i+1);
  }
  function appUrl(rel){
    rel=String(rel||"").replace(/^\\.\\//,"");
    return location.origin+appBase()+rel;
  }

  function isLegacyShell(){
    var onIndex=document.getElementById("indexRoot")||document.getElementById("dealerOpsMount");
    return !!onIndex&&!document.getElementById("workSummaryModal");
  }

  function persist(v){
    try{localStorage.setItem(KEY,v);}catch(e){}
  }

  function reload(v){
    var tag=v||String(Date.now());
    if(loc.searchParams.get("_hanpit_v")===tag&&pageBuild&&pageBuild===tag)return;
    var n=0;
    try{n=Number(sessionStorage.getItem("hanPitReloadAttempt:"+tag)||0);}catch(e){}
    var cap=isLegacyShell()||!pageBuild?12:4;
    if(n>=cap)return;
    try{sessionStorage.setItem("hanPitReloadAttempt:"+tag,String(n+1));}catch(e){}
    if(v)persist(v);
    loc.searchParams.set("_hanpit_v",tag);
    location.replace(loc.toString());
  }

  function isPlaceholderBust(v){
    v=String(v||"").trim();
    return !v||v==="boot"||v==="net";
  }

  function syncBustInPlace(remote){
    if(!remote||!pageBuild||pageBuild!==remote)return;
    if(!isPlaceholderBust(bust)&&bust===remote)return;
    persist(remote);
    loc.searchParams.set("_hanpit_v",remote);
    try{history.replaceState(null,"",loc.toString());}catch(e){}
  }

  function needsReload(remote){
    if(isLegacyShell())return true;
    if(!pageBuild)return true;
    if(!remote)return false;
    if(pageBuild===remote)return false;
    if(bust===remote&&pageBuild===remote)return false;
    return true;
  }

  function swScope(){
    var b=appBase();
    return b.endsWith("/")?b:b+"/";
  }

  function runVersionCheck(){
    fetch("./app-version.json?t="+Date.now(),{cache:"no-store",credentials:"same-origin"})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        var remote=String((d&&(d.v||d.version))||"").trim();
        if(needsReload(remote))reload(remote);
        else syncBustInPlace(remote);
      })
      .catch(function(){
        if(isLegacyShell()||!pageBuild)reload("net");
      });
  }

  if(!pageBuild&&!bust){
    reload("boot");
    return;
  }

  if(pageBuild&&bust===pageBuild){
    try{
      if(localStorage.getItem(KEY)===pageBuild){
        setTimeout(runVersionCheck,15000);
      }else{
        runVersionCheck();
      }
    }catch(e){
      runVersionCheck();
    }
  }else{
    runVersionCheck();
  }

  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./firebase-messaging-sw.js",{scope:swScope()})
      .then(function(reg){
        setTimeout(function(){
          try{reg.update();}catch(e){}
        },8000);
      })
      .catch(function(){});
    navigator.serviceWorker.addEventListener("message",function(ev){
      var d=ev&&ev.data;
      if(d&&d.type==="HAN_PIT_FORCE_RELOAD")reload(String(d.v||"").trim());
    });
  }
})();
</script>`;
}
