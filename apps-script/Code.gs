/**
 * 서울제일교회 주차관리 · 백엔드 (Google Apps Script)
 *
 * - 구글 시트에 "컨테이너 바운드"로 붙여서 사용합니다.
 * - 웹 앱으로 배포하면 docs/ 폴더의 화면(GitHub Pages)이 이 주소로 요청을 보냅니다.
 * - 시트 탭(교인/차량/신청/예배/설정)은 처음 요청이 올 때 자동으로 만들어집니다.
 */

var TZ = 'Asia/Seoul';
var KST_MS = 9 * 60 * 60 * 1000;
var LOGIN_DAYS = 30;
var TAIL_ROWS = 4000; // 신청 시트에서 최근 몇 줄만 읽을지 (속도 유지용)
var ACTIVE_STATUSES = ['approved', 'pending', 'waitlist'];
var ALL_STATUSES = ['approved', 'pending', 'waitlist', 'rejected', 'cancelled'];

var TABS = { Members: '교인', Vehicles: '차량', Requests: '신청', Services: '예배', Settings: '설정' };

var SCHEMA = {
  Members: ['id', 'name', 'phone', 'pinHash', 'salt', 'role', 'district', 'priority', 'createdAt'],
  Vehicles: ['id', 'memberId', 'plate', 'model', 'color', 'active', 'createdAt'],
  Requests: ['id', 'date', 'serviceId', 'memberId', 'vehicleId', 'plate', 'name', 'phone',
    'status', 'note', 'adminNote', 'createdAt', 'updatedAt'],
  Services: ['id', 'name', 'dayOfWeek', 'time', 'capacity', 'reserved', 'date', 'active'],
  Settings: ['key', 'value', 'description']
};

var SETTING_DEFS = [
  ['churchName', '서울제일교회', '교회 이름'],
  ['joinCode', '', '가입 코드. 비워 두면 누구나 가입할 수 있어요. 교인에게만 알려 주세요.'],
  ['autoApprove', 'TRUE', 'TRUE: 주차면이 남아 있으면 자동 승인 / FALSE: 관리자가 직접 승인'],
  ['horizonDays', '14', '오늘부터 며칠 앞까지 신청을 받을지'],
  ['cutoffHours', '2', '예배 시작 몇 시간 전에 신청을 마감할지'],
  ['maxVehicles', '3', '교인 한 명이 등록할 수 있는 차량 수'],
  ['notice', '', '신청 화면 맨 위에 보여줄 안내문']
];

// 예시 값입니다. 앱의 [관리 > 설정]이나 시트의 "예배" 탭에서 고치세요.
var SERVICE_SEEDS = [
  ['svc-sun1', '주일 1부예배', '0', '09:00', '30', '0', '', 'TRUE'],
  ['svc-sun2', '주일 2부예배', '0', '11:00', '30', '0', '', 'TRUE'],
  ['svc-wed', '수요예배', '3', '19:30', '20', '0', '', 'TRUE']
];

/* ───────────────────────── 진입점 ───────────────────────── */

