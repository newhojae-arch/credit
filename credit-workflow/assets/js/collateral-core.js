/* ══════════════════════════════════════════════════════════════
   collateral-core.js — 담보가치 평가 파이프라인 (브라우저 단독)

   streamlit-app/ 의 파이썬 파이프라인을 그대로 옮긴 것이다.
     registry_core.py    → 페이지 분류 · 을구 추출 · 부기등기 추적 · 선순위 합산
     hogangnono_lookup.py → 단지 검색 · 평형 매칭 · 최근 실거래
     rtms_lookup.py       → 국토부 실거래가 조회
     full_pipeline.py     → 낙찰가율 매칭 · 담보가치 계산

   백엔드가 없어도 되는 이유: Gemini · 국토부 · 호갱노노 세 곳 모두
   브라우저에서 직접 호출된다(CORS 허용 확인함). PDF→이미지 렌더링은
   이미 싣고 있는 pdf.js 로 한다.

   API 키는 사용자가 입력해 이 브라우저에만 저장된다. 저장소에 키를
   넣지 않는다 — 공개 정적 호스팅이라 넣으면 그대로 유출된다.

   DOM 을 건드리지 않는다. 진행 상황은 log 콜백으로만 알린다.
   ══════════════════════════════════════════════════════════════ */
(function(){
"use strict";

/* 파이썬이 쓰던 값. 목록을 못 불러왔을 때의 안전한 폴백이다.
   실제 기본값은 listModels() 로 받아온 목록에서 가장 최신 것을 고른다 —
   모델 ID 를 코드에 박아두면 새 모델이 나올 때마다 어긋난다. */
var FALLBACK_MODEL = "gemini-3.5-flash-lite";
var MODEL_NAME = FALLBACK_MODEL;

/* 사용 가능한 모델을 Gemini 에서 직접 받아온다.
   generateContent 를 지원하고 이미지(vision)를 받는 것만 남긴다. */
async function listModels(apiKey){
  var res = await fetch(GEMINI_ENDPOINT.replace(/\/models\/$/, "/models") + "?key=" +
                        encodeURIComponent(apiKey) + "&pageSize=200");
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  var data = await res.json();
  return (data.models || [])
    .filter(function(m){
      var methods = m.supportedGenerationMethods || [];
      if (methods.indexOf("generateContent") < 0) return false;
      var id = String(m.name || "").replace(/^models\//, "");
      /* 임베딩·검색전용 모델은 제외 */
      return /^gemini-/.test(id) && !/embedding|aqa|imagen|veo|tts|image-gen/i.test(id);
    })
    .map(function(m){
      var id = String(m.name).replace(/^models\//, "");
      return {id: id, label: m.displayName || id, rank: rankModel(id)};
    })
    .sort(function(a, b){ return b.rank - a.rank; });
}

/* "최신" 판정: 세대(3.5 > 2.5)가 우선, 같은 세대면 flash > flash-lite > pro.
   문서 판독은 이미지 입력이 많아 flash 계열이 비용·정확도 균형이 낫다.
   preview/exp 는 안정성이 떨어져 뒤로 민다. */
function rankModel(id){
  var m = /gemini-(\d+)(?:\.(\d+))?/.exec(id);
  var gen = m ? parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0) : 0;
  var tier = /flash-lite/.test(id) ? 2 : /flash/.test(id) ? 3 : /pro/.test(id) ? 1 : 0;
  var stable = /preview|exp|latest/i.test(id) ? 0 : 1;
  return gen * 1000 + stable * 100 + tier * 10;
}
var CLASSIFY_BATCH_SIZE = 15;
var DEFAULT_HAMMER_RATE = 0.80;
var GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
var HGNN = "https://hogangnono.com";
var RTMS = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";

var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
var noop = function(){};

/* ═══════════════════ Gemini ═══════════════════ */

/* registry_core._call_gemini_with_retry 와 같은 재시도 정책 (3회, 5s·10s 대기) */
async function geminiCall(apiKey, parts, log, maxRetries){
  maxRetries = maxRetries || 3;
  var lastError = null;
  for (var attempt = 1; attempt <= maxRetries; attempt++){
    try{
      var res = await fetch(GEMINI_ENDPOINT + MODEL_NAME + ":generateContent?key=" + encodeURIComponent(apiKey), {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          contents: [{parts: parts}],
          /* JSON 만 나오게 못박는다. 이게 없으면 ```json 펜스나 설명문이 섞여 와
             파싱이 실패한다. 추출 작업이라 온도는 0 으로 고정. */
          /* maxOutputTokens 는 넣지 않는다 — 모델별 상한을 넘기면 400 이 난다.
             기본값(모델 최대)을 그대로 쓴다. */
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        })
      });
      if (!res.ok){
        var body = await res.text();
        throw new Error("HTTP " + res.status + " " + body.slice(0, 300));
      }
      var data = await res.json();
      var cand = (data.candidates && data.candidates[0]) || null;
      var out = cand && cand.content && cand.content.parts
        ? cand.content.parts.map(function(p){ return p.text || ""; }).join("")
        : "";
      if (!out) throw new Error("빈 응답 (" + JSON.stringify(data).slice(0, 200) + ")");
      return out;
    }catch(e){
      lastError = e;
      log("[경고] 시도 " + attempt + "/" + maxRetries + " 실패: " + e.message);
      if (attempt < maxRetries) await sleep(attempt * 5000);
    }
  }
  throw new Error("Gemini 호출 실패 (" + maxRetries + "회 시도): " + (lastError && lastError.message));
}

function imagePart(base64png){
  return {inline_data: {mime_type: "image/png", data: base64png}};
}

/* 파이썬의 re.search(r'\[.*\]', text, re.DOTALL) 와 동일한 의도 */
function extractJson(text, kind){
  /* responseMimeType 을 걸어도 만약을 대비해 앞뒤 잡음을 걷어내고 파싱한다 */
  try{ return JSON.parse(text); }catch(e){}
  var open = kind === "array" ? "[" : "{";
  var close = kind === "array" ? "]" : "}";
  var s = text.indexOf(open), e = text.lastIndexOf(close);
  if (s < 0 || e <= s) return null;
  try{ return JSON.parse(text.slice(s, e + 1)); }catch(err){ return null; }
}
/* 파싱이 실패했을 때 무엇이 왔는지 보여준다. 이게 없으면 원인을 알 수 없다. */
function logBadResponse(log, label, text){
  log("[경고] " + label + " JSON 파싱 실패 · 응답 " + text.length + "자");
  log("       받은 내용: " + text.slice(0, 300).replace(/\s+/g, " "));
}

/* ═══════════════════ PDF 렌더링 ═══════════════════ */

/* 파이썬은 pymupdf 로 dpi 를 직접 준다. pdf.js 는 scale 이라 dpi/72 로 환산한다. */
async function renderPage(doc, pageIdx, dpi){
  var page = await doc.getPage(pageIdx + 1);
  var viewport = page.getViewport({scale: dpi / 72});
  var canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({canvasContext: canvas.getContext("2d"), viewport: viewport}).promise;
  var url = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;   /* 큰 캔버스를 오래 붙들지 않는다 */
  return url.slice(url.indexOf(",") + 1);
}

/* ═══════════════════ 1. 페이지 분류 ═══════════════════ */

function classifyPrompt(from, to){
  return '다음은 등기부등본 PDF의 페이지 ' + from + '번부터 ' + to + '번까지입니다.\n' +
'(하나의 파일에 여러 개의 서로 다른 부동산 등기부등본이 합쳐져 있을 수 있습니다)\n\n' +
'**매우 중요**: 한 페이지 안에 표제부/갑구/을구 중 여러 섹션이 함께 들어있는 경우가 많습니다\n' +
'(예: 페이지 하단에 표제부가 끝나고 갑구가 시작, 그 아래에 을구까지 이어지는 경우).\n' +
'반드시 각 섹션이 그 페이지에 **조금이라도 보이면 true**로 표시하세요. 하나만 고르지 마세요.\n\n' +
'각 페이지에 대해 다음을 판별하세요:\n' +
'1. page: 페이지 번호 (' + from + '부터 ' + to + '까지, 실제 순서대로)\n' +
'2. has_pyojebu: 이 페이지에 "표제부" 테이블(건물의 표시)이 보이면 true\n' +
'3. has_gapgu: 이 페이지에 "갑구" 테이블(소유권에 관한 사항)이 보이면 true\n' +
'4. has_eulgu: 이 페이지에 "을구" 테이블(소유권 이외의 권리에 관한 사항, 근저당권 정보)이 보이면 true\n' +
'5. unique_number: 고유번호 (표제부 상단 우측 바코드 옆, 예: "1615-1996-392221"). 이 페이지에 표제부가 없으면 null\n' +
'6. address: 물건 소재지 주소 (표제부에 있음, 예: "충청남도 천안시 동남구 청수동 183 극동아파트 201동 802호"). 없으면 null\n' +
'7. area_sqm: "전유부분의 건물의 표시" 표에 있는 해당 호실의 전용면적 (단위: ㎡, 숫자만).\n' +
'   예: "철근콘크리트구조 84.9754㎡" → 84.9754\n' +
'   주의: "1동의 건물의 표시"(건물 전체 면적, 여러 층 면적 나열된 것)가 아니라\n' +
'   반드시 "전유부분의 건물의 표시"에 있는 해당 호실 하나의 면적만 추출. 없으면 null\n\n' +
'**중요**: 새로운 부동산 등기부등본이 시작되면 새로운 고유번호가 나타납니다. 이를 기준으로 물건지를 구분할 것입니다.\n\n' +
'JSON 배열로만 응답하세요 (다른 설명 없이):\n' +
'[\n' +
'  {"page": ' + from + ', "has_pyojebu": true, "has_gapgu": false, "has_eulgu": false, "unique_number": "1615-1996-392221", "address": "충청남도 천안시...", "area_sqm": 84.9754},\n' +
'  {"page": ' + (from + 1) + ', "has_pyojebu": false, "has_gapgu": true, "has_eulgu": true, "unique_number": null, "address": null, "area_sqm": null}\n' +
']';
}

async function classifyPages(apiKey, doc, log){
  var total = doc.numPages;
  log("[분류] 전체 " + total + "페이지 분류 시작");
  var all = [];

  for (var start = 0; start < total; start += CLASSIFY_BATCH_SIZE){
    var end = Math.min(start + CLASSIFY_BATCH_SIZE, total);
    log("[분류] 페이지 " + (start + 1) + "~" + end + " 분석 중…");

    var parts = [{text: classifyPrompt(start + 1, end)}];
    for (var p = start; p < end; p++){
      parts.push(imagePart(await renderPage(doc, p, 100)));   /* 분류용은 저해상도 */
    }
    var text = await geminiCall(apiKey, parts, log);
    var batch = extractJson(text, "array");
    if (batch) all = all.concat(batch);
    else logBadResponse(log, "배치 " + (start + 1) + "~" + end, text);
  }

  all.sort(function(a, b){ return (a.page || 0) - (b.page || 0); });
  log("[분류] 완료: " + all.length + "개 페이지 분류됨");
  return all;
}

/* ═══════════════════ 2. 물건지 그룹화 ═══════════════════ */

function groupProperties(classifications, log){
  log("");
  log("[그룹화] 물건지별 페이지 그룹화 시작");
  var properties = [];
  var currentUnique = null, currentAddress = null;

  classifications.forEach(function(item){
    var uniqueNumber = item.unique_number;
    var address = item.address;

    if (uniqueNumber && uniqueNumber !== currentUnique){
      currentUnique = uniqueNumber;
      currentAddress = address || currentAddress;
      properties.push({unique_number: currentUnique, address: currentAddress,
                       area_sqm: null, pages: [], eulgu_pages: []});
      log("  [새 물건지] 고유번호: " + currentUnique + ", 주소: " + currentAddress);
    }
    /* 표지/주문서처럼 고유번호 없이 시작하는 문서 대비 */
    if (!properties.length){
      properties.push({unique_number: "UNKNOWN", address: null,
                       area_sqm: null, pages: [], eulgu_pages: []});
    }

    var cur = properties[properties.length - 1];
    cur.pages.push(item.page);
    if (item.has_eulgu) cur.eulgu_pages.push(item.page);
    if (address && !cur.address) cur.address = address;
    if (item.area_sqm && !cur.area_sqm){
      var v = parseFloat(item.area_sqm);
      if (!isNaN(v)) cur.area_sqm = v;
    }
  });

  /* 을구가 없는 그룹(표지 등)은 물건지가 아니다 */
  properties = properties.filter(function(p){ return p.eulgu_pages.length; });

  log("[그룹화] 완료: " + properties.length + "개 물건지 발견 (을구 없는 그룹 제외)");
  properties.forEach(function(p, i){
    log("  물건지 " + (i + 1) + ": " + p.address +
        " (전용면적: " + p.area_sqm + "㎡, 을구 페이지: " + p.eulgu_pages.join(",") + ")");
  });
  return properties;
}

/* ═══════════════════ 3. 을구 추출 ═══════════════════ */

var EXTRACTION_PROMPT = '다음은 한국 등기부등본의 【을구】(소유권 이외의 권리에 관한 사항) 섹션입니다.\n\n' +
'### 1단계: 항목 유형 분류\n' +
'**기본 근저당권 (독립적 항목):**\n' +
'- "근저당권설정" (최초 등기)\n' +
'- "근저당권이전" (채권자 변경)\n' +
'- "근저당권변경" (금액 변경)\n\n' +
'**부기등기 (다른 항목을 수정):**\n' +
'- "O번근저당권설정등기말소" → O번 항목 취소\n' +
'- "O번근저당권이전" → O번 항목 수정\n' +
'→ 부기등기는 채권최고액이 없거나 "-" 처리됨\n\n' +
'### 2단계: 정보 추출\n' +
'1. 순위번호: 1, 2, 3... (단순 숫자만)\n' +
'2. 채권최고액:\n' +
'   - 숫자가 있으면 그 숫자 (예: 36400000)\n' +
'   - "-" 이거나 없으면 0 (부기등기)\n' +
'   - 취소선이 그어져 있으면 0\n' +
'3. 상태:\n' +
'   - 행의 텍스트 위에 빨간색 또는 검은색 취소선이 있으면 "말소"\n' +
'   - "말소" 텍스트가 있으면 "말소"\n' +
'   - 그 외 "유효"\n' +
'4. 등기목적: 정확히 표기된 대로\n' +
'5. is_subsidiary: "O번근저당권" 텍스트가 있으면 true\n\n' +
'### 3단계: JSON 응답 형식 (다른 설명 없이 JSON만 출력)\n' +
'{\n' +
'  "mortgages": [\n' +
'    {"priority": "1", "amount": 36400000, "status": "유효", "purpose": "근저당권설정", "is_subsidiary": false},\n' +
'    {"priority": "2", "amount": 0, "status": "말소", "purpose": "1번근저당권설정등기말소", "is_subsidiary": true}\n' +
'  ],\n' +
'  "validation_notes": "각 항목별 상세 설명"\n' +
'}\n\n' +
'### 부기등기 금액 처리 (중요!)\n' +
'- "O번근저당권설정등기말소" 부기등기: amount는 0\n' +
'- "O번근저당권변경" 부기등기: 그 행에 새로운 채권최고액이 적혀있으면 **그 새 금액을 amount에 넣기** (0 아님!)\n' +
'  예: "4번근저당권변경" 행에 "채권최고액 금48,600,000원"이 적혀있으면 amount: 48600000\n' +
'- "O번근저당권이전" 부기등기: amount는 0 (채권자만 바뀜, 금액 변경 없음)\n\n' +
'### 매우 중요:\n' +
'- 부기등기(is_subsidiary=true)는 기본 근저당권과 분리\n' +
'- 취소선 또는 "말소" 텍스트 있으면 반드시 "말소" 표시\n' +
'- JSON만 출력, 다른 텍스트 없이';

async function extractEulguData(apiKey, doc, pageNumbers, log){
  var parts = [{text: EXTRACTION_PROMPT}];
  for (var i = 0; i < pageNumbers.length; i++){
    try{
      parts.push(imagePart(await renderPage(doc, pageNumbers[i] - 1, 200)));  /* 추출은 고해상도 */
    }catch(e){
      log("[경고] 페이지 " + pageNumbers[i] + " 처리 불가: " + e.message);
    }
  }
  if (parts.length === 1) throw new Error("렌더링된 이미지가 없습니다");

  var text = await geminiCall(apiKey, parts, log);
  var obj = extractJson(text, "object");
  if (obj){
    log("[추출성공] " + ((obj.mortgages || []).length) + "개 근저당권");
    return obj;
  }
  logBadResponse(log, "을구 추출", text);
  return {raw_response: text, error: "JSON parsing failed"};
}

/* ═══════════════════ 4. 부기등기 추적 · 선순위 ═══════════════════ */

function trackSubsidiaryRegistrations(mortgages){
  var basic = {}, subs = [];

  (mortgages || []).forEach(function(m){
    var priority = String(m.priority == null ? "" : m.priority).trim();
    if (m.is_subsidiary){
      subs.push({priority: priority, type: m.purpose || "", status: m.status || "", amount: m.amount || 0});
    }else{
      var baseNum = priority.split("-")[0];
      (basic[baseNum] = basic[baseNum] || []).push(m);
    }
  });

  /* "O번근저당권…" 의 O 를 찾아 해당 기본 항목에 붙인다 */
  subs.forEach(function(sub){
    var match = /(\d+)번/.exec(sub.type);
    if (!match) return;
    var target = match[1];
    if (!basic[target]) return;
    basic[target].push({
      priority: "(" + sub.priority + ")",
      amount: sub.amount || 0,
      status: sub.status,
      purpose: "부기등기(" + sub.type + ")",
      is_change: sub.type.indexOf("변경") >= 0,
      is_auxiliary: true
    });
  });

  var final = {};
  Object.keys(basic).forEach(function(baseNum){
    var entries = basic[baseNum];
    var status = "유효", amount = 0, purpose = "";

    entries.forEach(function(e){
      if (e.is_auxiliary) return;
      amount = parseInt(e.amount, 10) || 0;
      purpose = e.purpose || "";
      if (e.status === "말소") status = "말소";
    });
    /* 부기등기를 순서대로 적용: 변경은 금액 갱신, 말소는 상태 갱신 */
    entries.forEach(function(e){
      if (!e.is_auxiliary) return;
      var amt = parseInt(e.amount, 10) || 0;
      if (e.is_change && amt > 0){ amount = amt; purpose = e.purpose || purpose; }
      if (e.status === "말소") status = "말소";
    });

    final[baseNum] = {
      priority: baseNum,
      amount: status === "유효" ? amount : 0,
      status: status,
      purpose: purpose,
      entries_count: entries.length
    };
  });
  return final;
}

function calculatePrioritySum(eulguData){
  var final = trackSubsidiaryRegistrations(eulguData.mortgages || []);
  var valid = [], total = 0;
  Object.keys(final).forEach(function(k){
    var m = final[k];
    if (String(m.status || "").trim() !== "유효") return;
    valid.push(m);
    total += parseInt(m.amount, 10) || 0;
  });
  return {
    valid_mortgages: valid,
    total_priority_amount: total,
    total_mortgages: Object.keys(final).length,
    cancelled_mortgages: Object.keys(final).length - valid.length,
    all_mortgages: final
  };
}

/* ═══════════════════ 5. 호갱노노 ═══════════════════ */

async function hgnnJson(url){
  var res = await fetch(url, {headers: {"Accept": "application/json"}});
  if (!res.ok) throw new Error("호갱노노 HTTP " + res.status);
  return res.json();
}

async function hgnnSearch(query){
  var url = HGNN + "/api/v2/searches/suggestions/new?query=" + encodeURIComponent(query) +
            "&x=127.0547915&y=37.523003";
  var data = await hgnnJson(url);
  return (((data.data || {}).matched || {}).apt || {}).list || [];
}

/* 지번 주소가 포함 관계면 그 단지, 아니면 검색 1위(약한 매칭) */
function hgnnBestMatch(candidates, jibunAddress){
  if (!candidates || !candidates.length) return null;
  var target = String(jibunAddress || "").replace(/\s/g, "");
  for (var i = 0; i < candidates.length; i++){
    var addr = String(candidates[i].address || "").replace(/\s/g, "");
    if (addr && (target.indexOf(addr) >= 0 || addr.indexOf(target) >= 0)) return candidates[i];
  }
  return candidates[0];
}

async function hgnnRecentTrades(aptId, tradeType){
  var data = await hgnnJson(HGNN + "/api/v2/apts/" + aptId + "/trade-real?tradeType=" + (tradeType || 0) + "&start=0");
  return ((data.data || {}).data) || [];
}

/* 단지 상세 페이지 HTML 에 서버가 심어둔 "areaMap" 을 파싱한다.
   (/api/apt/{id}/detail 은 직접 호출하면 400 — SSR 전용으로 추정) */
async function hgnnAreaTypes(aptId){
  var res = await fetch(HGNN + "/apt/" + aptId + "/0");
  if (!res.ok) throw new Error("호갱노노 상세 HTTP " + res.status);
  var html = await res.text();

  var marker = '"areaMap":';
  var idx = html.indexOf(marker);
  if (idx < 0) return [];
  var start = html.indexOf("{", idx), depth = 0, end = start;
  for (var i = start; i < html.length; i++){
    if (html[i] === "{") depth++;
    else if (html[i] === "}"){ depth--; if (depth === 0){ end = i + 1; break; } }
  }
  var areaMap;
  try{ areaMap = JSON.parse(html.slice(start, end)); }catch(e){ return []; }

  return Object.keys(areaMap).map(function(areaId){
    var info = areaMap[areaId] || {};
    var popular = info.popular_type || {};
    var areas = popular.area || [];
    var code = null;
    for (var j = 0; j < areas.length; j++){
      if (String(areas[j].areaId) === String(areaId) ||
          (info.id != null && areas[j].areaId === info.id)){ code = areas[j].type; break; }
    }
    if (code == null && areas.length) code = areas[0].type;
    if (code == null && info.public_area) code = String(Math.floor(info.public_area));
    return {area_type: code, private_area_sqm: info.private_area, public_area_sqm: info.public_area};
  });
}

function findMatchingAreaType(areaTypes, targetSqm, tolerance){
  tolerance = tolerance == null ? 3.0 : tolerance;
  if (!areaTypes || !areaTypes.length || targetSqm == null) return null;
  var best = null, bestDiff = null;
  areaTypes.forEach(function(a){
    if (a.private_area_sqm == null) return;
    var diff = Math.abs(a.private_area_sqm - targetSqm);
    if (bestDiff == null || diff < bestDiff){ bestDiff = diff; best = a; }
  });
  return (best && bestDiff != null && bestDiff <= tolerance) ? best.area_type : null;
}

function filterRecent(trades, months, areaType){
  var cutoff = Date.now() - months * 30 * 86400000;
  return (trades || []).filter(function(t){
    if (t.isCancelled) return false;
    if (areaType != null && String(t.areaType) !== String(areaType)) return false;
    if (!t.date) return false;
    var d = Date.parse(t.date);
    return !isNaN(d) && d >= cutoff;
  });
}

function avgPriceMan(trades){
  var prices = (trades || []).map(function(t){ return t.price; }).filter(Boolean);
  if (!prices.length) return null;
  var sum = prices.reduce(function(a, b){ return a + b; }, 0);
  return Math.floor(sum / prices.length * 10000);   /* 만원 → 원 */
}

async function hgnnLookup(query, months, targetAreaSqm, areaTolerance){
  months = months || 3;
  var candidates = await hgnnSearch(query);
  if (!candidates.length) return {error: "검색 결과가 없습니다", query: query};

  var matched = hgnnBestMatch(candidates, query);
  if (!matched) return {error: "일치하는 단지를 찾지 못했습니다", query: query};

  var aptId = matched.id;
  var matchedAreaType = null, areaFilterApplied = false;
  if (targetAreaSqm){
    try{ matchedAreaType = findMatchingAreaType(await hgnnAreaTypes(aptId), targetAreaSqm, areaTolerance); }
    catch(e){ matchedAreaType = null; }
  }

  var all = await hgnnRecentTrades(aptId, 0);
  var recent;
  if (matchedAreaType){
    recent = filterRecent(all, months, matchedAreaType);
    areaFilterApplied = true;
    if (!recent.length){
      /* 최근 N개월에 같은 평형 거래가 없으면 기간 제한 없이 최신 5건 */
      recent = all.filter(function(t){
        return String(t.areaType) === String(matchedAreaType) && !t.isCancelled;
      }).slice(0, 5);
    }
  }else{
    recent = filterRecent(all, months, null);
  }

  var avg = recent.length ? avgPriceMan(recent) : avgPriceMan(all.slice(0, 5));
  var note = null;
  if (targetAreaSqm && !matchedAreaType) note = "전용면적 " + targetAreaSqm + "㎡과 일치하는 평형을 찾지 못해 전체 평형 평균으로 대체";
  else if (!recent.length) note = "최근 데이터 없어 최신 5건으로 대체";

  return {
    matched_apt: {
      id: aptId, name: matched.name, address: matched.address,
      road_address: matched.road_address, household: matched.household,
      region_code: matched.region_code,
      lawd_cd: String(matched.region_code || "").slice(0, 5) || null
    },
    matched_area_type: matchedAreaType,
    target_area_sqm: targetAreaSqm,
    area_filter_applied: areaFilterApplied,
    recent_trades: recent.length ? recent : all.slice(0, 5),
    average_price: avg,
    trade_count: recent.length ? recent.length : all.slice(0, 5).length,
    note: note
  };
}

/* ═══════════════════ 6. 국토부 실거래가 ═══════════════════ */

function recentMonths(n){
  var out = [], d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
  for (var i = 0; i < n; i++){
    out.push("" + y + String(m).padStart(2, "0"));
    m--; if (m === 0){ m = 12; y--; }
  }
  return out;
}

/* data.go.kr 은 키를 두 형태로 준다.
     Encoding 키: 이미 퍼센트 인코딩됨 (예: abc%2Bdef%3D)
     Decoding 키: 원본 그대로   (예: abc+def=)
   포털에서 먼저 보이는 건 Encoding 키라 대부분 그걸 복사한다. 거기에
   encodeURIComponent 를 또 걸면 %2B 가 %252B 로 변해 키가 깨진다.
   이미 인코딩된 키로 보이면 그대로 쓴다. */
function encodeServiceKey(key){
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
}

async function rtmsFetchMonth(lawdCd, dealYmd, apiKey){
  var url = RTMS + "?serviceKey=" + encodeServiceKey(apiKey) +
            "&LAWD_CD=" + encodeURIComponent(lawdCd) +
            "&DEAL_YMD=" + encodeURIComponent(dealYmd) +
            "&numOfRows=1000&pageNo=1";
  var res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  var raw = await res.text();
  var xml = new DOMParser().parseFromString(raw, "application/xml");
  if (xml.querySelector("parsererror"))
    throw new Error("응답을 XML 로 읽지 못했습니다: " + raw.slice(0, 200));

  var codeNode = xml.querySelector("resultCode");
  var code = codeNode ? codeNode.textContent.trim() : null;
  var ok = code === null || parseInt(code, 10) === 0;
  if (!ok){
    var msgNode = xml.querySelector("resultMsg, errMsg, returnAuthMsg");
    throw new Error("API 오류 [" + code + "]: " + (msgNode ? msgNode.textContent.trim() : ""));
  }
  /* 인증 실패 등은 resultCode 없이 cmmMsgHeader 로 온다 */
  var authMsg = xml.querySelector("returnAuthMsg, errMsg");
  if (authMsg && !xml.querySelector("item")) throw new Error(authMsg.textContent.trim());

  return Array.prototype.map.call(xml.querySelectorAll("item"), function(item){
    var o = {};
    Array.prototype.forEach.call(item.children, function(c){ o[c.tagName] = (c.textContent || "").trim(); });
    return o;
  }).filter(function(o){ return !o.cdealType; });   /* 해제(취소)된 거래 제외 */
}

/* 단지명 표기가 소스마다 다르다.
   호갱노노 "극동2차"  vs  국토부 "극동" / "극동아파트" / "극동 2차"
   원본(파이썬)은 단순 포함 비교라 위 조합이 서로 안 걸린다. 공백·"아파트"·
   "N차" 를 걷어낸 형태로도 한 번 더 비교해 실제로 같은 단지를 놓치지 않게 한다. */
function normalizeAptName(name){
  return String(name || "")
    .replace(/\s/g, "")
    .replace(/아파트/g, "")
    .replace(/\d+차$/, "");
}
function aptNameMatches(itemName, aptName){
  if (!itemName || !aptName) return false;
  if (itemName.indexOf(aptName) >= 0 || aptName.indexOf(itemName) >= 0) return true;  /* 원본과 동일 */
  var a = normalizeAptName(itemName), b = normalizeAptName(aptName);
  return !!(a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
}

async function rtmsLookup(lawdCd, aptName, dong, areaSqm, monthsBack, apiKey, log){
  var tolerance = 3.0;
  var matches = [];
  var months = recentMonths(monthsBack || 3);
  var hadError = null;
  var seenNames = {};      /* 왜 못 찾았는지 보여주기 위해 그 지역의 단지명을 모아둔다 */
  var nameHits = 0, dongSkips = 0, areaSkips = 0;

  for (var i = 0; i < months.length; i++){
    var items;
    try{ items = await rtmsFetchMonth(lawdCd, months[i], apiKey); }
    catch(e){ log("[경고] " + months[i] + " 조회 실패: " + e.message); hadError = hadError || e; continue; }
    log("  [국토부] " + months[i] + " · 거래 " + items.length + "건 수신");

    items.forEach(function(item){
      var itemName = item.aptNm || "";
      if (itemName) seenNames[itemName] = (seenNames[itemName] || 0) + 1;
      if (!aptNameMatches(itemName, aptName)) return;
      nameHits++;
      if (dong){
        /* aptDong 표기가 "106" / "106동" 으로 들쭉날쭉해 숫자만 비교 */
        var a = String(item.aptDong || "").replace(/\D/g, "");
        var b = String(dong).replace(/\D/g, "");
        if (a && b && a !== b){ dongSkips++; return; }
      }
      if (areaSqm != null){
        var area = parseFloat(item.excluUseAr);
        if (isNaN(area) || Math.abs(area - areaSqm) > tolerance){ areaSkips++; return; }
      }
      matches.push(item);
    });
  }

  if (!matches.length){
    /* 왜 0건인지 구분해서 알려준다 — 키 문제 / 단지명 불일치 / 필터 과다 */
    var reason;
    if (hadError) reason = String(hadError.message);
    else if (!nameHits){
      var names = Object.keys(seenNames).sort(function(x, y){ return seenNames[y] - seenNames[x]; });
      reason = '단지명 "' + aptName + '" 과 일치하는 거래가 없습니다' +
               (names.length ? ' · 이 지역 단지: ' + names.slice(0, 8).join(", ") +
                               (names.length > 8 ? " 외 " + (names.length - 8) + "개" : "")
                             : " · 이 지역 거래 자체가 없습니다");
    }else{
      reason = "단지는 찾았으나 필터에 걸려 0건" +
               (dongSkips ? " (동 불일치 " + dongSkips + "건)" : "") +
               (areaSkips ? " (면적 불일치 " + areaSkips + "건)" : "");
    }
    return {error: reason, matches: [], average_price: null, trade_count: 0};
  }

  matches.sort(function(x, y){
    var kx = (x.dealYear || "") + String(x.dealMonth || "").padStart(2, "0") + String(x.dealDay || "").padStart(2, "0");
    var ky = (y.dealYear || "") + String(y.dealMonth || "").padStart(2, "0") + String(y.dealDay || "").padStart(2, "0");
    return kx < ky ? 1 : kx > ky ? -1 : 0;
  });

  var prices = matches.map(function(m){
    return parseInt(String(m.dealAmount || "").replace(/,/g, "").trim(), 10);
  }).filter(function(v){ return !isNaN(v); });
  var avg = prices.length
    ? Math.floor(prices.reduce(function(a, b){ return a + b; }, 0) / prices.length * 10000)
    : null;

  return {error: null, matches: matches, average_price: avg, trade_count: matches.length};
}

/* ═══════════════════ 7. 낙찰가율 ═══════════════════ */

/* 등기부 주소에서 건물 동 번호만 뽑는다.
   행정동("청수동")은 숫자 없이 한글로 끝나므로 숫자+동 패턴만 잡으면 된다. */
function extractBuildingDong(address){
  if (!address) return null;
  var m = /(\d+)\s*동(?:\s|$)/.exec(address);
  return m ? m[1] : null;
}

/* keywords 전부가 주소에 들어있어야 매칭(AND).
   여러 개 맞으면 (키워드 개수, 총 글자수) 가 큰 쪽 = 더 구체적인 것을 택한다. */
function matchHammerRate(address, rateTable, defaultRate){
  defaultRate = defaultRate == null ? DEFAULT_HAMMER_RATE : defaultRate;
  if (!address || !rateTable || !rateTable.length) return {rate: defaultRate, region: null};

  var normalized = String(address).replace(/\s/g, "");
  var candidates = [];
  rateTable.forEach(function(entry){
    var keywords = (entry.keywords || [entry.region]).filter(Boolean);
    if (!keywords.length) return;
    var all = keywords.every(function(k){ return normalized.indexOf(k) >= 0; });
    if (!all) return;
    candidates.push({
      specificity: keywords.length,
      totalLen: keywords.reduce(function(a, k){ return a + k.length; }, 0),
      keywords: keywords, rate: entry.rate
    });
  });
  if (!candidates.length) return {rate: defaultRate, region: null};

  candidates.sort(function(a, b){
    return (b.specificity - a.specificity) || (b.totalLen - a.totalLen);
  });
  return {rate: candidates[0].rate, region: candidates[0].keywords.join("+")};
}

/* ═══════════════════ 8. 전체 파이프라인 ═══════════════════ */

async function runPipeline(opts){
  var doc = opts.pdfDoc, log = opts.log || noop;
  var geminiKey = opts.geminiKey, molitKey = opts.molitKey;
  var hammerRate = opts.hammerRate == null ? DEFAULT_HAMMER_RATE : opts.hammerRate;
  var rateTable = opts.rateTable || null;

  log("=".repeat(60));
  log("[1단계] 등기부등본 분석 (물건지 자동 감지 + 선순위 계산)");
  log("=".repeat(60));

  var classifications = await classifyPages(geminiKey, doc, log);
  var properties = groupProperties(classifications, log);

  var out = [], grandTotal = 0;

  for (var i = 0; i < properties.length; i++){
    var prop = properties[i];
    log("");
    log("=".repeat(60));
    log("[물건지 " + (i + 1) + "/" + properties.length + "] " + prop.address);
    log("=".repeat(60));

    var eulgu = await extractEulguData(geminiKey, doc, prop.eulgu_pages, log);
    var calc = calculatePrioritySum(eulgu);
    var priorityAmount = calc.total_priority_amount;
    log("  선순위: " + priorityAmount.toLocaleString("ko-KR") + "원");

    var matched = matchHammerRate(prop.address, rateTable, hammerRate);
    var appliedRate = matched.rate;

    log("");
    log("[2단계] 실거래가 조회: " + prop.address +
        (prop.area_sqm ? " (전용 " + prop.area_sqm + "㎡)" : " (전용면적 정보 없음)"));
    if (rateTable){
      log(matched.region
        ? "  [낙찰가율 매칭] '" + matched.region + "' 기준 → " + Math.round(appliedRate * 100) + "%"
        : "  [낙찰가율 매칭] 기준표에 일치하는 지역 없음 → 기본값 " + Math.round(appliedRate * 100) + "% 적용");
    }

    var base = Object.assign({}, prop, calc, {
      property_index: i + 1,
      hammer_rate: appliedRate,
      matched_rate_region: matched.region
    });

    if (!prop.address){
      log("  [경고] 주소를 알 수 없어 실거래가 조회를 건너뜁니다");
      out.push(Object.assign(base, {market_price: null, collateral_value: null,
                                    error: "주소 미상으로 시세 조회 불가"}));
      continue;
    }

    var market;
    try{ market = await hgnnLookup(prop.address, 3, prop.area_sqm, 3.0); }
    catch(e){
      log("  [오류] 실거래가 조회 실패: " + e.message);
      out.push(Object.assign(base, {market_price: null, collateral_value: null,
                                    error: "실거래가 조회 실패: " + e.message}));
      continue;
    }
    if (market.error){
      log("  [경고] " + market.error);
      out.push(Object.assign(base, {market_price: null, collateral_value: null, error: market.error}));
      continue;
    }

    var hgnnPrice = market.average_price;
    var matchedApt = market.matched_apt || {};
    log("  매칭된 단지: " + matchedApt.name + " (" + matchedApt.address + ")");
    if (market.area_filter_applied)
      log("  [평형 매칭] 전용 " + prop.area_sqm + "㎡ → " + market.matched_area_type + "타입으로 필터링 완료");
    else if (market.note) log("  [경고] " + market.note);
    log(hgnnPrice ? "  [호갱노노] 최근 실거래가 (평균): " + hgnnPrice.toLocaleString("ko-KR") + "원"
                  : "  [호갱노노] 실거래가 없음");

    /* 국토부(법정 신고 원천)를 주값으로, 호갱노노는 교차검증용 */
    var molitPrice = null, molitResult = null;
    var buildingDong = extractBuildingDong(prop.address);
    if (matchedApt.lawd_cd && molitKey){
      try{
        molitResult = await rtmsLookup(matchedApt.lawd_cd, matchedApt.name || "",
                                       buildingDong, prop.area_sqm, 3, molitKey, log);
        if (molitResult.error) log("  [국토부] " + molitResult.error);
        else{
          molitPrice = molitResult.average_price;
          log("  [국토부] 최근 실거래가 (평균): " + molitPrice.toLocaleString("ko-KR") +
              "원 (" + molitResult.trade_count + "건)" +
              (buildingDong ? " · " + buildingDong + "동 필터 적용" : ""));
        }
      }catch(e){ log("  [국토부] 조회 실패: " + e.message); }
    }else if (!molitKey){
      log("  [국토부] 서비스키가 없어 조회 생략 (호갱노노 값 사용)");
    }else{
      log("  [국토부] 법정동코드를 알 수 없어 조회 생략");
    }

    var marketPrice = null;
    if (molitPrice){
      marketPrice = molitPrice;
      if (hgnnPrice){
        var diffPct = Math.abs(hgnnPrice - molitPrice) / Math.max(hgnnPrice, molitPrice) * 100;
        log("  [교차검증] 국토부 vs 호갱노노 차이: " + diffPct.toFixed(1) + "%");
        if (diffPct > 15) log("  [경고] 두 소스 간 차이가 큽니다(" + diffPct.toFixed(1) + "%) — 수동 확인 권장");
      }
      log("  [최종 채택 시세] " + marketPrice.toLocaleString("ko-KR") + "원 (국토부 실거래가 기준)");
    }else if (hgnnPrice){
      marketPrice = hgnnPrice;
      log("  [안내] 국토부 데이터 없어 호갱노노 데이터로 대체");
    }

    var collateralValue = null;
    if (marketPrice){
      collateralValue = Math.floor(marketPrice * appliedRate) - priorityAmount;
      grandTotal += collateralValue;
    }

    log("");
    log("[3단계] 담보가치 계산");
    log("  실거래가: " + (marketPrice ? marketPrice.toLocaleString("ko-KR") + "원" : "없음"));
    log("  낙찰가율: " + Math.round(appliedRate * 100) + "%" + (matched.region ? " (" + matched.region + " 기준)" : ""));
    log("  선순위: " + priorityAmount.toLocaleString("ko-KR") + "원");
    if (collateralValue != null)
      log("  >>> 담보가치 = " + marketPrice.toLocaleString("ko-KR") + " × " + appliedRate +
          " - " + priorityAmount.toLocaleString("ko-KR") + " = " + collateralValue.toLocaleString("ko-KR") + "원");

    out.push(Object.assign(base, {
      matched_apt: matchedApt,
      matched_area_type: market.matched_area_type,
      recent_trades: market.recent_trades,
      market_price: marketPrice,
      hogangnono_price: hgnnPrice,
      molit_price: molitPrice,
      molit_trade_count: molitResult ? molitResult.trade_count : 0,
      molit_trades: molitResult ? molitResult.matches : [],
      collateral_value: collateralValue
    }));
  }

  return {properties: out, grand_total_collateral: grandTotal};
}

window.CollateralCore = {
  DEFAULT_HAMMER_RATE: DEFAULT_HAMMER_RATE,
  FALLBACK_MODEL: FALLBACK_MODEL,
  listModels: listModels,
  rankModel: rankModel,
  getModel: function(){ return MODEL_NAME; },
  setModel: function(m){ MODEL_NAME = (m || "").trim() || FALLBACK_MODEL; },
  runPipeline: runPipeline,
  matchHammerRate: matchHammerRate,
  extractBuildingDong: extractBuildingDong,
  trackSubsidiaryRegistrations: trackSubsidiaryRegistrations,
  calculatePrioritySum: calculatePrioritySum,
  groupProperties: groupProperties,
  hgnnLookup: hgnnLookup,
  rtmsLookup: rtmsLookup
};

})();
