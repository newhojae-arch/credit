/* ══════════════════════════════════════════════════════════════
   collateral.js — 담보가치 평가 화면 (UI)

   계산은 collateral-core.js 가 한다. 이 파일은 화면만 담당한다:
   API 키 입력·보관, 진행 로그, 결과 표 렌더, 리포트 인쇄.

   백엔드가 없다. Gemini · 국토부 · 호갱노노를 브라우저에서 직접 부른다.
   그래서 배포본(HTTPS)에서도 그대로 동작한다.

   API 키는 사용자가 넣고 이 브라우저(localStorage)에만 남는다.
   저장소에 키를 넣지 않는다 — 공개 정적 호스팅이라 넣으면 그대로 유출된다.
   ══════════════════════════════════════════════════════════════ */
(function(){
const {$, esc, fmtInt: W, setStatus, storage} = App;
const setSt = (id, state, txt) => setStatus(id, state, txt);

const KEY_STORE = 'yeosin.apiKeys';
let RESULT = null;

/* ───────────────── API 키 ───────────────── */

function loadKeys(){ return storage.get(KEY_STORE, {}) || {}; }
function saveKeys(k){ storage.set(KEY_STORE, k); }

function syncKeyFields(){
  const k = loadKeys();
  if ($('i_gemini_key')) $('i_gemini_key').value = k.gemini || '';
  if ($('i_molit_key'))  $('i_molit_key').value  = k.molit  || '';
  setModelOptions(k.models, k.model);
  updateKeyStatus();
}

/* ── 모델 드롭다운 ──
   목록은 Gemini API 에서 직접 받아온다(코드에 모델 ID 를 박아두면 새 모델이
   나올 때마다 어긋난다). 아직 못 받았으면 폴백 하나만 보여준다. */
function setModelOptions(models, selected){
  const sel = $('i_gemini_model');
  if (!sel) return;
  const C = window.CollateralCore;
  const list = (models && models.length) ? models : [{id: C.FALLBACK_MODEL, label: C.FALLBACK_MODEL}];
  /* 저장된 선택이 목록에 없으면(모델이 없어졌거나 목록을 못 받았으면) 맨 위 = 최신 */
  const pick = (selected && list.some(m => m.id === selected)) ? selected : list[0].id;

  sel.innerHTML = '';
  list.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.id + (i === 0 ? '  (최신)' : '');
    if (m.id === pick) opt.selected = true;
    sel.appendChild(opt);
  });
  C.setModel(pick);
}

/* 저장된 키로 모델 목록을 받아 드롭다운을 채운다 */
async function reloadModels(quiet){
  const k = loadKeys();
  if (!k.gemini){
    if (!quiet) flag('<div class="callout callout--warn">Gemini API 키를 먼저 저장하십시오.</div>');
    return;
  }
  setSt('st_keys','run','모델 목록 불러오는 중…');
  try{
    const models = await window.CollateralCore.listModels(k.gemini);
    if (!models.length) throw new Error('사용 가능한 모델이 없습니다');
    /* 목록이 바뀌었으니 저장된 선택이 여전히 유효한지 setModelOptions 가 판단한다 */
    saveKeys(Object.assign({}, k, {models: models}));
    setModelOptions(models, k.model);
    updateKeyStatus();
    if (!quiet)
      flag('<div class="callout">모델 ' + models.length + '개를 불러왔습니다. ' +
           '최신 모델 <span class="mono">' + esc($('i_gemini_model').value) + '</span> 으로 맞췄습니다.</div>');
  }catch(e){
    updateKeyStatus();
    if (!quiet)
      flag('<div class="callout callout--warn"><b>모델 목록을 불러오지 못했습니다.</b> ' +
           esc(e.message) + '<br>Gemini 키가 올바른지 확인하십시오.</div>');
  }
}
function updateKeyStatus(){
  const k = loadKeys();
  const node = $('st_keys');
  if (!node) return;
  if (k.gemini) setSt('st_keys', 'on', k.molit ? '키 저장됨 (Gemini · 국토부)' : '키 저장됨 (Gemini)');
  else setSt('st_keys', 'off', 'Gemini 키 필요');
}

/* ───────────────── 진행 로그 ───────────────── */

function clearLog(){
  const box = $('collateral_log');
  if (box){ box.textContent = ''; box.hidden = true; }
}
function logLine(msg){
  const box = $('collateral_log');
  if (!box) return;
  box.hidden = false;
  box.textContent += (box.textContent ? '\n' : '') + msg;
  box.scrollTop = box.scrollHeight;   /* 항상 최신 줄이 보이게 */
}
function flag(html){ $('collateral_flag').innerHTML = html; }