function doGet() {
  return ContentService.createTextOutput('서울제일교회 주차관리 API 정상 작동 중입니다.');
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = { ok: true, data: handle_(req) };
  } catch (err) {
    if (err && err.user) {
      out = { ok: false, error: err.message, code: err.code };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, error: '처리 중 문제가 생겼어요. 잠시 뒤에 다시 해 주세요.', code: 'SERVER' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 편집기에서 한 번 실행하면 시트 탭을 미리 만들어 줍니다. */
function setup() {
  ensureSheets_();
}

var ACTIONS = {
  'config': { fn: config_, auth: 'none' },
  'register': { fn: register_, auth: 'none', write: true },
  'login': { fn: login_, auth: 'none' },
  'me': { fn: me_, auth: 'user' },
  'slots': { fn: slots_, auth: 'user' },
  'profile.update': { fn: profileUpdate_, auth: 'user', write: true },
  'pin.change': { fn: pinChange_, auth: 'user', write: true },
  'vehicle.add': { fn: vehicleAdd_, auth: 'user', write: true },
  'vehicle.remove': { fn: vehicleRemove_, auth: 'user', write: true },
  'request.create': { fn: requestCreate_, auth: 'user', write: true },
  'request.cancel': { fn: requestCancel_, auth: 'user', write: true },
  'admin.requests': { fn: adminRequests_, auth: 'admin' },
  'admin.setStatus': { fn: adminSetStatus_, auth: 'admin', write: true },
  'admin.search': { fn: adminSearch_, auth: 'admin' },
  'admin.members': { fn: adminMembers_, auth: 'admin' },
  'admin.updateMember': { fn: adminUpdateMember_, auth: 'admin', write: true },
  'admin.resetPin': { fn: adminResetPin_, auth: 'admin', write: true },
  'admin.settings': { fn: adminSettings_, auth: 'admin' },
  'admin.saveSettings': { fn: adminSaveSettings_, auth: 'admin', write: true },
  'admin.services': { fn: adminServices_, auth: 'admin' },
  'admin.saveService': { fn: adminSaveService_, auth: 'admin', write: true }
};

function handle_(req) {
  var a = ACTIONS[req.action];
  if (!a) fail_('알 수 없는 요청이에요.');
  ensureSheets_();
  var user = null;
  if (a.auth !== 'none') {
    user = authUser_(req.token);
    if (a.auth === 'admin' && user.role !== 'admin') fail_('관리자만 사용할 수 있어요.', 'FORBIDDEN');
  }
  if (!a.write) return a.fn(req, user);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return a.fn(req, user);
  } finally {
    lock.releaseLock();
  }
}

function fail_(msg, code) {
  var e = new Error(msg);
  e.user = true;
  e.code = code || 'ERR';
  throw e;
}

/* ───────────────────────── 값 변환 도우미 ───────────────────────── */

function s_(v) { return v == null ? '' : String(v).trim(); }
function bool_(v) { return v === true || String(v).trim().toUpperCase() === 'TRUE'; }
function num_(v, d) {
  var t = s_(v);
  if (t === '') return d;
  var n = Number(t);
  return isFinite(n) ? n : d;
}
function digits_(v) { return s_(v).replace(/\D/g, ''); }
function dateS_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return s_(v);
}
function timeS_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  var t = s_(v);
  var m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : t;
}
function newId_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

/* 시간 (모두 한국 시간 기준) */
function nowMs_() { return Date.now(); }
function kstStamp_(ms) { return new Date(ms + KST_MS).toISOString().slice(0, 19).replace('T', ' '); }
function todayKst_() { return kstStamp_(nowMs_()).slice(0, 10); }
function addDays_(date, n) {
  var d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dow_(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
function startMs_(date, time) { return new Date(date + 'T' + (time || '00:00') + ':00+09:00').getTime(); }
function isDate_(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + 'T00:00:00Z').getTime()); }

/* ───────────────────────── 시트 읽기/쓰기 ───────────────────────── */

var _ss = null;
var _ready = false;

function ss_() { return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet()); }

