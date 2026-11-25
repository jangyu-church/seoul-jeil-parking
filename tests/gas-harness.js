// Code.gs를 구글 없이 Node에서 돌리기 위한 가짜(Mock) 환경.
// SpreadsheetApp / LockService / CacheService / PropertiesService / Utilities / ContentService 를 흉내 냅니다.
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));

function makeSheet(name) {
  const sh = { name, data: [], frozen: 0 };
  const MAX_ROWS = 1000;
  sh.getMaxRows = () => MAX_ROWS;
  sh.getLastRow = () => {
    let n = sh.data.length;
    while (n > 0 && sh.data[n - 1].every((c) => c === '' || c == null)) n--;
    return n;
  };
  sh.setFrozenRows = (n) => { sh.frozen = n; };
  sh.getRange = (row, col, nr = 1, nc = 1) => {
    const rg = {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const line = [];
          for (let c = 0; c < nc; c++) {
            const v = (sh.data[row - 1 + r] || [])[col - 1 + c];
            line.push(v === undefined ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        for (let r = 0; r < nr; r++) {
          const idx = row - 1 + r;
          while (sh.data.length <= idx) sh.data.push([]);
          for (let c = 0; c < nc; c++) {
            sh.data[idx][col - 1 + c] = vals[r][c];
          }
        }
        return rg;
      },
      setNumberFormat() { return rg; },
      setFontWeight() { return rg; },
    };
    return rg;
  };
  return sh;
}

function createEnv() {
  const sheets = {};
  const props = {};
  const cache = new Map();
  const state = { now: Date.parse('2026-11-25T10:00:00+09:00'), lockHeld: false };

  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = makeSheet(n)),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (state.lockHeld) throw new Error('lock busy'); state.lockHeld = true; },
        releaseLock() { state.lockHeld = false; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
        remove: (k) => cache.delete(k),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; }, getContent() { return this.text; } }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, value) => signed(crypto.createHash('sha256').update(value, 'utf8').digest()),
      computeHmacSha256Signature: (msg, key) => signed(crypto.createHmac('sha256', key).update(msg).digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64url'),
      formatDate: (d, tz, fmt) => {
        const k = new Date(d.getTime() + 9 * 3600e3).toISOString();
        return fmt === 'yyyy-MM-dd' ? k.slice(0, 10) : k.slice(11, 16);
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  ctx.nowMs_ = () => state.now; // 테스트에서 "지금 시각"을 마음대로 조절

  // doPost 와 똑같은 경로로 호출하고, JSON 응답을 돌려줍니다.
  async function call(action, params = {}, token) {
    const e = { postData: { contents: JSON.stringify({ action, token, ...params }) } };
    return JSON.parse(ctx.doPost(e).getContent());
  }
  return { ctx, sheets, state, call };
}

module.exports = { createEnv };
