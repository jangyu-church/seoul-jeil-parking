// 교회 주차 신청 앱 · 화면 (프레임워크 없이 순수 JS)
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS = { approved: '승인', pending: '승인 대기', waitlist: '대기자', rejected: '거절', cancelled: '취소' };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

const state = {
  cfg: null, token: store.get('token'), user: null, loading: false,
  authMode: 'login', tab: 'home', adminTab: 'day',
  sessions: [], vehicles: [], requests: [], openKey: null,
  admin: { date: null, day: null, search: null, members: [], memberQ: '', settings: [], services: [], q: '' },
};

/* ───────── 도우미 ───────── */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${m}월 ${dd}일(${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`; };
const fmtPhone = (p) => String(p).replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isAdmin = () => state.user?.role === 'admin';

let toastTimer;
function toast(msg, err = false) {
  $toast.textContent = msg;
  $toast.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, err ? 4500 : 2800);
}

async function api(action, params = {}) {
  let res;
  try {
    res = await fetch(window.APP_CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 'simple request'라서 CORS 사전 요청이 필요 없어요
      body: JSON.stringify({ action, token: state.token, ...params }),
    }).then((r) => r.json());
  } catch {
    throw new Error('인터넷 연결을 확인해 주세요.');
  }
  if (!res.ok) { const e = new Error(res.error); e.code = res.code; throw e; }
  return res.data;
}

async function run(fn) {
  try { return await fn(); } catch (e) {
    if (e.code === 'AUTH') { logout(true); return; }
    toast(e.message || '문제가 생겼어요.', true);
  }
}

function logout(expired = false) {
  store.del('token');
  state.token = null; state.user = null; state.authMode = 'login';
  render();
  if (expired) toast('다시 로그인해 주세요.', true);
}

/* ───────── 화면: 공통 ───────── */
const badge = (s, extra = '') => `<span class="badge b-${s}">${STATUS[s]}${extra}</span>`;
const field = ({ name, label, type = 'text', attrs = '', hint = '', value = '' }) =>
  `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${attrs}>${hint ? `<div class="hint">${hint}</div>` : ''}`;

function shell(body) {
  const tabs = [['home', '🅿️', '주차 신청'], ['mine', '📋', '내 신청'], ['cars', '🚗', '내 차량']];
  if (isAdmin()) tabs.push(['admin', '⚙️', '관리']);
  return `
    <header class="top"><h2>${esc(state.cfg.churchName)}</h2>
      <div class="who">${esc(state.user.name)} 님</div></header>
    ${body}
    <nav class="tabs"><div>${tabs.map(([k, ic, l]) =>
      `<button data-act="tab" data-v="${k}" class="${state.tab === k ? 'on' : ''}" ${state.tab === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${l}</button>`).join('')}</div></nav>`;
}

/* ───────── 화면: 로그인/가입 ───────── */
function viewAuth() {
  const reg = state.authMode === 'register';
  return `<main class="card auth">
    <h1>${esc(state.cfg.churchName)}</h1><p class="sub">주차 신청</p>
    <div class="seg">
      <button data-act="auth-mode" data-v="login" class="${reg ? '' : 'on'}">로그인</button>
      <button data-act="auth-mode" data-v="register" class="${reg ? 'on' : ''}">처음이에요</button>
    </div>
    <form data-form="${reg ? 'register' : 'login'}" autocomplete="on">
      ${reg ? field({ name: 'name', label: '이름', attrs: 'required maxlength="20" autocomplete="name"' }) : ''}
      ${field({ name: 'phone', label: '휴대폰 번호', type: 'tel', attrs: 'required inputmode="numeric" autocomplete="tel" placeholder="010-1234-5678"' })}
      ${field({ name: 'pin', label: '비밀번호 (숫자 4~6자리)', type: 'password', attrs: `required inputmode="numeric" pattern="\\d{4,6}" maxlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"`, hint: reg ? '잊지 않을 숫자로 정해 주세요.' : '' })}
      ${reg ? field({ name: 'district', label: '구역 / 소속 (선택)', attrs: 'maxlength="30" placeholder="예: 3구역"' }) : ''}
      ${reg && state.cfg.joinCodeRequired ? field({ name: 'joinCode', label: '가입 코드', attrs: 'required autocomplete="off"', hint: '교회에서 안내받은 코드를 입력해 주세요.' }) : ''}
      <div class="actions"><button class="primary block" type="submit">${reg ? '가입하기' : '로그인'}</button></div>
    </form></main>`;
}

/* ───────── 화면: 주차 신청 ───────── */
function sessionCard(s) {
  const pct = s.capacity ? Math.min(100, Math.round((s.approved / s.capacity) * 100)) : 100;
  const full = s.approved >= s.capacity;
  const cls = full ? 'full' : pct >= 80 ? 'busy' : '';
  const open = state.openKey === s.key;
  let action = '';
  if (s.mine) {
    const m = s.mine;
    const extra = m.status === 'waitlist' && m.waitPos ? ` ${m.waitPos}번째` : '';
    action = `<div class="row" style="margin-top:12px"><div>${badge(m.status, extra)} <strong>${esc(m.plate)}</strong></div>
      <button class="small danger" data-act="req-cancel" data-id="${esc(m.id)}">신청 취소</button></div>
      ${m.status === 'pending' ? '<p class="hint">관리자가 확인하면 승인돼요.</p>' : ''}
      ${m.status === 'waitlist' ? '<p class="hint">자리가 나면 자동으로 승인돼요. 이 화면에서 확인해 주세요.</p>' : ''}`;
  } else if (s.closed) {
    action = '<p class="muted" style="margin-top:10px">신청이 마감되었어요.</p>';
  } else if (!open) {
    action = `<div class="actions"><button class="primary" data-act="req-open" data-key="${esc(s.key)}">${full && state.cfg.autoApprove ? '대기자로 신청' : '주차 신청'}</button></div>`;
  } else if (!state.vehicles.length) {
    action = `<p class="notice" style="margin-top:12px">먼저 차량을 등록해 주세요.</p>
      <div class="actions"><button class="primary" data-act="tab" data-v="cars">차량 등록하러 가기</button><button data-act="req-close">닫기</button></div>`;
  } else {
    action = `<form data-form="request" data-date="${esc(s.date)}" data-sid="${esc(s.serviceId)}" style="margin-top:8px">
      <label>어느 차로 오시나요?</label>
      ${state.vehicles.map((v, i) => `<div class="pick"><input type="radio" name="vehicleId" id="v-${esc(v.id)}" value="${esc(v.id)}" ${i === 0 ? 'checked' : ''}>
        <label for="v-${esc(v.id)}">${esc(v.plate)} <span class="muted">${esc([v.model, v.color].filter(Boolean).join(' · '))}</span></label></div>`).join('')}
      <label for="note-${esc(s.key)}">전달할 말씀 (선택)</label>
      <input id="note-${esc(s.key)}" name="note" maxlength="100" placeholder="예: 휠체어 이용, 가까운 곳 부탁드려요">
      ${full && state.cfg.autoApprove ? '<p class="hint">주차면이 모두 찼어요. 신청하시면 대기자로 등록되고, 자리가 나면 자동 승인돼요.</p>' : ''}
      <div class="actions"><button class="primary" type="submit">신청하기</button><button type="button" data-act="req-close">닫기</button></div></form>`;
  }
  return `<section class="card ${s.closed && !s.mine ? 'closed' : ''}">
    <div class="row"><h3>${esc(s.name)}</h3><span class="muted">${esc(s.time)}</span></div>
    <div class="meter ${cls}" role="img" aria-label="주차 ${s.approved}대 승인, 정원 ${s.capacity}대"><i style="width:${pct}%"></i></div>
    <div class="muted">승인 ${s.approved} / ${s.capacity}대${s.waitlist ? ` · 대기 ${s.waitlist}명` : ''}${full ? ' · <strong>만차</strong>' : ''}</div>
    ${action}</section>`;
}

function viewHome() {
  let html = `<h1 class="page-title">주차 신청</h1>`;
  if (state.cfg.notice) html += `<div class="notice">${esc(state.cfg.notice)}</div>`;
  if (!state.sessions.length) return html + '<div class="empty">신청할 수 있는 예배가 아직 없어요.</div>';
  let last = '';
  for (const s of state.sessions) {
    if (s.date !== last) { html += `<h2 class="day">${fmtDate(s.date)}</h2>`; last = s.date; }
    html += sessionCard(s);
  }
  return html;
}

/* ───────── 화면: 내 신청 ───────── */
function viewMine() {
  const today = todayKst();
  const up = state.requests.filter((r) => r.date >= today).reverse();
  const past = state.requests.filter((r) => r.date < today);
  const card = (r, canCancel) => `<div class="card"><div class="row"><h3>${fmtDate(r.date)} ${esc(r.serviceName)}</h3>${badge(r.status)}</div>
    <div class="muted">${esc(r.time)} · <strong>${esc(r.plate)}</strong>${r.note ? ` · ${esc(r.note)}` : ''}</div>
    ${r.adminNote ? `<div class="notice" style="margin:10px 0 0">관리자 메모: ${esc(r.adminNote)}</div>` : ''}
    ${canCancel && ['approved', 'pending', 'waitlist'].includes(r.status) ? `<div class="actions"><button class="small danger" data-act="req-cancel" data-id="${esc(r.id)}">신청 취소</button></div>` : ''}</div>`;
  return `<h1 class="page-title">내 신청</h1>
    <h2 class="day">다가오는 일정</h2>${up.length ? up.map((r) => card(r, true)).join('') : '<div class="empty">신청 내역이 없어요.</div>'}
    ${past.length ? `<h2 class="day">지난 신청</h2>${past.slice(0, 15).map((r) => card(r, false)).join('')}` : ''}`;
}

/* ───────── 화면: 내 차량 / 내 정보 ───────── */
function viewCars() {
  const u = state.user;
  return `<h1 class="page-title">내 차량</h1>
    ${state.vehicles.length ? state.vehicles.map((v) => `<div class="card row"><div><div class="plate">${esc(v.plate)}</div>
      <div class="muted">${esc([v.model, v.color].filter(Boolean).join(' · ') || '차종 미입력')}</div></div>
      <button class="small danger" data-act="car-remove" data-id="${esc(v.id)}" data-plate="${esc(v.plate)}">삭제</button></div>`).join('')
      : '<div class="empty">등록된 차량이 없어요. 아래에서 등록해 주세요.</div>'}
    <form class="card" data-form="car"><h3>차량 등록</h3>
      ${field({ name: 'plate', label: '차량번호', attrs: 'required maxlength="12" placeholder="예: 12가3456" autocomplete="off"' })}
      <div class="grid2"><div>${field({ name: 'model', label: '차종 (선택)', attrs: 'maxlength="30" placeholder="예: 쏘나타"' })}</div>
      <div>${field({ name: 'color', label: '색상 (선택)', attrs: 'maxlength="15" placeholder="예: 흰색"' })}</div></div>
      <div class="hint">차량이 길을 막을 때 연락드릴 수 있도록 안내 요원이 번호로 찾아볼 수 있어요.</div>
      <div class="actions"><button class="primary" type="submit">등록하기</button></div></form>
    <h2 class="day">내 정보</h2>
    <form class="card" data-form="profile"><div class="muted">휴대폰 ${esc(fmtPhone(u.phone))}</div>
      ${field({ name: 'name', label: '이름', value: u.name, attrs: 'required maxlength="20"' })}
      ${field({ name: 'district', label: '구역 / 소속', value: u.district, attrs: 'maxlength="30"' })}
      <div class="actions"><button type="submit">저장</button></div></form>
    <form class="card" data-form="pin"><h3>비밀번호 바꾸기</h3>
      ${field({ name: 'current', label: '현재 비밀번호', type: 'password', attrs: 'required inputmode="numeric" maxlength="6" autocomplete="current-password"' })}
      ${field({ name: 'next', label: '새 비밀번호 (숫자 4~6자리)', type: 'password', attrs: 'required inputmode="numeric" pattern="\\d{4,6}" maxlength="6" autocomplete="new-password"' })}
      <div class="actions"><button type="submit">바꾸기</button></div></form>
    <div class="actions"><button class="block" data-act="logout">로그아웃</button></div>`;
}

/* ───────── 화면: 관리자 ───────── */
function viewAdmin() {
  const tabs = [['day', '신청 현황'], ['search', '차량 찾기'], ['members', '교인'], ['settings', '설정']];
  const body = { day: adminDay, search: adminSearch, members: adminMembers, settings: adminSettings }[state.adminTab]();
  return `<h1 class="page-title">관리</h1>
    <div class="subtabs">${tabs.map(([k, l]) => `<button data-act="admin-tab" data-v="${k}" class="${state.adminTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>${body}`;
}

function adminDay() {
  const a = state.admin;
  const bar = `<div class="datebar"><button data-act="date-shift" data-n="-1" aria-label="전날">‹</button>
    <input type="date" value="${esc(a.date)}" data-change="date-set" aria-label="날짜">
    <button data-act="date-shift" data-n="1" aria-label="다음 날">›</button>
    <button data-act="date-next">다음 예배일</button><button data-act="print">🖨 인쇄</button></div>`;
  if (!a.day) return bar + '<p class="loading">불러오는 중…</p>';
  if (!a.day.sessions.length) return bar + `<div class="empty">${fmtDate(a.date)}에는 등록된 예배가 없어요.</div>`;
  return bar + a.day.sessions.map((s) => `<section class="card">
    <div class="row"><h3>${fmtDate(a.date)} ${esc(s.name)} <span class="muted">${esc(s.time)}</span></h3></div>
    <div style="margin:6px 0 10px"><span class="chip">승인 ${s.approved}/${s.capacity}</span>
      ${s.pending ? `<span class="chip star">승인 대기 ${s.pending}</span>` : ''}${s.waitlist ? `<span class="chip star">대기자 ${s.waitlist}</span>` : ''}
      ${s.reserved ? `<span class="chip">우선배정 ${s.reserved}면</span>` : ''}</div>
    ${s.requests.length ? s.requests.map(reqRow).join('') : '<p class="muted">아직 신청이 없어요.</p>'}</section>`).join('');
}

function reqRow(r) {
  const approveBtn = r.status !== 'approved' ? `<button class="small ok" data-act="set-status" data-id="${esc(r.id)}" data-v="approved">승인</button>` : '';
  const rejectBtn = !['rejected', 'cancelled'].includes(r.status) ? `<button class="small danger" data-act="set-status" data-id="${esc(r.id)}" data-v="rejected">거절</button>` : '';
  return `<div class="req" data-status="${esc(r.status)}">
    <div class="row"><span class="plate">${esc(r.plate)}</span>${badge(r.status)}</div>
    <div>${esc(r.name)}${r.priority ? ' <span class="chip star">우선배정</span>' : ''}${r.district ? ` <span class="chip">${esc(r.district)}</span>` : ''}
      · <a href="tel:${esc(r.phone)}">${esc(fmtPhone(r.phone))}</a></div>
    <div class="muted">${esc([r.model, r.color].filter(Boolean).join(' · '))}${r.note ? ` · 요청: ${esc(r.note)}` : ''}${r.adminNote ? ` · 메모: ${esc(r.adminNote)}` : ''}</div>
    ${approveBtn || rejectBtn ? `<div class="btns">${approveBtn}${rejectBtn}<button class="small" data-act="set-note" data-id="${esc(r.id)}" data-status="${esc(r.status)}" data-note="${esc(r.adminNote)}">메모</button></div>` : ''}</div>`;
}

function resultRows(list) {
  return list.map((x) => `<div class="person"><div class="row"><span class="plate">${esc(x.plate)}</span>
    <a class="btn small primary" href="tel:${esc(x.phone)}">📞 전화</a></div>
    <div>${esc(x.name)}${x.priority ? ' <span class="chip star">우선배정</span>' : ''}${x.district ? ` <span class="chip">${esc(x.district)}</span>` : ''} · ${esc(fmtPhone(x.phone))}</div>
    <div class="muted">${esc([x.model, x.color].filter(Boolean).join(' · ') || '차종 미입력')}</div></div>`).join('');
}

function adminSearch() {
  const s = state.admin.search;
  return `<form class="card" data-form="search"><label for="f-q">차량번호(뒤 4자리) · 이름 · 전화번호</label>
    <input id="f-q" name="q" value="${esc(state.admin.q)}" required minlength="2" autocomplete="off" placeholder="예: 3456">
    <div class="actions"><button class="primary" type="submit">찾기</button></div></form>
    ${s ? `<div class="card">${s.length ? resultRows(s) : '<p class="empty">찾는 차량이 없어요.</p>'}</div>` : ''}`;
}

function memberRows() {
  const q = state.admin.memberQ.trim().toLowerCase();
  const list = state.admin.members.filter((m) => !q || [m.name, m.phone, m.district, ...m.plates].join(' ').toLowerCase().includes(q));
  if (!list.length) return '<p class="empty">해당하는 교인이 없어요.</p>';
  return list.map((m) => `<div class="person"><div class="row"><strong>${esc(m.name)}</strong>
    <span>${m.role === 'admin' ? '<span class="chip star">관리자</span>' : ''}${m.priority ? '<span class="chip star">우선배정</span>' : ''}</span></div>
    <div class="muted">${esc(fmtPhone(m.phone))}${m.district ? ` · ${esc(m.district)}` : ''}</div>
    <div>${m.plates.length ? m.plates.map((p) => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="muted">등록 차량 없음</span>'}</div>
    <div class="btns" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      <button class="small" data-act="member-priority" data-id="${esc(m.id)}" data-v="${m.priority ? '0' : '1'}">${m.priority ? '우선배정 해제' : '우선배정 지정'}</button>
      <button class="small" data-act="member-role" data-id="${esc(m.id)}" data-v="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? '관리자 해제' : '관리자 지정'}</button>
      <button class="small" data-act="member-pin" data-id="${esc(m.id)}" data-name="${esc(m.name)}">비밀번호 초기화</button></div></div>`).join('');
}

function adminMembers() {
  return `<div class="card"><label for="memberQ">교인 찾기</label>
    <input id="memberQ" data-input="member-q" value="${esc(state.admin.memberQ)}" placeholder="이름, 번호, 구역, 차량번호" autocomplete="off">
    <p class="hint">우선배정은 장애인·노약자 등 가까운 주차면을 먼저 드려야 하는 분께 지정해요. (총 ${state.admin.members.length}명)</p></div>
    <div class="card" id="memberList">${memberRows()}</div>`;
}

const SETTING_LABEL = { churchName: '교회 이름', joinCode: '가입 코드', autoApprove: '승인 방식', horizonDays: '며칠 앞까지 신청 받기', cutoffHours: '신청 마감 (예배 몇 시간 전)', maxVehicles: '교인당 등록 가능 차량 수', notice: '신청 화면 안내문' };

function adminSettings() {
  const st = Object.fromEntries(state.admin.settings.map((x) => [x.key, x.value]));
  const num = (k, min, max) => field({ name: k, label: SETTING_LABEL[k], type: 'number', value: st[k], attrs: `min="${min}" max="${max}" inputmode="numeric" required` });
  const svc = (s) => `<form class="svc-form" data-form="service" data-id="${esc(s.id || '')}">
    ${field({ name: 'name', label: '예배 이름', value: s.name, attrs: 'required maxlength="30"' })}
    <div class="grid2"><div><label>요일</label><select name="dayOfWeek">${DOW.map((d, i) => `<option value="${i}" ${String(s.dayOfWeek) === String(i) ? 'selected' : ''}>${d}요일</option>`).join('')}</select></div>
      <div>${field({ name: 'time', label: '시작 시간', type: 'time', value: s.time, attrs: 'required' })}</div></div>
    <div class="grid2"><div>${field({ name: 'capacity', label: '주차 가능 대수', type: 'number', value: s.capacity, attrs: 'min="0" required inputmode="numeric"' })}</div>
      <div>${field({ name: 'reserved', label: '우선배정 전용 면수', type: 'number', value: s.reserved, attrs: 'min="0" required inputmode="numeric"' })}</div></div>
    ${field({ name: 'date', label: '특정 날짜에만 (선택)', type: 'date', value: s.date, attrs: '', hint: '날짜를 고르면 요일 대신 그날 하루만 열려요. (예: 부활절, 특별집회)' })}
    <div class="check"><input type="checkbox" name="active" id="a-${esc(s.id || 'new')}" ${s.active ? 'checked' : ''}><label for="a-${esc(s.id || 'new')}">신청 받기</label></div>
    <div class="actions"><button class="primary" type="submit">${s.id ? '저장' : '예배 추가'}</button></div></form>`;
  return `<form class="card" data-form="settings"><h3>기본 설정</h3>
    ${field({ name: 'churchName', label: SETTING_LABEL.churchName, value: st.churchName, attrs: 'required maxlength="30"' })}
    ${field({ name: 'joinCode', label: SETTING_LABEL.joinCode, value: st.joinCode, attrs: 'maxlength="30" autocomplete="off"', hint: '비워 두면 누구나 가입할 수 있어요. 교인에게만 알려 주세요.' })}
    <label for="f-autoApprove">${SETTING_LABEL.autoApprove}</label><select id="f-autoApprove" name="autoApprove">
      <option value="TRUE" ${st.autoApprove === 'TRUE' ? 'selected' : ''}>자동 승인 (자리가 있으면 바로 승인)</option>
      <option value="FALSE" ${st.autoApprove === 'FALSE' ? 'selected' : ''}>관리자가 직접 승인</option></select>
    ${num('horizonDays', 1, 60)}${num('cutoffHours', 0, 72)}${num('maxVehicles', 1, 10)}
    <label for="f-notice">${SETTING_LABEL.notice}</label><textarea id="f-notice" name="notice" maxlength="300">${esc(st.notice)}</textarea>
    <div class="actions"><button class="primary" type="submit">설정 저장</button></div></form>
    <section class="card"><h3>예배 · 주차 대수</h3><p class="hint">예배마다 주차 가능 대수를 정해요. 늘리면 대기자가 자동으로 승인돼요.</p>
      ${state.admin.services.map(svc).join('')}
      <h3 style="margin-top:22px">+ 새 예배 추가</h3>${svc({ id: '', name: '', dayOfWeek: 0, time: '', capacity: 30, reserved: 0, date: '', active: true })}</section>`;
}

/* ───────── 그리기 ───────── */
function render() {
  if (!window.APP_CONFIG?.API_URL) {
    $app.innerHTML = `<main class="card" style="margin-top:40px"><h2>아직 연결이 안 됐어요</h2>
      <p>docs/config.js 파일의 <code>API_URL</code>에 구글 Apps Script 웹 앱 주소를 넣어 주세요. 방법은 README.md에 있어요.</p></main>`;
    return;
  }
  if (!state.cfg) { $app.innerHTML = '<p class="loading">불러오는 중…</p>'; return; }
  if (!state.user) { $app.innerHTML = viewAuth(); return; }
  const views = { home: viewHome, mine: viewMine, cars: viewCars, admin: viewAdmin };
  // 데이터가 도착하기 전에 입력창을 그리면, 도착 후 다시 그릴 때 입력한 글자가 사라져요. 그래서 기다리는 동안은 안내만 보여줘요.
  $app.innerHTML = shell(state.loading ? '<p class="loading">불러오는 중…</p>' : (views[state.tab] || viewHome)());
}

/* ───────── 데이터 불러오기 ───────── */
const loadSlots = async () => { state.sessions = (await api('slots')).sessions; };
const loadMe = async () => { const d = await api('me'); Object.assign(state, { user: d.user, vehicles: d.vehicles, requests: d.requests }); };
async function loadAdminDay() {
  const a = state.admin;
  a.day = null; render();
  a.day = await api('admin.requests', { date: a.date });
  render();
}
async function loadAdminTab() {
  const a = state.admin;
  if (state.adminTab === 'day') {
    if (!a.date) a.date = state.sessions.find((s) => s.date >= todayKst())?.date || todayKst();
    await loadAdminDay();
  } else if (state.adminTab === 'members') a.members = (await api('admin.members')).members;
  else if (state.adminTab === 'settings') {
    [a.settings, a.services] = await Promise.all([api('admin.settings').then((d) => d.settings), api('admin.services').then((d) => d.services)]);
  }
}
async function go(tab) {
  state.tab = tab; state.openKey = null; state.loading = true;
  render(); window.scrollTo(0, 0);
  await run(async () => {
    if (tab === 'home') await loadSlots();
    else if (tab === 'mine' || tab === 'cars') await loadMe();
    else if (tab === 'admin') { if (!state.sessions.length) await loadSlots(); state.loading = false; await loadAdminTab(); }
  });
  state.loading = false;
  if (state.user) render();
}

/* ───────── 클릭 동작 ───────── */
const actions = {
  'auth-mode': (el) => { state.authMode = el.dataset.v; render(); },
  'tab': (el) => go(el.dataset.v),
  'logout': () => logout(),
  'req-open': (el) => { state.openKey = el.dataset.key; render(); },
  'req-close': () => { state.openKey = null; render(); },
  'req-cancel': (el) => confirm('이 주차 신청을 취소할까요?') && run(async () => {
    await api('request.cancel', { id: el.dataset.id });
    toast('신청을 취소했어요.');
    await Promise.all([loadSlots(), loadMe()]); render();
  }),
  'car-remove': (el) => confirm(`${el.dataset.plate} 차량을 삭제할까요?\n이 차량으로 한 앞으로의 신청도 함께 취소돼요.`) && run(async () => {
    await api('vehicle.remove', { id: el.dataset.id });
    toast('삭제했어요.'); await loadMe(); render();
  }),
  'admin-tab': (el) => { state.adminTab = el.dataset.v; render(); run(async () => { await loadAdminTab(); render(); }); },
  'date-shift': (el) => { state.admin.date = addDays(state.admin.date, Number(el.dataset.n)); run(loadAdminDay); },
  'date-next': () => { state.admin.date = state.sessions.find((s) => s.date >= todayKst())?.date || todayKst(); run(loadAdminDay); },
  'print': () => window.print(),
  'set-status': (el) => run(async () => {
    await api('admin.setStatus', { id: el.dataset.id, status: el.dataset.v });
    toast('변경했어요.'); await loadAdminDay();
  }),
  'set-note': (el) => {
    const note = prompt('교인에게 보여줄 메모를 적어 주세요. (예: 2층 주차장 B구역)', el.dataset.note);
    if (note === null) return;
    run(async () => { await api('admin.setStatus', { id: el.dataset.id, status: el.dataset.status, adminNote: note }); toast('메모를 저장했어요.'); await loadAdminDay(); });
  },
  'member-priority': (el) => run(async () => { await api('admin.updateMember', { id: el.dataset.id, priority: el.dataset.v === '1' }); await loadAdminTab(); render(); }),
  'member-role': (el) => confirm(el.dataset.v === 'admin' ? '관리자로 지정할까요?' : '관리자에서 해제할까요?') && run(async () => { await api('admin.updateMember', { id: el.dataset.id, role: el.dataset.v }); await loadAdminTab(); render(); }),
  'member-pin': (el) => {
    const pin = prompt(`${el.dataset.name} 님의 새 비밀번호(숫자 4~6자리)를 입력해 주세요.`);
    if (pin === null) return;
    run(async () => { await api('admin.resetPin', { id: el.dataset.id, pin }); toast('비밀번호를 바꿨어요. 본인께 알려 주세요.'); });
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.change === 'date-set' && e.target.value) { state.admin.date = e.target.value; run(loadAdminDay); }
});
document.addEventListener('input', (e) => {
  if (e.target.dataset.input === 'member-q') { state.admin.memberQ = e.target.value; document.getElementById('memberList').innerHTML = memberRows(); }
});

/* ───────── 폼 제출 ───────── */
const forms = {
  async login(d) {
    const r = await api('login', d); startSession(r);
    await afterLogin();
  },
  async register(d) {
    const r = await api('register', d); startSession(r);
    toast(r.user.role === 'admin' ? '가입 완료! 첫 가입자라 관리자로 등록됐어요.' : '가입을 환영해요!');
    await afterLogin();
  },
  async request(d, f) {
    const r = await api('request.create', { date: f.dataset.date, serviceId: f.dataset.sid, vehicleId: d.vehicleId, note: d.note });
    toast({ approved: '주차가 승인되었어요 🙏', pending: '신청했어요. 관리자 승인을 기다려 주세요.', waitlist: `대기자로 등록했어요${r.waitPos ? ` (${r.waitPos}번째)` : ''}.` }[r.status]);
    state.openKey = null; await loadSlots(); render();
  },
  async car(d, f) { await api('vehicle.add', d); toast('차량을 등록했어요.'); f.reset(); await loadMe(); render(); },
  async profile(d) { const r = await api('profile.update', d); state.user = r.user; toast('저장했어요.'); render(); },
  async pin(d, f) { await api('pin.change', d); toast('비밀번호를 바꿨어요.'); f.reset(); },
  async search(d) { state.admin.q = d.q; state.admin.search = (await api('admin.search', d)).results; render(); },
  async settings(d) { await api('admin.saveSettings', { values: d }); state.cfg = await api('config'); toast('설정을 저장했어요.'); await loadAdminTab(); render(); },
  async service(d, f) {
    await api('admin.saveService', { ...d, id: f.dataset.id, active: f.elements.active.checked });
    toast('예배 설정을 저장했어요.'); await Promise.all([loadAdminTab(), loadSlots()]); render();
  },
};

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const btn = e.submitter || f.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  await run(() => forms[f.dataset.form](Object.fromEntries(new FormData(f)), f));
  if (btn) btn.disabled = false;
});

function startSession(r) { state.token = r.token; state.user = r.user; store.set('token', r.token); }
async function afterLogin() {
  state.tab = 'home';
  await Promise.all([loadSlots(), loadMe()]);
  render();
}

/* ───────── 시작 ───────── */
(async function boot() {
  render();
  if (!window.APP_CONFIG?.API_URL) return;
  await run(async () => {
    state.cfg = await api('config');
    if (state.token) {
      try { await Promise.all([loadMe(), loadSlots()]); } catch (e) { if (e.code === 'AUTH') { store.del('token'); state.token = null; } else throw e; }
    }
    render();
  });
  if (!state.cfg) $app.innerHTML = '<main class="card" style="margin-top:40px"><h2>연결할 수 없어요</h2><p>인터넷 연결을 확인하고 새로고침해 주세요.</p><button class="primary" onclick="location.reload()">다시 시도</button></main>';
})();