/* ───────────────── 결과 렌더 ───────────────── */

function fmtTradeDate(y, m, d){
  if (y && m && d) return y + '.' + String(m).padStart(2,'0') + '.' + String(d).padStart(2,'0');
  return '—';
}
function hgnnTradeRows(trades){
  return (trades || []).slice(0,5).map(t => {
    const dm = String(t.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return '<tr>' +
      '<td>' + (dm ? fmtTradeDate(dm[1],dm[2],dm[3]) : '—') + '</td>' +
      '<td class="num">' + (t.floor != null ? t.floor + '층' : '—') + '</td>' +
      '<td class="num">' + (t.price != null ? W(Math.round(t.price*10000)) : '—') + '</td>' +
      '</tr>';
  }).join('');
}
function molitTradeRows(trades){
  return (trades || []).slice(0,5).map(t => {
    const amt = parseInt(String(t.dealAmount || '').replace(/,/g,''), 10);
    return '<tr>' +
      '<td>' + fmtTradeDate(t.dealYear, t.dealMonth, t.dealDay) + '</td>' +
      '<td class="num">' + (t.floor != null ? t.floor + '층' : '—') + '</td>' +
      '<td class="num">' + (t.excluUseAr ? Number(t.excluUseAr).toFixed(1) + '㎡' : '—') + '</td>' +
      '<td class="num">' + (!isNaN(amt) ? W(amt*10000) : '—') + '</td>' +
      '</tr>';
  }).join('');
}
function renderTradeDetail(p){
  const hgnnRows = hgnnTradeRows(p.recent_trades);
  const molitRows = molitTradeRows(p.molit_trades);
  return '<div class="trade-detail">' +
    '<div class="trade-detail__head"><span class="eyebrow eyebrow--sm">국토부 실거래가 (최근 3개월)</span>' +
      (p.molit_price != null ? '평균 ' + W(p.molit_price) + ' · ' + (p.molit_trade_count||0) + '건' : '거래 없음') + '</div>' +
    (molitRows
      ? '<table class="table table--mini"><thead><tr><th>거래일</th><th class="num">층</th><th class="num">전용면적</th><th class="num">금액</th></tr></thead><tbody>' + molitRows + '</tbody></table>'
      : '<div class="muted">최근 거래 내역 없음</div>') +
    '<div class="trade-detail__head"><span class="eyebrow eyebrow--sm">호갱노노 최근 실거래</span>' +
      (p.hogangnono_price != null ? '평균 ' + W(p.hogangnono_price) : '거래 없음') + '</div>' +
    (hgnnRows
      ? '<table class="table table--mini"><thead><tr><th>거래일</th><th class="num">층</th><th class="num">금액</th></tr></thead><tbody>' + hgnnRows + '</tbody></table>'
      : '<div class="muted">최근 거래 내역 없음</div>') +
    '</div>';
}

function renderCollateralResult(data){
  const tbody = $('collateral_tbl').querySelector('tbody');
  tbody.innerHTML = '';
  (data.properties || []).forEach(p => {
    const tr = document.createElement('tr');
    /* 어떤 근거로 이 요율이 나왔는지 드러낸다 — 지역·관할법원·물건유형 */
    const rateTxt = p.hammer_rate != null
      ? Math.round(p.hammer_rate*100) + '%' +
        (p.matched_rate_region
          ? '<div class="muted">' + esc(p.matched_rate_region) +
            (p.matched_rate_court ? ' · ' + esc(p.matched_rate_court) : '') +
            (p.property_type ? ' · ' + esc(p.property_type) : '') + '</div>'
          : '<div class="muted">기준표 미매칭 · 기본값</div>')
      : '—';
    tr.innerHTML =
      '<td>' + esc(p.address || '주소 미상') + (p.error ? '<div class="muted">' + esc(p.error) + '</div>' : '') + '</td>' +
      '<td class="num">' + (p.total_priority_amount != null ? W(p.total_priority_amount) : '—') + '</td>' +
      '<td class="num">' + (p.market_price != null ? W(p.market_price) : '—') + '</td>' +
      '<td class="num">' + rateTxt + '</td>' +
      '<td class="num">' + (p.collateral_value != null ? W(p.collateral_value) : '—') + '</td>';
    tbody.appendChild(tr);

    const dtr = document.createElement('tr');
    const dtd = document.createElement('td');
    dtd.colSpan = 5;
    dtd.innerHTML = renderTradeDetail(p);
    dtr.appendChild(dtd);
    tbody.appendChild(dtr);
  });
  $('o_collateral_total').textContent =
    data.grand_total_collateral != null ? W(data.grand_total_collateral) : '—';
}

/* ───────────────── 업로드(드롭존) ───────────────── */

(function(){
  const drop = $('collateralDrop'), input = $('f_collateral_pdf'), hint = $('f_collateral_pdf_got');
  if (!drop || !input) return;
  const DEFAULT_HINT = '클릭해서 파일을 고를 수도 있습니다';
  const show = f => { hint.textContent = f ? (f.name + ' · ' + Math.round(f.size/1024) + ' KB') : DEFAULT_HINT; };
  function setFile(f){
    if (!f) return;
    const dt = new DataTransfer(); dt.items.add(f);
    input.files = dt.files;
    show(f);
  }
  input.addEventListener('change', e => show(e.target.files && e.target.files[0]));
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); input.click(); } });
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
})();