function ensureSheets_() {
  if (_ready) return;
  Object.keys(SCHEMA).forEach(function (key) {
    if (ss_().getSheetByName(TABS[key])) return;
    var sh = ss_().insertSheet(TABS[key]);
    var cols = SCHEMA[key].length;
    sh.getRange(1, 1, sh.getMaxRows(), cols).setNumberFormat('@'); // 전부 글자로 저장 (전화번호 0 보존)
    sh.getRange(1, 1, 1, cols).setValues([SCHEMA[key]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (key === 'Settings') {
      SETTING_DEFS.forEach(function (d) { appendRow_(key, { key: d[0], value: d[1], description: d[2] }); });
    }
    if (key === 'Services') {
      SERVICE_SEEDS.forEach(function (r) {
        appendRow_(key, { id: r[0], name: r[1], dayOfWeek: r[2], time: r[3], capacity: r[4],
          reserved: r[5], date: r[6], active: r[7] });
      });
    }
  });
  _ready = true;
}

function sheet_(key) { return ss_().getSheetByName(TABS[key]); }

/** tail: 마지막 몇 줄만 읽기 (생략하면 전부) */
function readAll_(key, tail) {
  var sh = sheet_(key), cols = SCHEMA[key].length, last = sh.getLastRow();
  if (last < 2) return [];
  var first = 2;
  if (tail && last - 1 > tail) first = last - tail + 1;
  var vals = sh.getRange(first, 1, last - first + 1, cols).getValues();
  return vals.map(function (row, i) {
    var o = { _row: first + i };
    SCHEMA[key].forEach(function (k, j) { o[k] = row[j]; });
    return o;
  });
}

function toRow_(key, obj) {
  return SCHEMA[key].map(function (k) {
    var v = obj[k];
    if (v === true) return 'TRUE';
    if (v === false) return 'FALSE';
    return v == null ? '' : String(v);
  });
}

function appendRow_(key, obj) {
  var sh = sheet_(key), r = sh.getLastRow() + 1;
  var rg = sh.getRange(r, 1, 1, SCHEMA[key].length);
  rg.setNumberFormat('@');
  rg.setValues([toRow_(key, obj)]);
  obj._row = r;
}

function updateRow_(key, row, patch) {
  var sh = sheet_(key), cols = SCHEMA[key].length;
  var rg = sh.getRange(row, 1, 1, cols);
  var cur = rg.getValues()[0], obj = {};
  SCHEMA[key].forEach(function (k, j) { obj[k] = cur[j]; });
  Object.keys(patch).forEach(function (k) { obj[k] = patch[k]; });
  rg.setNumberFormat('@');
  rg.setValues([toRow_(key, obj)]);
}

function readSettings_() {
  var st = {};
  SETTING_DEFS.forEach(function (d) { st[d[0]] = d[1]; });
  readAll_('Settings').forEach(function (r) {
    if (s_(r.key)) st[s_(r.key)] = s_(r.value);
  });
  return st;
}

function readMembers_() {
  return readAll_('Members').map(function (r) {
    return { _row: r._row, id: s_(r.id), name: s_(r.name), phone: digits_(r.phone), pinHash: s_(r.pinHash),
      salt: s_(r.salt), role: s_(r.role) === 'admin' ? 'admin' : 'member', district: s_(r.district),
      priority: bool_(r.priority), createdAt: s_(r.createdAt) };
  }).filter(function (m) { return m.id; });
}

function readVehicles_() {
  return readAll_('Vehicles').map(function (r) {
    return { _row: r._row, id: s_(r.id), memberId: s_(r.memberId), plate: s_(r.plate), model: s_(r.model),
      color: s_(r.color), active: bool_(r.active), createdAt: s_(r.createdAt) };
  }).filter(function (v) { return v.id; });
}

function readRequests_(all) {
  return readAll_('Requests', all ? 0 : TAIL_ROWS).map(function (r) {
    return { _row: r._row, id: s_(r.id), date: dateS_(r.date), serviceId: s_(r.serviceId), memberId: s_(r.memberId),
      vehicleId: s_(r.vehicleId), plate: s_(r.plate), name: s_(r.name), phone: digits_(r.phone), status: s_(r.status),
      note: s_(r.note), adminNote: s_(r.adminNote), createdAt: s_(r.createdAt), updatedAt: s_(r.updatedAt) };
  }).filter(function (r) { return r.id; });
}

function readServices_() {
  return readAll_('Services').map(function (r) {
    var dw = s_(r.dayOfWeek);
    return { _row: r._row, id: s_(r.id), name: s_(r.name), dayOfWeek: dw === '' ? -1 : num_(dw, -1),
      time: timeS_(r.time), capacity: num_(r.capacity, 0), reserved: num_(r.reserved, 0),
      date: dateS_(r.date), active: bool_(r.active) };
  }).filter(function (s) { return s.id; });
}

/* ───────────────────────── 로그인 / 인증 ───────────────────────── */

function hex_(bytes) {
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}
function hashPin_(pin, salt) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8));
}
function secret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('TOKEN_SECRET', s);
  }
  return s;
}
function sign_(msg) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret_())); }
function makeToken_(uid) {
  var body = uid + '.' + (nowMs_() + LOGIN_DAYS * 86400000);
  return body + '.' + sign_(body);
}
function authUser_(token) {
  var p = String(token || '').split('.');
  if (p.length !== 3 || sign_(p[0] + '.' + p[1]) !== p[2] || Number(p[1]) < nowMs_()) {
    fail_('다시 로그인해 주세요.', 'AUTH');
  }
  var m = readMembers_().filter(function (x) { return x.id === p[0]; })[0];
  if (!m) fail_('다시 로그인해 주세요.', 'AUTH');
  return m;
}
function userOut_(m) {
  return { id: m.id, name: m.name, phone: m.phone, role: m.role, district: m.district, priority: m.priority };
}

