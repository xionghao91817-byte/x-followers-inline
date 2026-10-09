const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const jobs = [];
const headers = [];
let payload;
let status = 200;
let calls = 0;
let expectedCalls = 0;
class Element {
  constructor(text = '') { this.textContent = text; this.title = ''; this.className = ''; }
  closest() { return this.header; }
  remove() { this.header.badge = undefined; }
  after(badge) { badge.header = this.header; badge.previousElementSibling = this; this.header.badge = badge; }
}
function header(handle) {
  const link = new Element(`@${handle}`);
  link.href = `https://x.com/${handle}`;
  const item = { link, querySelectorAll(selector) {
    return selector === 'a[href]' ? [link] : this.badge ? [this.badge] : [];
  }};
  link.header = item;
  const classes = new Set();
  link.parentElement = { classList: { add: value => classes.add(value), contains: value => classes.has(value) } };
  headers.push(item);
  return item;
}
class XHR {
  open(method, url) { this.method = method; this.url = url; }
  addEventListener(type, listener) { this.listener = listener; }
  sendData(data, type = '', code = 200) {
    this.status = code; this.responseType = type;
    this.response = data; this.responseText = JSON.stringify(data);
    this.listener();
  }
}
let now = Date.now();
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const context = {
  document: { readyState: 'complete', querySelectorAll: () => headers, createElement: () => new Element() },
  location: { href: 'https://x.com/home', origin: 'https://x.com' },
  MutationObserver: class { constructor(fn) { this.callback = fn; } observe() {} },
  XMLHttpRequest: XHR, URL, Request, Date: TestDate,
  setTimeout: fn => { jobs.push(fn); return jobs.length; }, setInterval: () => {},
  fetch: async () => {
    calls++;
    return { ok: status === 200, headers: { get: () => 'application/json' },
      clone: () => ({ json: async () => payload }) };
  }
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'inline.js'), 'utf8'), context);
const runJobs = () => { while (jobs.length) jobs.shift()(); };
async function load(data, url = 'https://x.com/i/api/graphql/test/HomeTimeline') {
  payload = data;
  expectedCalls++;
  await context.fetch(url);
  await new Promise(resolve => setImmediate(resolve));
  runJobs();
}
(async () => {
  const alice = header('Alice');
  const bob = header('bob');
  const unknown = header('unknown');
  runJobs();
  assert.match(unknown.badge.textContent, /待获取/);
  assert.ok(alice.link.parentElement.classList.contains('xfi-id-row'));
  assert.ok(fs.readFileSync(path.join(root, 'inline.css'), 'utf8').includes('flex-direction: row !important'));
  await load({ data: { user: { legacy: { screen_name: 'alice', followers_count: 123456 } } } });
  assert.equal(alice.badge.textContent, '· 12.3万粉丝');
  assert.match(alice.badge.title, /123,456/);
  await load({ data: { user: { result: {
    __typename: 'User', core: { screen_name: 'Alice' },
    relationship_counts: { followers: 1023, following: 1574 }
  } } } });
  assert.equal(alice.badge.textContent, '· 1,023粉丝', 'Current X relationship_counts must be read');
  await load({ user: { core: { screen_name: 'Alice' },
    relationship_counts: { followers: 2048 }, legacy: { followers_count: 0 } } });
  assert.equal(alice.badge.textContent, '· 2,048粉丝', 'Current field wins over obsolete legacy value');
  await load({ result: { core: { screen_name: 'bob' }, legacy: { followers_count: 0 } } });
  assert.equal(bob.badge.textContent, '· 0粉丝');
  const request = new XHR();
  request.open('GET', 'https://x.com/i/api/graphql/test/SearchTimeline');
  request.sendData({ user: { username: 'alice', public_metrics: { followers_count: 9999 } } }, 'json');
  runJobs();
  assert.equal(alice.badge.textContent, '· 9,999粉丝');
  request.sendData({ user: { screen_name: 'alice', followers_count: 10000 } });
  runJobs();
  assert.equal(alice.badge.textContent, '· 1万粉丝');
  for (const count of [-1, null, '40000', 1.5, Infinity]) {
    await load({ user: { screen_name: 'alice', followers_count: count } });
    assert.equal(alice.badge.textContent, '· 1万粉丝');
  }
  await load({ user: { screen_name: 'alice', followers_count: 40000 } }, 'https://other.example/i/api/graphql/test/HomeTimeline');
  assert.equal(alice.badge.textContent, '· 1万粉丝');
  await load({ user: { screen_name: 'alice', followers_count: 40000 } }, 'https://x.com/i/api/graphql/test/DMInbox');
  assert.equal(alice.badge.textContent, '· 1万粉丝');
  status = 429;
  await load({ user: { screen_name: 'alice', followers_count: 40000 } });
  assert.equal(alice.badge.textContent, '· 1万粉丝');
  status = 200;
  alice.link.textContent = '@bob'; alice.link.href = 'https://x.com/bob';
  await load({});
  assert.equal(alice.badge.textContent, '· 0粉丝');
  const badge = alice.badge;
  await load({});
  assert.equal(alice.badge, badge);
  now += 31 * 60 * 1000;
  await load({});
  assert.match(alice.badge.textContent, /待获取/);
  await load({ user: { screen_name: 'bob', followers_count: 87654321 } });
  assert.equal(alice.badge.textContent, '· 8,765.4万粉丝');
  assert.equal(bob.badge.textContent, alice.badge.textContent);
  assert.equal(calls, expectedCalls, 'Only test caller requests occur; extension sends none');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.permissions, undefined);
  for (const filename of [...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css]) {
    assert.ok(fs.statSync(path.join(root, filename)).size > 0);
  }
  console.log('PASS: format, legacy/core/v2 data, fetch/XHR, invalid values, unknown/zero, foreign/DM URLs, HTTP errors, reused headers, expiry, manifest and no extra requests.');
})().catch(error => { console.error(error); process.exitCode = 1; });
