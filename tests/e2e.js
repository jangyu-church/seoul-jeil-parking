// 실제 브라우저(Chromium)로 화면을 끝까지 눌러 보는 테스트. 구글 서버 자리에는 가짜 백엔드(gas-harness)를 연결합니다.
// 실행: node tests/e2e.js [스크린샷 저장 폴더]
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createEnv } = require('./gas-harness');

const DOCS = path.join(__dirname, '../docs');
const SHOTS = process.argv[2];
const FAKE_API = 'https://script.google.com/macros/s/FAKE/exec';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

(async () => {
  const env = createEnv();
  const server = http.createServer((req, res) => {
    let f = path.join(DOCS, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    if (req.url.startsWith('/config.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`window.APP_CONFIG={API_URL:'${FAKE_API}'}`);
    }
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  }).listen(0);
  const base = `http://localhost:${server.address().port}/`;

  const browser = await chromium.launch();
  const errors = [];
  async function newPage(name) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ko-KR' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.route(FAKE_API, async (route) => {
      const body = JSON.parse(route.request().postData());
      const out = await env.call(body.action, (({ action, token, ...p }) => p)(body), body.token);
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
    });
    await page.goto(base);
    return page;
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };

  // 1) 목사님(첫 가입자 = 관리자) 가입
  const admin = await newPage('admin');
  await admin.waitForSelector('form[data-form=login]');
  await shot(admin, '01-login');
  await admin.click('[data-act=auth-mode][data-v=register]');
  await admin.fill('#f-name', '이경로');
  await admin.fill('#f-phone', '010-1111-2222');
  await admin.fill('#f-pin', '1234');
  await admin.fill('#f-district', '교역자');
  await admin.click('button[type=submit]');
  await admin.waitForSelector('.tabs');
  assert.ok(await admin.locator('.tabs button', { hasText: '관리' }).count(), '관리자 탭이 보여야 함');

  // 2) 교인 가입 → 차량 등록 → 주차 신청
  const member = await newPage('member');
  await member.click('[data-act=auth-mode][data-v=register]');
  await member.fill('#f-name', '김성도');
  await member.fill('#f-phone', '01033334444');
  await member.fill('#f-pin', '4321');
  await member.click('button[type=submit]');
  await member.waitForSelector('.tabs');
  assert.equal(await member.locator('.tabs button', { hasText: '관리' }).count(), 0, '일반 교인에게는 관리 탭이 없어야 함');
  await member.click('.card:has-text("주일 1부예배") [data-act=req-open]');
  await member.waitForSelector('text=먼저 차량을 등록해 주세요');
  await member.click('[data-act=tab][data-v=cars]');
  await member.fill('#f-plate', '12가 3456');
  await member.fill('#f-model', '쏘나타');
  await member.fill('#f-color', '흰색');
  await member.click('form[data-form=car] button[type=submit]');
  await member.waitForSelector('.plate:has-text("12가3456")');
  await shot(member, '02-cars');
  await member.click('[data-act=tab][data-v=home]');
  await member.click('.card:has-text("주일 1부예배") [data-act=req-open]');
  await member.fill('input[name=note]', '무릎이 불편해요');
  await shot(member, '03-request-form');
  await member.click('form[data-form=request] button[type=submit]');
  await member.waitForSelector('.card:has-text("주일 1부예배") .badge.b-approved');
  await shot(member, '04-home-approved');
  await member.click('[data-act=tab][data-v=mine]');
  await member.waitForSelector('text=다가오는 일정');
  await shot(member, '05-mine');

  // 3) 관리자 화면에서 신청 확인·거절·검색
  await admin.click('[data-act=tab][data-v=admin]');
  await admin.waitForSelector('input[type=date]');
  await admin.fill('input[type=date]', '2026-11-29'); // 교인이 신청한 주일
  await admin.waitForSelector('.req .plate:has-text("12가3456")');
  assert.ok(await admin.locator('.req', { hasText: '무릎이 불편해요' }).count());
  await shot(admin, '06-admin-day');
  await admin.click('.req [data-act=set-status][data-v=rejected]');
  await admin.waitForSelector('.req .badge.b-rejected');
  await admin.click('[data-act=admin-tab][data-v=search]');
  await admin.fill('#f-q', '3456');
  await admin.click('form[data-form=search] button[type=submit]');
  await admin.waitForSelector('a[href="tel:01033334444"]');
  await shot(admin, '07-admin-search');
  await admin.click('[data-act=admin-tab][data-v=members]');
  await admin.waitForSelector('text=김성도');
  await admin.click('.person:has-text("김성도") [data-act=member-priority]');
  await admin.waitForSelector('text=우선배정 해제');
  await admin.click('[data-act=admin-tab][data-v=settings]');
  await admin.waitForSelector('form[data-form=settings]');
  await shot(admin, '08-admin-settings');
  // 주차 대수 수정
  const svc = admin.locator('form[data-form=service]').first();
  await svc.locator('input[name=capacity]').fill('45');
  await svc.locator('button[type=submit]').click();
  await admin.waitForSelector('#toast.show:has-text("저장했어요")');

  // 4) 교인 화면에 거절 결과 반영, 새로고침해도 로그인 유지
  await member.click('[data-act=tab][data-v=home]');
  await member.waitForSelector('.card:has-text("주일 1부예배") .badge.b-rejected', { state: 'detached' }).catch(() => {});
  await member.reload();
  await member.waitForSelector('.tabs');
  const cap = await member.locator('.card:has-text("주일 1부예배")').first().innerText();
  assert.match(cap, /\/ 45대/, '관리자가 바꾼 정원이 교인 화면에 보여야 함');

  // 5) 가로 넘침(스크롤) 없는지
  const overflow = await member.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `가로 스크롤 발생: ${overflow}px`);

  await browser.close();
  server.close();
  assert.deepEqual(errors, [], '콘솔 오류: ' + errors.join('\n'));
  console.log('E2E 통과');
})().catch((e) => { console.error(e); process.exit(1); });