function checkPin_(pin) {
  if (!/^\d{4,6}$/.test(pin)) fail_('비밀번호는 숫자 4~6자리로 정해 주세요.');
}

function throttleCheck_(phone) {
  if (Number(CacheService.getScriptCache().get('fail_' + phone) || 0) >= 5) {
    fail_('로그인을 여러 번 틀렸어요. 10분 뒤에 다시 해 주세요.', 'LOCKED');
  }
}
function throttleFail_(phone) {
  var c = CacheService.getScriptCache();
  c.put('fail_' + phone, String(Number(c.get('fail_' + phone) || 0) + 1), 600);
}

function config_() {
  var st = readSettings_();
  return {
    churchName: st.churchName || '교회', notice: st.notice, joinCodeRequired: !!st.joinCode,
    autoApprove: bool_(st.autoApprove), horizonDays: num_(st.horizonDays, 14),
    cutoffHours: num_(st.cutoffHours, 2), maxVehicles: num_(st.maxVehicles, 3)
  };
}

function register_(req) {
  var name = s_(req.name), phone = digits_(req.phone), pin = s_(req.pin), district = s_(req.district).slice(0, 30);
  if (name.length < 2 || name.length > 20) fail_('이름을 2~20자로 적어 주세요.');
  if (!/^01\d{8,9}$/.test(phone)) fail_('휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)');
  checkPin_(pin);
  var st = readSettings_();
  if (st.joinCode && s_(req.joinCode).toLowerCase() !== st.joinCode.toLowerCase()) {
    fail_('가입 코드가 맞지 않아요. 교회에서 안내받은 코드를 확인해 주세요.');
  }
  var members = readMembers_();
  if (members.some(function (m) { return m.phone === phone; })) fail_('이미 가입된 번호예요. 로그인해 주세요.');
  var salt = Utilities.getUuid();
  var m = { id: newId_('m'), name: name, phone: phone, pinHash: hashPin_(pin, salt), salt: salt,
    role: members.length === 0 ? 'admin' : 'member', // 맨 처음 가입한 사람이 관리자
    district: district, priority: false, createdAt: kstStamp_(nowMs_()) };
  appendRow_('Members', m);
  return { token: makeToken_(m.id), user: userOut_(m) };
}

function login_(req) {
  var phone = digits_(req.phone), pin = s_(req.pin);
  throttleCheck_(phone);
  var m = readMembers_().filter(function (x) { return x.phone === phone; })[0];
  if (!m || hashPin_(pin, m.salt) !== m.pinHash) {
    throttleFail_(phone);
    fail_('번호 또는 비밀번호가 맞지 않아요.');
  }
  CacheService.getScriptCache().remove('fail_' + phone);
  return { token: makeToken_(m.id), user: userOut_(m) };
}

function profileUpdate_(req, user) {
  var name = s_(req.name), district = s_(req.district).slice(0, 30);
  if (name.length < 2 || name.length > 20) fail_('이름을 2~20자로 적어 주세요.');
  updateRow_('Members', user._row, { name: name, district: district });
  user.name = name;
  user.district = district;
  return { user: userOut_(user) };
}

function pinChange_(req, user) {
  var cur = s_(req.current), next = s_(req.next);
  if (hashPin_(cur, user.salt) !== user.pinHash) fail_('현재 비밀번호가 맞지 않아요.');
  checkPin_(next);
  updateRow_('Members', user._row, { pinHash: hashPin_(next, user.salt) });
  return {};
}

/* ───────────────────────── 예배 일정(세션) 계산 ───────────────────────── */

function sessionsOnDate_(date, services, st) {
  var dw = dow_(date), cutoff = num_(st.cutoffHours, 2) * 3600000, now = nowMs_();
  return services
    .filter(function (s) { return s.active && (s.date ? s.date === date : s.dayOfWeek === dw); })
    .sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; })
    .map(function (s) {
      var start = startMs_(date, s.time);
      return { key: date + '|' + s.id, date: date, dow: dw, serviceId: s.id, name: s.name, time: s.time,
        capacity: s.capacity, reserved: s.reserved, closed: now > start - cutoff, started: now >= start };
    });
}

