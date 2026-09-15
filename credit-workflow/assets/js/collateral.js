/* ══════════════════════════════════════════════════════════════
   collateral.js — 연대보증 심사 (담보가치 평가)

   등기부등본 PDF 를 streamlit-app 백엔드에 올려 물건지별 선순위·
   실거래가·담보가치를 받아 표로 보여준다. 계산은 전부 백엔드 몫이고
   이 파일은 표시만 한다.

   원래 remicon 워크플로의 STEP 01 이었다. 타설계획·현장 현황이
   각자 독립 화면으로 갈라지면서 이 페이지에는 이것만 남았다.
   ══════════════════════════════════════════════════════════════ */
(function(){
const {$, el, esc, fmtInt: W, fmtEok: formatEok, parseNum: num, setStatus, storage} = App;
const setSt=(id,state,txt)=>setStatus(id,state,txt);

/* ── 백엔드 주소 ──────────────────────────────────────────────
   기본값은 streamlit-app/api_server.py 를 로컬 uvicorn 으로 띄운 주소.
   ?api=https://... 로 덮어쓸 수 있고, 한 번 주면 이 브라우저에 기억한다.
   배포본에서 원격 백엔드를 쓰려면 이 방법으로 지정한다. */
const API_KEY='yeosin.apiBase';
const API_DEFAULT='http://localhost:8000';
function resolveApiBase(){
  const q=new URLSearchParams(location.search).get('api');
  if(q!==null){
    /* ?api= (빈 값) 은 덮어쓰기 해제 */
    try{ q ? localStorage.setItem(API_KEY,q) : localStorage.removeItem(API_KEY); }catch(e){}
    if(q) return q.replace(/\/+$/,'');
    return API_DEFAULT;
  }
  try{ const saved=localStorage.getItem(API_KEY); if(saved) return saved.replace(/\/+$/,''); }catch(e){}
  return API_DEFAULT;
}
const API_BASE=resolveApiBase();

/* HTTPS 로 열린 페이지에서 http:// 백엔드를 부르면 브라우저가 요청 자체를 막는다
   (혼합 콘텐츠). 배포본 + 로컬 백엔드 조합이 정확히 여기 걸린다.
   보내봐야 "Failed to fetch" 밖에 안 나오므로, 쏘기 전에 미리 판단한다. */
function mixedContentBlocked(){
  return location.protocol==='https:' && /^http:\/\//i.test(API_BASE);
}
function flag(html){ $('collateral_flag').innerHTML=html; }

let COLLATERAL_RESULT=null;

(function(){
  const drop=$('collateralDrop'), input=$('f_collateral_pdf'), hint=$('f_collateral_pdf_got');
  if(!drop||!input)return;
  const DEFAULT_HINT='클릭해서 파일을 고를 수도 있습니다';
  function show(f){ hint.textContent=f?(f.name+' · '+Math.round(f.size/1024)+' KB'):DEFAULT_HINT; }
  function setFile(f){
    if(!f)return;
    const dt=new DataTransfer(); dt.items.add(f);
    input.files=dt.files;
    show(f);
  }
  input.addEventListener('change',e=>show(e.target.files&&e.target.files[0]));
  drop.addEventListener('click',()=>input.click());
  drop.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); input.click(); } });
  ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{ e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{ e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop',e=>{
    const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(f)setFile(f);
  });
})();

function fmtTradeDate(y,m,d){
  if(y&&m&&d)return y+'.'+String(m).padStart(2,'0')+'.'+String(d).padStart(2,'0');
  return '—';
}

