/** bump-app-version.mjs 가 HTML <head> 에 삽입하는 인라인 스니펫 (모듈 로드 전 실행) */
export function buildInlineAppUpdateSnippet(v) {
  return `<script id="han-pit-inline-update">
(function(){
  var BUILD="${v}";
  var KEY="hanPitAppVersion";
  var meta=document.querySelector('meta[name="han-pit-build"]');
  var pageBuild=meta?String(meta.getAttribute("content")||"").trim():"";
  var loc=new URL(location.href);
  var bust=loc.searchParams.get("_hanpit_v")||"";

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

  function needsReload(remote){
    if(isLegacyShell())return true;
    if(!pageBuild)return true;
    if(!remote)return false;
    if(bust===remote&&pageBuild===remote)return false;
    var stored="";
    try{stored=String(localStorage.getItem(KEY)||"").trim();}catch(e){}
    if(pageBuild!==remote)return true;
    if(stored!==remote)return true;
    if(!stored)return true;
    if(bust&&bust!==remote)return true;
    return false;
  }

  if(!pageBuild&&!bust){
    reload("boot");
    return;
  }

  fetch("./app-version.json?t="+Date.now(),{cache:"no-store",credentials:"same-origin"})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      var remote=String((d&&(d.v||d.version))||"").trim();
      if(needsReload(remote))reload(remote);
    })
    .catch(function(){
      if(isLegacyShell()||!pageBuild)reload("net");
    });

  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./firebase-messaging-sw.js",{scope:"./"})
      .then(function(reg){return reg.update();})
      .catch(function(){});
    navigator.serviceWorker.addEventListener("message",function(ev){
      var d=ev&&ev.data;
      if(d&&d.type==="HAN_PIT_FORCE_RELOAD")reload(String(d.v||"").trim());
    });
  }
})();
</script>`;
}