function upcomingSessions_(services, st) {
  var today = todayKst_(), n = num_(st.horizonDays, 14), out = [];
  for (var i = 0; i < n; i++) out = out.concat(sessionsOnDate_(addDays_(today, i), services, st));
  return out;
}

function countsFor_(requests, membersById, date, serviceId) {
  var c = { approved: 0, approvedGeneral: 0, pending: 0, waitlist: 0 };
  requests.forEach(function (r) {
    if (r.date !== date || r.serviceId !== serviceId) return;
    if (r.status === 'approved') {
      c.approved++;
      var m = membersById[r.memberId];
      if (!(m && m.priority)) c.approvedGeneral++;
    } else if (r.status === 'pending') c.pending++;
    else if (r.status === 'waitlist') c.waitlist++;
  });
  return c;
}

/** 자동 승인 규칙: 정원이 남아 있고, 일반 교인은 우선배정 전용 면수를 제외한 만큼만 */
function autoStatus_(sess, counts, priority) {
  if (counts.approved >= sess.capacity) return 'waitlist';
  if (!priority && counts.approvedGeneral >= sess.capacity - sess.reserved) return 'waitlist';
  return 'approved';
}

function byId_(list) {
  var o = {};
  list.forEach(function (x) { o[x.id] = x; });
  return o;
}

function waitlistOrder_(requests, membersById, date, serviceId) {
  return requests.filter(function (r) { return r.date === date && r.serviceId === serviceId && r.status === 'waitlist'; })
    .sort(function (a, b) {
      var pa = membersById[a.memberId] && membersById[a.memberId].priority ? 0 : 1;
      var pb = membersById[b.memberId] && membersById[b.memberId].priority ? 0 : 1;
      return pa - pb || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
    });
}

/** 자리가 났을 때 대기자를 순서대로 승인합니다. (자동 승인 모드일 때만) */
function promote_(date, serviceId) {
  var st = readSettings_();
  if (!bool_(st.autoApprove)) return;
  var svc = readServices_().filter(function (s) { return s.id === serviceId; })[0];
  if (!svc) return;
  var sess = { capacity: svc.capacity, reserved: svc.reserved };
  var membersById = byId_(readMembers_()), reqs = readRequests_(true);
  waitlistOrder_(reqs, membersById, date, serviceId).forEach(function (r) {
    var m = membersById[r.memberId];
    if (autoStatus_(sess, countsFor_(reqs, membersById, date, serviceId), !!(m && m.priority)) === 'approved') {
      r.status = 'approved';
      updateRow_('Requests', r._row, { status: 'approved', updatedAt: kstStamp_(nowMs_()) });
    }
  });
}

/* ───────────────────────── 교인: 일정·신청·차량 ───────────────────────── */

function slots_(req, user) {
  var st = readSettings_(), services = readServices_();
  var membersById = byId_(readMembers_()), reqs = readRequests_();
  return {
    sessions: upcomingSessions_(services, st).map(function (s) {
      var c = countsFor_(reqs, membersById, s.date, s.serviceId);
      var mine = reqs.filter(function (r) {
        return r.date === s.date && r.serviceId === s.serviceId && r.memberId === user.id && ACTIVE_STATUSES.indexOf(r.status) >= 0;
      })[0];
      var out = { key: s.key, date: s.date, dow: s.dow, serviceId: s.serviceId, name: s.name, time: s.time,
        capacity: s.capacity, approved: c.approved, waitlist: c.waitlist, closed: s.closed, mine: null };
      if (mine) {
        out.mine = { id: mine.id, status: mine.status, plate: mine.plate, note: mine.note };
        if (mine.status === 'waitlist') {
          out.mine.waitPos = waitlistOrder_(reqs, membersById, s.date, s.serviceId)
            .map(function (r) { return r.id; }).indexOf(mine.id) + 1;
        }
      }
      return out;
    })
  };
}

function me_(req, user) {
  var servicesById = byId_(readServices_());
  var vehicles = readVehicles_().filter(function (v) { return v.memberId === user.id && v.active; })
    .map(function (v) { return { id: v.id, plate: v.plate, model: v.model, color: v.color }; });
  var requests = readRequests_().filter(function (r) { return r.memberId === user.id; })
    .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1); })
    .slice(0, 60)
    .map(function (r) {
      var sv = servicesById[r.serviceId];
      return { id: r.id, date: r.date, serviceName: sv ? sv.name : r.serviceId, time: sv ? sv.time : '',
        plate: r.plate, status: r.status, note: r.note, adminNote: r.adminNote };
    });
  return { user: userOut_(user), vehicles: vehicles, requests: requests };
}

