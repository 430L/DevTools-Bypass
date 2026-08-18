(() => {
  'use strict';
  const state = { picking:false, dark:false, hover:null };
  const send=(type, value={})=>{try{parent.postMessage({type,...value},'*')}catch{}};
  function describe(el){
    const cs=getComputedStyle(el), r=el.getBoundingClientRect();
    return {tag:el.tagName,id:el.id||'',class:typeof el.className==='string'?el.className:'',role:el.getAttribute('role')||'',text:(el.textContent||'').trim().slice(0,500),box:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},styles:{display:cs.display,position:cs.position,color:cs.color,backgroundColor:cs.backgroundColor,font:cs.font,margin:cs.margin,padding:cs.padding}};
  }
  function clear(){if(state.hover){state.hover.style.outline=state.old||'';state.hover=null}}
  function move(e){clear();state.hover=e.target;state.old=state.hover.style.outline;state.hover.style.outline='2px solid #60a5fa'}
  function click(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();const el=e.target;stop();send('insite:element',{value:describe(el)});}
  function start(){if(state.picking)return;state.picking=true;document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true)}
  function stop(){state.picking=false;clear();document.removeEventListener('mousemove',move,true);document.removeEventListener('click',click,true)}
  function dark(){
    let s=document.getElementById('__insite_dark__'); if(!s){s=document.createElement('style');s.id='__insite_dark__';document.documentElement.appendChild(s)}
    state.dark=!state.dark; s.textContent=state.dark?'html{background:#111!important;filter:invert(.92) hue-rotate(180deg)!important}img,video,canvas,iframe{filter:invert(1) hue-rotate(180deg)!important}':'';
  }
  function safe(v){try{JSON.parse(JSON.stringify(v));return v}catch{return String(v)}}
  window.addEventListener('message',e=>{
    const d=e.data; if(!d||typeof d!=='object')return;
    if(d.type==='insite:hello')send('insite:status',{text:'Connected ✓'});
    if(d.type==='insite:showEruda'&&window.eruda){try{window.eruda.show(d.tool||'all')}catch{window.eruda.show()}}
    if(d.type==='insite:pick')start();
    if(d.type==='insite:dark')dark();
    if(d.type==='insite:eval'){
      try{let result=(new Function('return (async()=>('+d.code+'))()'))();Promise.resolve(result).then(v=>send('insite:result',{ok:true,value:safe(v)}),e=>send('insite:result',{ok:false,error:String(e)}))}
      catch(e){send('insite:result',{ok:false,error:String(e)})}
    }
  });
  // Keep the DevTools entry button present in the target page as a fallback even if the shell drawer is hidden.
  if(window.eruda&&!window.eruda._isInit){try{window.eruda.init({tool:'all',useShadowDom:true,autoScale:true})}catch(e){console.error(e)}}
})();