function hgnnTradeRows(trades){
  return (trades||[]).slice(0,5).map(t=>{
    const dm=String(t.date||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return '<tr>'+
      '<td>'+(dm?fmtTradeDate(dm[1],dm[2],dm[3]):'—')+'</td>'+
      '<td class="num">'+(t.floor!=null?t.floor+'층':'—')+'</td>'+
      '<td class="num">'+(t.price!=null?W(Math.round(t.price*10000)):'—')+'</td>'+
      '</tr>';
  }).join('');
}

function molitTradeRows(trades){
  return (trades||[]).slice(0,5).map(t=>{
    const amt=parseInt(String(t.dealAmount||'').replace(/,/g,''),10);
    return '<tr>'+
      '<td>'+fmtTradeDate(t.dealYear,t.dealMonth,t.dealDay)+'</td>'+
      '<td class="num">'+(t.floor!=null?t.floor+'층':'—')+'</td>'+
      '<td class="num">'+(t.excluUseAr?Number(t.excluUseAr).toFixed(1)+'㎡':'—')+'</td>'+
      '<td class="num">'+(!isNaN(amt)?W(amt*10000):'—')+'</td>'+
      '</tr>';
  }).join('');
}

function renderTradeDetail(p){
  const hgnnRows=hgnnTradeRows(p.recent_trades);
  const molitRows=molitTradeRows(p.molit_trades);
  return '<div class="trade-detail">'+
    '<div class="trade-detail__head"><span class="eyebrow eyebrow--sm">국토부 실거래가 (최근 3개월)</span>'+(p.molit_price!=null?'평균 '+W(p.molit_price)+' · '+(p.molit_trade_count||0)+'건':'거래 없음')+'</div>'+
    (molitRows?'<table class="table table--mini"><thead><tr><th>거래일</th><th class="num">층</th><th class="num">전용면적</th><th class="num">금액</th></tr></thead><tbody>'+molitRows+'</tbody></table>':'<div class="muted">최근 거래 내역 없음</div>')+
    '<div class="trade-detail__head"><span class="eyebrow eyebrow--sm">호갱노노 최근 실거래</span>'+(p.hogangnono_price!=null?'평균 '+W(p.hogangnono_price):'거래 없음')+'</div>'+
    (hgnnRows?'<table class="table table--mini"><thead><tr><th>거래일</th><th class="num">층</th><th class="num">금액</th></tr></thead><tbody>'+hgnnRows+'</tbody></table>':'<div class="muted">최근 거래 내역 없음</div>')+
    '</div>';
}

function renderCollateralResult(data){
  const tbody=$('collateral_tbl').querySelector('tbody');
  tbody.innerHTML='';
  (data.properties||[]).forEach(p=>{
    const tr=document.createElement('tr');
    const rateTxt=p.hammer_rate!=null?Math.round(p.hammer_rate*100)+'%'+(p.matched_rate_region?' · '+p.matched_rate_region:''):'—';
    tr.innerHTML=
      '<td>'+esc(p.address||'주소 미상')+(p.error?'<div class="muted">'+esc(p.error)+'</div>':'')+'</td>'+
      '<td class="num">'+(p.total_priority_amount!=null?W(p.total_priority_amount):'—')+'</td>'+
      '<td class="num">'+(p.market_price!=null?W(p.market_price):'—')+'</td>'+
      '<td class="num">'+rateTxt+'</td>'+
      '<td class="num">'+(p.collateral_value!=null?W(p.collateral_value):'—')+'</td>';
    tbody.appendChild(tr);

    const dtr=document.createElement('tr');
    const dtd=document.createElement('td');
    dtd.colSpan=5;
    dtd.innerHTML=renderTradeDetail(p);
    dtr.appendChild(dtd);
    tbody.appendChild(dtr);
  });
  $('o_collateral_total').textContent=data.grand_total_collateral!=null?W(data.grand_total_collateral):'—';
}

async function evaluateCollateral(){
  const f=$('f_collateral_pdf').files&&$('f_collateral_pdf').files[0];
  if(!f){setSt('st_collateral','off','PDF를 업로드하십시오');return}

  if(mixedContentBlocked()){
    setSt('st_collateral','off','배포본에서는 로컬 백엔드를 부를 수 없음');
    flag('<div class="callout callout--warn">'+
      '<b>이 화면은 배포본에서 동작하지 않습니다.</b><br>'+
      '지금 페이지는 <span class="mono">https</span> 로 열려 있는데 백엔드 주소가 '+
      '<span class="mono">'+esc(API_BASE)+'</span> 라서, 브라우저가 요청을 차단합니다.<br><br>'+
      '<b>해결 방법</b><br>'+
      '· 로컬에서 쓰기 — 저장소를 받아 <span class="mono">credit-workflow/index.html</span> 을 직접 열고 백엔드를 띄웁니다.<br>'+
      '· 원격 백엔드 쓰기 — <span class="mono">https</span> 로 서비스되는 주소가 있다면 '+
      '<span class="mono">?api=https://주소</span> 를 URL 뒤에 붙이면 그 주소로 호출합니다.'+
      '</div>');
    return;
  }

  setSt('st_collateral','run','평가 중… (물건지 감지 · 실거래가 조회)');
  $('btn_collateral_report').disabled=true;
  $('collateral_flag').innerHTML='';

  const fd=new FormData();
  fd.append('pdf',f);
  fd.append('hammer_rate',(Number($('i_collateral_rate').value)||80)/100);

  try{
    const res=await fetch(API_BASE+'/api/collateral/evaluate',{method:'POST',body:fd});
    if(!res.ok)throw new Error(await res.text());
    const data=await res.json();
    COLLATERAL_RESULT=data;
    renderCollateralResult(data);
    setSt('st_collateral','on','평가 완료 · 물건지 '+(data.properties||[]).length+'개');
    $('btn_collateral_report').disabled=false;
  }catch(err){
    setSt('st_collateral','off','평가 실패');
    /* fetch 가 TypeError 로 떨어지면 서버에 닿지도 못한 것이다(미기동·CORS·네트워크).
       서버가 응답은 했는데 실패한 경우와 구분해서 안내한다. */
    const unreachable = err instanceof TypeError;
    if(unreachable){
      const isLocal=/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(API_BASE);
      flag('<div class="callout callout--warn">'+
        '<b>백엔드에 연결하지 못했습니다.</b> '+
        '<span class="mono">'+esc(API_BASE)+'</span> 가 응답하지 않습니다.<br><br>'+
        (isLocal
          ? '<b>백엔드 실행</b><br>'+
            '<span class="mono">cd streamlit-app</span><br>'+
            '<span class="mono">uvicorn api_server:app --port 8000</span><br><br>'+
            '띄운 뒤 «담보가치 평가 실행» 을 다시 누르십시오.'
          : '주소가 맞는지, 그리고 그 서버가 이 페이지의 요청을 허용(CORS)하는지 확인하십시오.<br>'+
            'URL 뒤에 <span class="mono">?api=</span> 만 붙이면 기본값 '+
            '<span class="mono">'+esc(API_DEFAULT)+'</span> 로 되돌립니다.')+
        '</div>');
    }else{
      flag('<div class="callout callout--crit"><b>담보가치 평가 실패.</b> '+
        esc(err&&err.message?err.message:'알 수 없는 오류')+'</div>');
    }
  }
}

async function downloadCollateralReport(){
  if(!COLLATERAL_RESULT)return;
  try{
    const res=await fetch(API_BASE+'/api/collateral/report',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(COLLATERAL_RESULT)
    });
    if(!res.ok)throw new Error(await res.text());
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='담보가치_리포트.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }catch(err){
    flag('<div class="callout callout--warn"><b>리포트 생성 실패.</b> '+
      esc(err&&err.message?err.message:'')+'</div>');
  }
}

if($('btn_collateral_eval'))$('btn_collateral_eval').addEventListener('click',evaluateCollateral);
if($('btn_collateral_report'))$('btn_collateral_report').addEventListener('click',downloadCollateralReport);
})();
