(() => {
  const $ = id => document.getElementById(id);
  const frame = $('site');
  let currentTarget = '';
  let history = [];
  let historyIndex = -1;

  async function authCheck() {
    const r = await fetch('/auth/status', { cache:'no-store' });
    const j = await r.json();
    $('proxyState').textContent = j.authenticated ? 'Protected ✓' : 'Locked';
    $('proxyState').classList.toggle('ok', j.authenticated);
    if (!j.authenticated) $('login').classList.remove('hide');
    else $('login').classList.add('hide');
  }
  authCheck();

  function normalize(s){
    s = String(s||'').trim();
    if(!s) return '';
    if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s='https://'+s;
    try { const u=new URL(s); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  }
  function proxied(u){
    const x=new URL(u);
    const key=btoa(x.origin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    return `/p/${key}${x.pathname||'/'}${x.search||''}${x.hash||''}`;
  }
  function navigate(url, push=true){
    const u=normalize(url); if(!u) return alert('Enter a valid http(s) URL.');
    currentTarget=u; $('url').value=u;
    frame.src=proxied(u);
    $('targetCard').innerHTML=`<div>${escapeHtml(u)}</div><div class="muted">Proxied through InSite</div>`;
    if(push){ history=history.slice(0,historyIndex+1); history.push(u); historyIndex=history.length-1; }
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  $('nav').addEventListener('submit', e => { e.preventDefault(); navigate($('url').value); });
  $('reload').onclick=()=>frame.contentWindow.location.reload();
  $('back').onclick=()=>{if(historyIndex>0){historyIndex--;navigate(history[historyIndex],false)}};
  $('forward').onclick=()=>{if(historyIndex<history.length-1){historyIndex++;navigate(history[historyIndex],false)}};
  $('newTab').onclick=()=>window.open(currentTarget||'https://example.com','_blank','noopener,noreferrer');
  $('logout').onclick=async()=>{await fetch('/auth/logout',{method:'POST'});location.reload()};

  frame.addEventListener('load',()=>{
    $('loadError').classList.add('hide');
    try{
      frame.contentWindow.postMessage({type:'insite:hello'}, '*');
      $('erudaState').textContent='Eruda 3.4.3 ✓';
    }catch{}
  });
  frame.addEventListener('error',()=>{ $('loadError').classList.remove('hide'); $('loadError').textContent='The proxied page failed to load.'; });

  $('devtools').onclick=()=>{ try{frame.contentWindow.postMessage({type:'insite:showEruda',tool:'all'},'*')}catch{} };
  $('fab').onclick=()=>$('drawer').classList.toggle('open');
  $('closeDrawer').onclick=()=>$('drawer').classList.remove('open');
  document.querySelectorAll('.drawer-tabs button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.drawer-tabs button').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); $('tab-'+b.dataset.tab).classList.add('active');
  });
  document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{try{frame.contentWindow.postMessage({type:'insite:showEruda',tool:b.dataset.tool},'*')}catch{}});
  $('pick').onclick=()=>{try{frame.contentWindow.postMessage({type:'insite:pick'},'*')}catch{}};
  $('dark').onclick=()=>{try{frame.contentWindow.postMessage({type:'insite:dark'},'*')}catch{}};
  $('run').onclick=()=>{ $('drawer').classList.add('open'); document.querySelector('[data-tab="js"]').click(); $('code').focus(); };
  $('execute').onclick=()=>postRun($('code').value);
  function postRun(code){try{frame.contentWindow.postMessage({type:'insite:eval',code},'*')}catch(e){$('result').textContent='ERROR: '+e}}
  $('html').onclick=()=>postRun('document.documentElement.outerHTML');
  $('text').onclick=()=>postRun('document.body ? document.body.innerText : ""');

  window.addEventListener('message',e=>{
    if(e.source!==frame.contentWindow) return;
    if(!e.data || typeof e.data!=='object') return;
    if(e.data.type==='insite:element'){
      $('drawer').classList.add('open'); document.querySelector('[data-tab="element"]').click();
      $('elementOut').innerHTML=`<pre>${escapeHtml(JSON.stringify(e.data.value,null,2))}</pre>`;
    }
    if(e.data.type==='insite:result') $('result').textContent=e.data.ok ? format(e.data.value) : 'ERROR: '+e.data.error;
    if(e.data.type==='insite:console') $('consoleOut').textContent=e.data.value;
    if(e.data.type==='insite:status') $('erudaState').textContent=e.data.text;
  });
  function format(v){ if(typeof v==='string')return v; try{return JSON.stringify(v,null,2)}catch{return String(v)} }

  $('loginForm').onsubmit=async e=>{
    e.preventDefault(); $('loginError').textContent='';
    const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:$('password').value})});
    if(r.ok){$('login').classList.add('hide');authCheck()}else $('loginError').textContent='Invalid password.';
  };

  navigate('https://example.com');
})();