/* ───────────────── 평가 실행 ───────────────── */

async function evaluateCollateral(){
  const f = $('f_collateral_pdf').files && $('f_collateral_pdf').files[0];
  if (!f){ setSt('st_collateral','off','등기부등본 PDF를 올리십시오'); return; }

  const keys = loadKeys();
  if (!keys.gemini){
    setSt('st_collateral','off','Gemini API 키가 필요합니다');
    flag('<div class="callout callout--warn">' +
      '<b>Gemini API 키를 먼저 입력하십시오.</b><br>' +
      '등기부등본을 읽는 데 Gemini 를 씁니다. 위 «API 키» 칸에 넣으면 이 브라우저에만 저장됩니다.<br>' +
      '키 발급: <span class="mono">aistudio.google.com/apikey</span>' +
      '</div>');
    return;
  }

  $('btn_collateral_eval').disabled = true;
  $('btn_collateral_report').disabled = true;
  flag('');
  clearLog();
  setSt('st_collateral','run','분석 중…');

  const started = Date.now();
  try{
    logLine('[준비] pdf.js 로드');
    await App.ensurePdfjs();
    const buf = await f.arrayBuffer();
    const doc = await pdfjsLib.getDocument({data: new Uint8Array(buf), isEvalSupported:false}).promise;
    logLine('[준비] PDF ' + doc.numPages + '페이지');

    logLine('[준비] Gemini 모델: ' + window.CollateralCore.getModel());
    const rates = window.HAMMER_RATES || null;
    const rateTable = rates ? rates.entries : null;
    const propertyType = $('i_property_type') ? $('i_property_type').value : '아파트';
    if (rateTable) logLine('[준비] 낙찰가율 기준표 ' + rateTable.length + '개 항목 · 유형: ' + propertyType);

    const data = await window.CollateralCore.runPipeline({
      pdfDoc: doc,
      geminiKey: keys.gemini,
      molitKey: keys.molit || null,
      hammerRate: (Number($('i_collateral_rate').value) || 80) / 100,
      rateTable: rateTable,
      propertyType: propertyType,
      log: logLine
    });

    RESULT = data;
    renderCollateralResult(data);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    setSt('st_collateral','on','평가 완료 · 물건지 ' + (data.properties||[]).length + '개 · ' + secs + '초');
    $('btn_collateral_report').disabled = !(data.properties || []).length;

    if (!keys.molit){
      flag('<div class="callout">국토부 서비스키가 없어 <b>호갱노노 시세</b>로 계산했습니다. ' +
           '법정 신고 원천 데이터를 쓰려면 국토부 키를 넣으십시오.</div>');
    }
  }catch(err){
    setSt('st_collateral','off','평가 실패');
    logLine('[오류] ' + (err && err.message ? err.message : err));
    const msg = String(err && err.message || err);
    let hint = '';
    if (/HTTP 4\d\d/.test(msg) && /generativelanguage|Gemini/i.test(msg))
      hint = '<br><br>Gemini 키가 올바른지, 사용량 한도가 남아있는지 확인하십시오.';
    else if (err instanceof TypeError)
      hint = '<br><br>네트워크 요청이 막혔습니다. 광고 차단 확장이 켜져 있으면 꺼보십시오.';
    flag('<div class="callout callout--crit"><b>담보가치 평가 실패.</b> ' + esc(msg) + hint + '</div>');
  }finally{
    $('btn_collateral_eval').disabled = false;
  }
}

