(() => {
  "use strict";
  const state={picking:false,hover:null,oldOutline:"",dark:false};
  const send=(type,value={})=>{try{parent.postMessage({type,...value},"*")}catch{}};

  function describe(el){
    const cs=getComputedStyle(el), r=el.getBoundingClientRect();
    return {
      tag:el.tagName,id:el.id||"",class:typeof el.className==="string"?el.className:"",
      role:el.getAttribute("role")||"",text:(el.textContent||"").trim().slice(0,500),
      box:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},
      styles:{display:cs.display,position:cs.position,color:cs.color,backgroundColor:cs.backgroundColor,font:cs.font,margin:cs.margin,padding:cs.padding}
    };
  }
  function stop(){state.picking=false;if(state.hover){state.hover.style.outline=state.oldOutline;state.hover=null;}document.removeEventListener("mousemove",move,true);document.removeEventListener("click",pickClick,true);}
  function move(e){
    if(!state.picking)return;
    if(state.hover){state.hover.style.outline=state.oldOutline;}
    state.hover=e.target;state.oldOutline=state.hover.style.outline;state.hover.style.outline="2px solid #60a5fa";
  }
  function pickClick(e){
    if(!state.picking)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    const el=e.target;const value=describe(el);stop();send("insite:element",{value});
  }
  function pick(){
    if(state.picking)return;
    state.picking=true;document.addEventListener("mousemove",move,true);document.addEventListener("click",pickClick,true);
  }
  function toggleDark(){
    let s=document.getElementById("__insite_dark__");
    if(!s){s=document.createElement("style");s.id="__insite_dark__";document.documentElement.appendChild(s);}
    state.dark=!state.dark;
    s.textContent=state.dark
      ?"html{background:#111!important;filter:invert(.92) hue-rotate(180deg)!important}img,video,canvas,iframe{filter:invert(1) hue-rotate(180deg)!important}"
      :"";
  }
  function absolute(href){try{return new URL(href,location.href).href}catch{return ""}}

  // Keep normal hyperlinks inside the InSite shell.
  document.addEventListener("click",e=>{
    if(e.defaultPrevented||e.button!==0)return;
    const a=e.target.closest?.("a[href]"); if(!a)return;
    if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    const u=absolute(a.getAttribute("href")); if(!/^https?:/i.test(u))return;
    e.preventDefault();e.stopPropagation();send("insite:navigate",{url:u});
  },true);

  // Handle GET/POST forms by sending the resulting destination to the shell.
  document.addEventListener("submit",e=>{
    const f=e.target;if(!(f instanceof HTMLFormElement))return;
    const method=(f.method||"get").toLowerCase();const u=absolute(f.getAttribute("action")||location.href);
    if(!/^https?:/i.test(u))return;
    e.preventDefault();
    if(method==="get"){
      const q=new URLSearchParams(new FormData(f));
      const dest=new URL(u);for(const [k,v] of q)dest.searchParams.append(k,String(v));
      send("insite:navigate",{url:dest.href});
    }else{
      // POST bodies need a server API to be fully preserved. Preserve the destination and
      // let the shell navigate via GET rather than silently escaping the proxy.
      send("insite:navigate",{url:u});
    }
  },true);

  window.addEventListener("message",async e=>{
    const d=e.data;if(!d||typeof d!=="object")return;
    if(d.type==="insite:showEruda"&&window.eruda){try{window.eruda.show(d.tool||"all")}catch{window.eruda.show();}}
    if(d.type==="insite:pick")pick();
    if(d.type==="insite:dark")toggleDark();
    if(d.type==="insite:eval"){
      try{
        const value=await (new Function("return (async()=>("+d.code+"))()"))();
        let safe;try{safe=JSON.parse(JSON.stringify(value));}catch{safe=String(value);}
        send("insite:result",{ok:true,value:safe});
      }catch(err){send("insite:result",{ok:false,error:err?.stack||String(err)});}
    }
  });

  send("insite:status",{text:"Connected ✓"});
})();