var PLATE_RE = /^([가-힣]{2})?\d{2,3}[가-힣]\d{4}$/;

function vehicleAdd_(req, user) {
  var plate = s_(req.plate).replace(/[\s-]/g, '');
  if (!PLATE_RE.test(plate)) fail_('차량번호를 확인해 주세요. (예: 12가3456, 123나4567)');
  var mine = readVehicles_().filter(function (v) { return v.memberId === user.id && v.active; });
  var max = num_(readSettings_().maxVehicles, 3);
  if (mine.length >= max) fail_('차량은 최대 ' + max + '대까지 등록할 수 있어요.');
  if (mine.some(function (v) { return v.plate === plate; })) fail_('이미 등록된 차량번호예요.');
  var v = { id: newId_('v'), memberId: user.id, plate: plate, model: s_(req.model).slice(0, 30),
    color: s_(req.color).slice(0, 15), active: true, createdAt: kstStamp_(nowMs_()) };
  appendRow_('Vehicles', v);
  return { vehicle: { id: v.id, plate: v.plate, model: v.model, color: v.color } };
}

function cancelRequest_(r, newStatus) {
  updateRow_('Requests', r._row, { status: newStatus, updatedAt: kstStamp_(nowMs_()) });
  r.status = newStatus;
  promote_(r.date, r.serviceId);
}

function vehicleRemove_(req, user) {
  var v = readVehicles_().filter(function (x) { return x.id === s_(req.id) && x.memberId === user.id && x.active; })[0];
  if (!v) fail_('차량을 찾을 수 없어요.');
  updateRow_('Vehicles', v._row, { active: false });
  var today = todayKst_();
  readRequests_().forEach(function (r) {
    if (r.vehicleId === v.id && r.date >= today && ACTIVE_STATUSES.indexOf(r.status) >= 0) cancelRequest_(r, 'cancelled');
  });
  return {};
}

function requestCreate_(req, user) {
  var date = s_(req.date), sid = s_(req.serviceId);
  var st = readSettings_();
  var sess = upcomingSessions_(readServices_(), st).filter(function (s) { return s.date === date && s.serviceId === sid; })[0];
  if (!sess) fail_('신청할 수 없는 예배예요.');
  if (sess.closed) fail_('신청이 마감되었어요.');
  var vehicle = readVehicles_().filter(function (v) { return v.id === s_(req.vehicleId) && v.memberId === user.id && v.active; })[0];
  if (!vehicle) fail_('차량을 선택해 주세요.');
  var membersById = byId_(readMembers_()), reqs = readRequests_();
  var dup = reqs.some(function (r) {
    return r.date === date && r.serviceId === sid && ACTIVE_STATUSES.indexOf(r.status) >= 0 &&
      (r.memberId === user.id || r.vehicleId === vehicle.id);
  });
  if (dup) fail_('이미 이 예배에 신청하셨어요.');
  var status = bool_(st.autoApprove)
    ? autoStatus_(sess, countsFor_(reqs, membersById, date, sid), user.priority) : 'pending';
  var now = kstStamp_(nowMs_());
  var r = { id: newId_('r'), date: date, serviceId: sid, memberId: user.id, vehicleId: vehicle.id, plate: vehicle.plate,
    name: user.name, phone: user.phone, status: status, note: s_(req.note).slice(0, 100), adminNote: '',
    createdAt: now, updatedAt: now };
  appendRow_('Requests', r);
  reqs.push(r);
  var out = { id: r.id, status: status };
  if (status === 'waitlist') {
    out.waitPos = waitlistOrder_(reqs, membersById, date, sid).map(function (x) { return x.id; }).indexOf(r.id) + 1;
  }
  return out;
}