/* ───────────────── 리포트 인쇄 ─────────────────
   백엔드가 만들던 PDF 를 대신한다. 타설계획·현장 현황과 같은 인쇄 방식을 쓴다. */

function buildReportHTML(){
  const today = new Date().toISOString().slice(0,10);
  const rows = (RESULT.properties || []).map((p,i) =>
    '<tr>' +
      '<td>' + (i+1) + '</td>' +
      '<td class="pr-left">' + esc(p.address || '주소 미상') + '</td>' +
      '<td>' + (p.total_priority_amount != null ? W(p.total_priority_amount) : '—') + '</td>' +
      '<td>' + (p.market_price != null ? W(p.market_price) : '—') + '</td>' +
      '<td>' + (p.hammer_rate != null ? Math.round(p.hammer_rate*100) + '%' : '—') +
        (p.matched_rate_region ? '<br><small>' + esc(p.matched_rate_region) + '</small>' : '') + '</td>' +
      '<td>' + (p.collateral_value != null ? W(p.collateral_value) : '—') + '</td>' +
    '</tr>').join('');

  return '<h1>담보가치 평가 리포트</h1>' +
    '<p class="pr-sub">작성일: ' + today + '</p>' +
    '<p class="pr-cond">담보가치 = 실거래가 × 낙찰가율 − 선순위(유효 근저당권 채권최고액 합계)<br>' +
      '실거래가는 국토교통부 실거래가를 우선 사용하고, 없을 때만 호갱노노 값으로 대체합니다.</p>' +
    '<table><thead><tr>' +
      '<th>No</th><th>물건지</th><th>선순위</th><th>실거래가</th><th>낙찰가율</th><th>담보가치</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '<p class="pr-total">전체 물건지 담보가치 합계: ' +
      (RESULT.grand_total_collateral != null ? W(RESULT.grand_total_collateral) + '원' : '—') + '</p>';
}
function printReport(){
  if (!RESULT) return;
  $('ts_print_area').innerHTML = buildReportHTML();
  window.print();
}

/* ───────────────── 배선 ───────────────── */

if ($('btn_collateral_eval')) $('btn_collateral_eval').addEventListener('click', evaluateCollateral);
if ($('btn_collateral_report')) $('btn_collateral_report').addEventListener('click', printReport);

if ($('btn_save_keys')) $('btn_save_keys').addEventListener('click', () => {
  const prev = loadKeys();
  const geminiKey = $('i_gemini_key').value.trim();
  const keyChanged = geminiKey !== (prev.gemini || '');
  saveKeys({
    gemini: geminiKey,
    molit:  $('i_molit_key').value.trim(),
    model:  $('i_gemini_model').value,
    models: prev.models
  });
  window.CollateralCore.setModel($('i_gemini_model').value);
  updateKeyStatus();
  flag('<div class="callout">API 키를 이 브라우저에 저장했습니다. 서버로 전송되지 않습니다.</div>');
  /* 키가 새로 들어왔으면 그 키로 쓸 수 있는 모델을 바로 받아 최신으로 맞춘다 */
  if (geminiKey && keyChanged) reloadModels(false);
});
if ($('btn_reload_models')) $('btn_reload_models').addEventListener('click', () => reloadModels(false));

/* 드롭다운에서 고른 모델을 바로 반영·저장 */
if ($('i_gemini_model')) $('i_gemini_model').addEventListener('change', () => {
  const k = loadKeys();
  saveKeys(Object.assign({}, k, {model: $('i_gemini_model').value}));
  window.CollateralCore.setModel($('i_gemini_model').value);
});
if ($('btn_clear_keys')) $('btn_clear_keys').addEventListener('click', () => {
  storage.remove(KEY_STORE);
  syncKeyFields();
  flag('<div class="callout">저장된 API 키를 지웠습니다.</div>');
});

/* ── 부동산 유형 드롭다운 ──
   기준표에 있는 유형(아파트·단독·다가구·다세대/빌라·대지·임야·전/답·상가·
   오피스텔·근린시설)을 그대로 채운다. 선택은 이 브라우저에 기억한다. */
const TYPE_STORE = 'yeosin.propertyType';
(function(){
  const sel = $('i_property_type');
  const rates = window.HAMMER_RATES;
  if (!sel || !rates) return;
  const saved = storage.get(TYPE_STORE, '아파트');
  rates.types.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    if (t === saved) o.selected = true;
    sel.appendChild(o);
  });
  if (!rates.types.includes(saved)) sel.value = '아파트';
  sel.addEventListener('change', () => storage.set(TYPE_STORE, sel.value));
})();

syncKeyFields();
})();
