(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const frame = $("site");
  const state = { current:"", history:[], index:-1, loading:false };

  function normalize(v){
    v=String(v||"").trim();
    if(!v) return "";
    if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v="https://"+v;
    try { const u=new URL(v); return ["http:","https:"].includes(u.protocol) ? u.href : ""; }
    catch { return ""; }
  }
  function pageUrl(url){ return `/api/page/${encodeURIComponent(b64url(url))}`; }
  function b64url(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

  async function checkAuth(){
    try{
      const r=await fetch("/auth/status",{cache:"no-store"}); const j=await r.json();
      $("proxyState").textContent=j.authenticated?"Protected ✓":"Open";
      $("proxyState").classList.toggle("ok",j.authenticated);
      $("login").classList.toggle("hide",j.authenticated);
    }catch(e){$("proxyState").textContent="Auth error";}
  }

  function setTarget(u){
    state.current=u; $("url").value=u;
    $("targetCard").innerHTML=`<div>${escapeHtml(u)}</div><div class="muted">Same-origin API browser</div>`;
  }

  async function navigate(raw,push=true){
    const u=normalize(raw);
    if(!u){alert("Enter a valid http(s) URL.");return;}
    if(state.loading)return;
    state.loading=true; setTarget(u);
    $("loadError").classList.add("hide");
    $("erudaState").textContent="Loading…";
    try{
      const r=await fetch(pageUrl(u),{cache:"no-store",redirect:"follow"});
      if(!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
      const html=await r.text();
      frame.srcdoc=html;
      if(push){
        state.history=state.history.slice(0,state.index+1);
        state.history.push(u); state.index=state.history.length-1;
      }
      $("erudaState").textContent="Eruda 3.4.3";
    }catch(e){
      $("loadError").textContent="Could not load target: "+e.message;
      $("loadError").classList.remove("hide");
      $("erudaState").textContent="Load failed";
    }finally{state.loading=false;}
  }

  $("nav").addEventListener("submit",e=>{e.preventDefault();navigate($("url").value);});
  $("back").onclick=()=>{if(state.index>0){state.index--;navigate(state.history[state.index],false);}};
  $("forward").onclick=()=>{if(state.index+1<state.history.length){state.index++;navigate(state.history[state.index],false);}};
  $("reload").onclick=()=>state.current&&navigate(state.current,false);
  $("newTab").onclick=()=>window.open(state.current||"https://example.com","_blank","noopener,noreferrer");
  $("logout").onclick=async()=>{await fetch("/auth/logout",{method:"POST"});location.reload();};

  $("fab").onclick=()=>{$("drawer").classList.toggle("open");};
  $("closeDrawer").onclick=()=>{$("drawer").classList.remove("open");};
  document.querySelectorAll(".drawer-tabs button").forEach(b=>b.onclick=()=>{
    document.querySelectorAll(".drawer-tabs button").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    b.classList.add("active"); $("tab-"+b.dataset.tab).classList.add("active");
  });

  function message(type,data={}){frame.contentWindow?.postMessage({type,...data},"*");}
  $("devtools").onclick=()=>message("insite:showEruda",{tool:"all"});
  document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=()=>message("insite:showEruda",{tool:b.dataset.tool}));
  $("pick").onclick=()=>message("insite:pick");
  $("dark").onclick=()=>message("insite:dark");
  $("run").onclick=()=>{$("drawer").classList.add("open");document.querySelector('[data-tab="js"]').click();$("code").focus();};
  $("execute").onclick=()=>message("insite:eval",{code:$("code").value});
  $("html").onclick=()=>message("insite:eval",{code:"document.documentElement.outerHTML"});
  $("text").onclick=()=>message("insite:eval",{code:"document.body ? document.body.innerText : ''"});

  window.addEventListener("message",e=>{
    if(e.source!==frame.contentWindow || !e.data || typeof e.data!=="object") return;
    const d=e.data;
    if(d.type==="insite:navigate"&&d.url) navigate(d.url);
    if(d.type==="insite:result") $("result").textContent=d.ok?format(d.value):"ERROR: "+d.error;
    if(d.type==="insite:element"){
      $("drawer").classList.add("open");document.querySelector('[data-tab="element"]').click();
      $("elementOut").innerHTML="<pre>"+escapeHtml(JSON.stringify(d.value,null,2))+"</pre>";
    }
    if(d.type==="insite:status") $("erudaState").textContent=d.text;
  });

  function format(v){if(typeof v==="string")return v;try{return JSON.stringify(v,null,2)}catch{return String(v);}}

  $("loginForm").onsubmit=async e=>{
    e.preventDefault();$("loginError").textContent="";
    const r=await fetch("/auth/login",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({password:$("password").value})});
    if(r.ok){$("login").classList.add("hide");checkAuth();}else $("loginError").textContent="Invalid password.";
  };

  checkAuth();
  navigate("https://example.com");
})();