function requestCancel_(req, user) {
  var r = readRequests_().filter(function (x) { return x.id === s_(req.id); })[0];
  if (!r || (r.memberId !== user.id && user.role !== 'admin')) fail_('신청 내역을 찾을 수 없어요.');
  if (ACTIVE_STATUSES.indexOf(r.status) < 0) fail_('이미 처리된 신청이에요.');
  var svc = readServices_().filter(function (s) { return s.id === r.serviceId; })[0];
  if (user.role !== 'admin' && svc && nowMs_() >= startMs_(r.date, svc.time)) fail_('이미 시작된 예배는 취소할 수 없어요.');
  cancelRequest_(r, 'cancelled');
  return {};
}

/* ───────────────────────── 관리자 ───────────────────────── */

var STATUS_ORDER = { approved: 0, pending: 1, waitlist: 2, rejected: 3, cancelled: 4 };

function adminRequests_(req) {
  var date = s_(req.date);
  if (!isDate_(date)) fail_('날짜를 확인해 주세요.');
  var st = readSettings_(), services = readServices_();
  var members = readMembers_(), membersById = byId_(members), vehiclesById = byId_(readVehicles_());
  var reqs = readRequests_(date < addDays_(todayKst_(), -60));
  return {
    date: date,
    sessions: sessionsOnDate_(date, services, st).map(function (s) {
      var c = countsFor_(reqs, membersById, date, s.serviceId);
      var list = reqs.filter(function (r) { return r.date === date && r.serviceId === s.serviceId; })
        .sort(function (a, b) {
          var pa = membersById[a.memberId] && membersById[a.memberId].priority ? 0 : 1;
          var pb = membersById[b.memberId] && membersById[b.memberId].priority ? 0 : 1;
          return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || pa - pb ||
            (a.createdAt < b.createdAt ? -1 : 1);
        })
        .map(function (r) {
          var m = membersById[r.memberId], v = vehiclesById[r.vehicleId];
          return { id: r.id, plate: r.plate, model: v ? v.model : '', color: v ? v.color : '', name: r.name,
            phone: r.phone, district: m ? m.district : '', priority: !!(m && m.priority), status: r.status,
            note: r.note, adminNote: r.adminNote, createdAt: r.createdAt };
        });
      return { key: s.key, serviceId: s.serviceId, name: s.name, time: s.time, capacity: s.capacity,
        reserved: s.reserved, approved: c.approved, pending: c.pending, waitlist: c.waitlist, requests: list };
    })
  };
}

function adminSetStatus_(req) {
  var status = s_(req.status);
  if (ALL_STATUSES.indexOf(status) < 0) fail_('상태 값이 올바르지 않아요.');
  var r = readRequests_(true).filter(function (x) { return x.id === s_(req.id); })[0];
  if (!r) fail_('신청 내역을 찾을 수 없어요.');
  var patch = { status: status, updatedAt: kstStamp_(nowMs_()) };
  if (req.adminNote != null) patch.adminNote = s_(req.adminNote).slice(0, 100);
  updateRow_('Requests', r._row, patch);
  if (r.status === 'approved' && status !== 'approved') promote_(r.date, r.serviceId);
  return {};
}

function adminSearch_(req) {
  var q = s_(req.q).replace(/[\s-]/g, '').toLowerCase();
  if (q.length < 2) fail_('두 글자(숫자) 이상 입력해 주세요.');
  var members = byId_(readMembers_());
  var onlyDigits = /^\d+$/.test(q);
  var out = readVehicles_().filter(function (v) { return v.active; }).map(function (v) {
    return { v: v, m: members[v.memberId] };
  }).filter(function (x) {
    if (!x.m) return false;
    var name = x.m.name.toLowerCase();
    return x.v.plate.toLowerCase().indexOf(q) >= 0 || name.indexOf(q) >= 0 || (onlyDigits && x.m.phone.indexOf(q) >= 0);
  }).slice(0, 30).map(function (x) {
    return { plate: x.v.plate, model: x.v.model, color: x.v.color, name: x.m.name, phone: x.m.phone,
      district: x.m.district, priority: x.m.priority };
  });
  return { results: out };
}

function adminMembers_() {
  var plates = {};
  readVehicles_().forEach(function (v) {
    if (v.active) (plates[v.memberId] = plates[v.memberId] || []).push(v.plate);
  });
  return {
    members: readMembers_().map(function (m) {
      return { id: m.id, name: m.name, phone: m.phone, district: m.district, role: m.role, priority: m.priority,
        createdAt: m.createdAt, plates: plates[m.id] || [] };
    }).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })
  };
}

