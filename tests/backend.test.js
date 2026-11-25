'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-harness');

// 기준 시각: 2026-11-25(수) 10:00 KST.  다음 주일 = 2026-11-29, 수요예배 = 2026-11-25 19:30
const SUN = '2026-11-29';

async function signup(env, name, phone, extra = {}) {
  const r = await env.call('register', { name, phone, pin: '1234', ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data;
}
async function addCar(env, token, plate) {
  const r = await env.call('vehicle.add', { plate, model: '쏘나타', color: '흰색' }, token);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data.vehicle.id;
}
async function setServiceCapacity(env, admin, id, patch) {
  const list = (await env.call('admin.services', {}, admin.token)).data.services;
  const s = list.find((x) => x.id === id);
  const r = await env.call('admin.saveService', { ...s, ...patch }, admin.token);
  assert.equal(r.ok, true, JSON.stringify(r));
}

test('시트 탭이 자동으로 만들어지고 예시 데이터가 들어간다', async () => {
  const env = createEnv();
  const r = await env.call('config');
  assert.equal(r.ok, true);
  assert.equal(r.data.churchName, '서울제일교회');
  assert.deepEqual(Object.keys(env.sheets).sort(), ['교인', '설정', '신청', '예배', '차량'].sort());
  assert.equal(env.sheets['예배'].getLastRow(), 4); // 헤더 + 3개
});

test('첫 가입자는 관리자, 두 번째부터는 일반 교인', async () => {
  const env = createEnv();
  const a = await signup(env, '이경로', '010-1111-2222');
  const b = await signup(env, '김집사', '010-3333-4444');
  assert.equal(a.user.role, 'admin');
  assert.equal(b.user.role, 'member');
  assert.equal(a.user.phone, '01011112222');
});

test('가입 검증: 번호 형식, 중복, 가입 코드, 비밀번호', async () => {
  const env = createEnv();
  assert.equal((await env.call('register', { name: '홍길동', phone: '123', pin: '1234' })).ok, false);
  assert.equal((await env.call('register', { name: '홍길동', phone: '01012345678', pin: 'abcd' })).ok, false);
  await signup(env, '관리자', '01000000000');
  const admin = (await env.call('login', { phone: '01000000000', pin: '1234' })).data;
  await env.call('admin.saveSettings', { values: { joinCode: 'Grace2026' } }, admin.token);
  const bad = await env.call('register', { name: '홍길동', phone: '01012345678', pin: '1234', joinCode: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /가입 코드/);
  const ok = await env.call('register', { name: '홍길동', phone: '01012345678', pin: '1234', joinCode: 'grace2026' });
  assert.equal(ok.ok, true);
  const dup = await env.call('register', { name: '홍길동', phone: '010-1234-5678', pin: '1234', joinCode: 'Grace2026' });
  assert.match(dup.error, /이미 가입/);
});

test('로그인 5번 실패하면 잠기고, 비밀번호는 시트에 평문으로 저장되지 않는다', async () => {
  const env = createEnv();
  await signup(env, '이경로', '01011112222');
  for (let i = 0; i < 5; i++) {
    const r = await env.call('login', { phone: '01011112222', pin: '9999' });
    assert.equal(r.ok, false);
  }
  const locked = await env.call('login', { phone: '01011112222', pin: '1234' });
  assert.equal(locked.code, 'LOCKED');
  const dump = JSON.stringify(env.sheets['교인'].data);
  assert.ok(!dump.includes('"1234"'));
});

test('토큰 위조·만료·없음은 거절된다', async () => {
  const env = createEnv();
  const u = await signup(env, '이경로', '01011112222');
  assert.equal((await env.call('me', {}, u.token)).ok, true);
  assert.equal((await env.call('me', {}, u.token + 'x')).code, 'AUTH');
  assert.equal((await env.call('me', {})).code, 'AUTH');
  env.state.now += 31 * 86400000;
  assert.equal((await env.call('me', {}, u.token)).code, 'AUTH');
});

test('차량번호 검증과 등록 대수 제한', async () => {
  const env = createEnv();
  const u = await signup(env, '이경로', '01011112222');
  for (const bad of ['abc', '1234', '가나다라', '12가345']) {
    assert.equal((await env.call('vehicle.add', { plate: bad }, u.token)).ok, false, bad);
  }
  await addCar(env, u.token, '12가 3456');
  await addCar(env, u.token, '서울34나5678');
  await addCar(env, u.token, '123-다-4567'.replace(/-/g, ''));
  const over = await env.call('vehicle.add', { plate: '99라9999' }, u.token);
  assert.match(over.error, /최대 3대/);
  const me = (await env.call('me', {}, u.token)).data;
  assert.equal(me.vehicles[0].plate, '12가3456');
});

test('신청 목록: 앞으로 14일 안의 예배만 나오고, 마감 시각이 반영된다', async () => {
  const env = createEnv();
  const u = await signup(env, '이경로', '01011112222');
  const { sessions } = (await env.call('slots', {}, u.token)).data;
  const keys = sessions.map((s) => s.key);
  assert.ok(keys.includes(`2026-11-25|svc-wed`));
  assert.ok(keys.includes(`${SUN}|svc-sun1`));
  assert.ok(keys.includes(`2026-12-06|svc-sun2`));
  assert.ok(!keys.some((k) => k.startsWith('2026-12-09'))); // 14일 밖
  assert.equal(sessions.find((s) => s.key === `${SUN}|svc-sun1`).closed, false);
  // 수요예배 19:30, 마감 2시간 전 = 17:30
  env.state.now = Date.parse('2026-11-25T17:31:00+09:00');
  const again = (await env.call('slots', {}, u.token)).data.sessions;
  assert.equal(again.find((s) => s.key === '2026-11-25|svc-wed').closed, true);
  const vid = await addCar(env, u.token, '12가3456');
  const r = await env.call('request.create', { date: '2026-11-25', serviceId: 'svc-wed', vehicleId: vid }, u.token);
  assert.match(r.error, /마감/);
});

test('자동 승인 → 정원 초과 시 대기자 → 취소하면 자동 승격', async () => {
  const env = createEnv();
  const admin = await signup(env, '이경로', '01011112222');
  await setServiceCapacity(env, admin, 'svc-sun1', { capacity: 2 });
  const users = [];
  for (let i = 0; i < 4; i++) {
    const u = await signup(env, `교인${i}`, `0102000000${i}`);
    u.vid = await addCar(env, u.token, `1${i}가300${i}`);
    users.push(u);
  }
  const res = [];
  for (const u of users) {
    res.push((await env.call('request.create', { date: SUN, serviceId: 'svc-sun1', vehicleId: u.vid }, u.token)).data);
  }
  assert.deepEqual(res.map((r) => r.status), ['approved', 'approved', 'waitlist', 'waitlist']);
  assert.equal(res[2].waitPos, 1);
  assert.equal(res[3].waitPos, 2);

  // 첫 번째 사람이 취소 → 대기 1번이 승인
  const myReq = (await env.call('slots', {}, users[0].token)).data.sessions.find((s) => s.key === `${SUN}|svc-sun1`).mine;
  assert.equal((await env.call('request.cancel', { id: myReq.id }, users[0].token)).ok, true);
  const s2 = (await env.call('slots', {}, users[2].token)).data.sessions.find((s) => s.key === `${SUN}|svc-sun1`);
  assert.equal(s2.mine.status, 'approved');
  const s3 = (await env.call('slots', {}, users[3].token)).data.sessions.find((s) => s.key === `${SUN}|svc-sun1`);
  assert.equal(s3.mine.status, 'waitlist');
  assert.equal(s3.mine.waitPos, 1);
  assert.equal(s3.approved, 2);
});

test('우선배정 교인은 대기자 중 먼저 승격되고, 전용 면수는 일반 교인이 쓸 수 없다', async () => {
  const env = createEnv();
  const admin = await signup(env, '이경로', '01011112222');
  await setServiceCapacity(env, admin, 'svc-sun1', { capacity: 3, reserved: 1 });
  const gen = [],
    mk = async (name, phone, plate) => { const u = await signup(env, name, phone); u.vid = await addCar(env, u.token, plate); return u; };
  const a = await mk('일반1', '01030000001', '11가1111');
  const b = await mk('일반2', '01030000002', '22가2222');
  const c = await mk('일반3', '01030000003', '33가3333');
  const p = await mk('어르신', '01030000004', '44가4444');
  const members = (await env.call('admin.members', {}, admin.token)).data.members;
  const elder = members.find((m) => m.name === '어르신');
  await env.call('admin.updateMember', { id: elder.id, priority: true }, admin.token);
  const mkReq = async (u) => (await env.call('request.create', { date: SUN, serviceId: 'svc-sun1', vehicleId: u.vid }, u.token)).data;
  assert.equal((await mkReq(a)).status, 'approved');
  assert.equal((await mkReq(b)).status, 'approved');
  assert.equal((await mkReq(c)).status, 'waitlist'); // 일반석 2개(3-1)만
  assert.equal((await mkReq(p)).status, 'approved'); // 우선배정 1면
  gen.push(a);
  // 일반1 취소 → 대기자 일반3 승격
  const mine = (await env.call('slots', {}, a.token)).data.sessions.find((s) => s.key === `${SUN}|svc-sun1`).mine;
  await env.call('request.cancel', { id: mine.id }, a.token);
  const c2 = (await env.call('slots', {}, c.token)).data.sessions.find((s) => s.key === `${SUN}|svc-sun1`).mine;
  assert.equal(c2.status, 'approved');
});

test('수동 승인 모드: 신청은 pending, 관리자가 승인/거절', async () => {
  const env = createEnv();
  const admin = await signup(env, '이경로', '01011112222');
  await env.call('admin.saveSettings', { values: { autoApprove: 'FALSE' } }, admin.token);
  const u = await signup(env, '김집사', '01033334444');
  const vid = await addCar(env, u.token, '12가3456');
  const r = (await env.call('request.create', { date: SUN, serviceId: 'svc-sun2', vehicleId: vid, note: '휠체어' }, u.token)).data;
  assert.equal(r.status, 'pending');
  let day = (await env.call('admin.requests', { date: SUN }, admin.token)).data;
  const sess = day.sessions.find((s) => s.serviceId === 'svc-sun2');
  assert.equal(sess.pending, 1);
  assert.equal(sess.requests[0].plate, '12가3456');
  assert.equal(sess.requests[0].note, '휠체어');
  await env.call('admin.setStatus', { id: r.id, status: 'approved', adminNote: '2층 주차장' }, admin.token);
  day = (await env.call('admin.requests', { date: SUN }, admin.token)).data;
  assert.equal(day.sessions.find((s) => s.serviceId === 'svc-sun2').approved, 1);
  const mine = (await env.call('me', {}, u.token)).data.requests[0];
  assert.equal(mine.status, 'approved');
  assert.equal(mine.adminNote, '2층 주차장');
});

test('중복 신청 방지(교인 1명 1대, 같은 차량 중복 불가)', async () => {
  const env = createEnv();
  await signup(env, '이경로', '01011112222');
  const u = await signup(env, '김집사', '01033334444');
  const v1 = await addCar(env, u.token, '12가3456');
  const v2 = await addCar(env, u.token, '34나5678');
  const ok = await env.call('request.create', { date: SUN, serviceId: 'svc-sun1', vehicleId: v1 }, u.token);
  assert.equal(ok.ok, true);
  assert.match((await env.call('request.create', { date: SUN, serviceId: 'svc-sun1', vehicleId: v2 }, u.token)).error, /이미/);
  // 다른 예배는 가능
  assert.equal((await env.call('request.create', { date: SUN, serviceId: 'svc-sun2', vehicleId: v2 }, u.token)).ok, true);
  // 남의 차량으로 신청 불가
  const w = await signup(env, '박권사', '01055556666');
  assert.equal((await env.call('request.create', { date: SUN, serviceId: 'svc-wed', vehicleId: v1 }, w.token)).ok, false);
  // 없는 예배
  assert.equal((await env.call('request.create', { date: '2026-12-31', serviceId: 'svc-sun1', vehicleId: v1 }, u.token)).ok, false);
});

test('차량을 삭제하면 앞으로의 신청이 취소되고 대기자가 승격된다', async () => {
  const env = createEnv();
  const admin = await signup(env, '이경로', '01011112222');
  await setServiceCapacity(env, admin, 'svc-sun1', { capacity: 1 });
  const a = await signup(env, '가나', '01040000001');
  const b = await signup(env, '나다', '01040000002');
  const va = await addCar(env, a.token, '11가1111');
  const vb = await addCar(env, b.token, '22나2222');
  assert.equal((await env.call('request.create', { date: SUN, serviceId: 'svc-sun1', vehicleId: va }, a.token)).data.status, 'approved');
  assert.equal((await env.call('request.create', { date: SUN, serviceId: 'svc-sun1', vehicleId: vb }, b.token)).data.status, 'waitlist');
  await env.call('vehicle.remove', { id: va }, a.token);
  const bs = (await env.call('slots', {}, b.token)).data.sessions.find((s) => s.key === `${SUN}|svc-sun1`);
  assert.equal(bs.mine.status, 'approved');
  assert.equal((await env.call('me', {}, a.token)).data.vehicles.length, 0);
});

test('관리자 전용 기능은 일반 교인이 쓸 수 없다', async () => {
  const env = createEnv();
  await signup(env, '이경로', '01011112222');
  const u = await signup(env, '김집사', '01033334444');
  for (const act of ['admin.members', 'admin.settings', 'admin.services']) {
    assert.equal((await env.call(act, {}, u.token)).code, 'FORBIDDEN', act);
  }
  assert.equal((await env.call('admin.requests', { date: SUN }, u.token)).code, 'FORBIDDEN');
});

test('차량 검색(번호 뒷자리·이름·전화번호)과 마지막 관리자 보호', async () => {
  const env = createEnv();
  const admin = await signup(env, '이경로', '01011112222');
  const u = await signup(env, '김집사', '01033334444');
  await addCar(env, u.token, '12가3456');
  for (const q of ['3456', '김집', '3333', '12가']) {
    const r = (await env.call('admin.search', { q }, admin.token)).data.results;
    assert.equal(r.length, 1, q);
    assert.equal(r[0].name, '김집사');
    assert.equal(r[0].phone, '01033334444');
  }
  assert.equal((await env.call('admin.search', { q: '9' }, admin.token)).ok, false);
  const me = (await env.call('admin.members', {}, admin.token)).data.members.find((m) => m.name === '이경로');
  const r = await env.call('admin.updateMember', { id: me.id, role: 'member' }, admin.token);
  assert.match(r.error, /최소 한 명/);
});

test('비밀번호 변경·초기화, 예배 설정 검증', async () => {
  const env = createEnv();
  const admin = await signup(env, '이경로', '01011112222');
  const u = await signup(env, '김집사', '01033334444');
  assert.equal((await env.call('pin.change', { current: '0000', next: '5678' }, u.token)).ok, false);
  assert.equal((await env.call('pin.change', { current: '1234', next: '5678' }, u.token)).ok, true);
  assert.equal((await env.call('login', { phone: '01033334444', pin: '5678' })).ok, true);
  const id = (await env.call('admin.members', {}, admin.token)).data.members.find((m) => m.name === '김집사').id;
  await env.call('admin.resetPin', { id, pin: '2468' }, admin.token);
  assert.equal((await env.call('login', { phone: '01033334444', pin: '2468' })).ok, true);

  const base = { name: '부활절 특별예배', time: '10:00', capacity: 40, reserved: 0, active: true };
  assert.equal((await env.call('admin.saveService', { ...base, dayOfWeek: '' }, admin.token)).ok, false);
  assert.equal((await env.call('admin.saveService', { ...base, dayOfWeek: '0', time: '10시' }, admin.token)).ok, false);
  assert.equal((await env.call('admin.saveService', { ...base, dayOfWeek: '0', reserved: 50 }, admin.token)).ok, false);
  const ok = await env.call('admin.saveService', { ...base, dayOfWeek: '', date: '2026-12-02' }, admin.token);
  assert.equal(ok.ok, true);
  const keys = (await env.call('slots', {}, u.token)).data.sessions.map((s) => s.key);
  assert.ok(keys.includes(`2026-12-02|${ok.data.id}`));
});