function adminUpdateMember_(req, user) {
  var members = readMembers_();
  var m = members.filter(function (x) { return x.id === s_(req.id); })[0];
  if (!m) fail_('교인을 찾을 수 없어요.');
  var patch = {};
  if (req.role != null) {
    var role = s_(req.role) === 'admin' ? 'admin' : 'member';
    if (m.role === 'admin' && role !== 'admin' &&
        members.filter(function (x) { return x.role === 'admin'; }).length <= 1) {
      fail_('관리자가 최소 한 명은 있어야 해요.');
    }
    patch.role = role;
  }
  if (req.priority != null) patch.priority = !!req.priority;
  if (req.district != null) patch.district = s_(req.district).slice(0, 30);
  updateRow_('Members', m._row, patch);
  return {};
}

function adminResetPin_(req) {
  var m = readMembers_().filter(function (x) { return x.id === s_(req.id); })[0];
  if (!m) fail_('교인을 찾을 수 없어요.');
  var pin = s_(req.pin);
  checkPin_(pin);
  updateRow_('Members', m._row, { pinHash: hashPin_(pin, m.salt) });
  return {};
}

function adminSettings_() {
  var st = readSettings_();
  return { settings: SETTING_DEFS.map(function (d) { return { key: d[0], value: st[d[0]], description: d[2] }; }) };
}

function adminSaveSettings_(req) {
  var values = req.values || {};
  var rows = readAll_('Settings');
  var checks = {
    autoApprove: function (v) { return v === 'TRUE' || v === 'FALSE'; },
    horizonDays: function (v) { return /^\d+$/.test(v) && +v >= 1 && +v <= 60; },
    cutoffHours: function (v) { return /^\d+$/.test(v) && +v <= 72; },
    maxVehicles: function (v) { return /^\d+$/.test(v) && +v >= 1 && +v <= 10; }
  };
  SETTING_DEFS.forEach(function (d) {
    var k = d[0];
    if (values[k] == null) return;
    var v = s_(values[k]);
    if (checks[k] && !checks[k](v)) fail_('설정 값을 확인해 주세요. (' + k + ')');
    var row = rows.filter(function (r) { return s_(r.key) === k; })[0];
    if (row) updateRow_('Settings', row._row, { value: v });
    else appendRow_('Settings', { key: k, value: v, description: d[2] });
  });
  return {};
}

function adminServices_() {
  return { services: readServices_().map(function (s) {
    return { id: s.id, name: s.name, dayOfWeek: s.dayOfWeek, time: s.time, capacity: s.capacity,
      reserved: s.reserved, date: s.date, active: s.active };
  }) };
}

function adminSaveService_(req) {
  var name = s_(req.name), time = timeS_(req.time), date = s_(req.date);
  var capacity = num_(req.capacity, -1), reserved = num_(req.reserved, 0);
  var dw = s_(req.dayOfWeek);
  if (!name) fail_('예배 이름을 적어 주세요.');
  if (!/^\d{2}:\d{2}$/.test(time)) fail_('시간은 09:00 처럼 적어 주세요.');
  if (capacity < 0 || capacity !== Math.floor(capacity)) fail_('주차 가능 대수를 확인해 주세요.');
  if (reserved < 0 || reserved > capacity) fail_('우선배정 면수는 전체 대수보다 클 수 없어요.');
  if (date) {
    if (!isDate_(date)) fail_('특정 날짜 형식을 확인해 주세요.');
    dw = '';
  } else if (!/^[0-6]$/.test(dw)) {
    fail_('요일을 선택해 주세요.');
  }
  var data = { name: name, dayOfWeek: dw, time: time, capacity: capacity, reserved: reserved, date: date,
    active: !!req.active };
  var id = s_(req.id);
  var existing = id ? readServices_().filter(function (s) { return s.id === id; })[0] : null;
  if (existing) {
    updateRow_('Services', existing._row, data);
  } else {
    data.id = newId_('svc-');
    id = data.id;
    appendRow_('Services', data);
  }
  // 주차 가능 대수를 늘렸다면 대기자를 승인해 줍니다.
  var st = readSettings_();
  upcomingSessions_(readServices_(), st).forEach(function (s) {
    if (s.serviceId === id) promote_(s.date, s.serviceId);
  });
  return { id: id };
}
