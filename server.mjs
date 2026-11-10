#!/usr/bin/env node
// PR Status Tracker — local tool. Polls GitHub (via the `gh` CLI) every 5 minutes and shows:
//   1. My PRs       — classified into review statuses; pop-up when a status changes
//   2. Mentioned    — open PRs where someone @-mentioned you (description or comments)
//   3. Reviewing    — open PRs by others you commented on / reviewed, with replies since your last comment
// Anything new or changed is flagged NEW / UPDATE in the dashboard until you dismiss it.
//
//   node server.mjs            -> http://localhost:4777
//
// Env:
//   PORT=4777                  dashboard port
//   POLL_MINUTES=5             poll interval
//   NOTIFY=alert|banner        alert = dialog that stays until dismissed (default); banner = Notification Center
//   TRACK_MINE=1|0             auto-track every open PR you authored (default 1)

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, 'state.json');
const PORT = Number(process.env.PORT || 4777);
const POLL_MS = Number(process.env.POLL_MINUTES || 5) * 60_000;
const NOTIFY = process.env.NOTIFY || 'alert';
const TRACK_MINE = process.env.TRACK_MINE !== '0';

export const STATUS = {
  DRAFT_NO_AR: 'Draft — no adversarial review',
  DRAFT_AR_COMMENTS: 'Draft — adversarial review comments',
  DRAFT_READY: 'Draft — ready for review',
  READY_AWAITING: 'Ready for review — awaiting review',
  READY_COMMENTS: 'Ready for review — with comments',
  MERGEABLE: 'Able to merge',
  MERGED: 'Merged',
  CLOSED: 'Closed',
};

// ---------- state ----------
// prs/mentions/reviewing: { "owner/repo#123": { title, url, badge: 'new'|'update'|null, ... } }
let state = { manual: [], prs: {}, mentions: {}, reviewing: {}, init: {}, login: null, lastPoll: null, lastError: null };
if (existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch {}
}
// Existing installs already completed a "my PRs" poll — don't flag them all as new.
if (state.lastPoll) state.init.prs = true;
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ---------- GitHub ----------
const FRAGMENT = `fragment P on PullRequest {
  number title url isDraft state mergeable mergeStateStatus reviewDecision
  repository { nameWithOwner }
  reviews(last: 50) { nodes { body } }
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { body } } } }
}`;

// Everything written on a PR, for mention / reply detection.
const ACTIVITY = `fragment A on PullRequest {
  number title url createdAt
  repository { nameWithOwner }
  author { login }
  body
  comments(last: 50) { nodes { author { login __typename } body createdAt url } }
  reviews(last: 30) { nodes { author { login __typename } body createdAt url } }
  reviewThreads(last: 50) { nodes { comments(last: 20) { nodes { author { login __typename } body createdAt url } } } }
}`;

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

async function graphql(query) {
  const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${query}`]));
  if (out.errors?.length) throw new Error(out.errors.map(e => e.message).join('; '));
  return out.data;
}

export function parseRef(input) {
  const s = String(input).trim();
  const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/) || s.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}
const refOf = pr => `${pr.repository.nameWithOwner}#${pr.number}`;
const splitRef = ref => ref.match(/^([^/]+)\/([^#]+)#(\d+)$/).slice(1);

async function fetchMyPRs() {
  const parts = [];
  if (TRACK_MINE) {
    parts.push(`mine: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50) { nodes { ...P } }`);
  }
  state.manual.forEach((ref, i) => {
    const [owner, name, num] = splitRef(ref);
    parts.push(`m${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${num}) { ...P } }`);
  });
  if (!parts.length) return [];
  const data = await graphql(`query { ${parts.join('\n')} } ${FRAGMENT}`);
  const prs = [...(data.mine?.nodes || [])];
  state.manual.forEach((_, i) => { const p = data[`m${i}`]?.pullRequest; if (p) prs.push(p); });
  const seen = new Set();
  return prs.filter(p => p?.number && !seen.has(p.url) && seen.add(p.url));
}

async function fetchActivity() {
  const q = s => `search(query: "${s} archived:false", type: ISSUE, first: 30) { nodes { ...A } }`;
  const data = await graphql(`query {
    viewer { login }
    mentioned: ${q('is:pr is:open mentions:@me')}
    commented: ${q('is:pr is:open commenter:@me -author:@me')}
    reviewed: ${q('is:pr is:open reviewed-by:@me -author:@me')}
  } ${ACTIVITY}`);
  const dedupe = lists => { const m = new Map(); lists.flat().forEach(p => p?.number && m.set(p.url, p)); return [...m.values()]; };
  return {
    login: data.viewer.login,
    mentioned: dedupe([data.mentioned.nodes]),
    reviewing: dedupe([data.commented.nodes, data.reviewed.nodes]),
  };
}

// ---------- classification ----------
const AR_SUMMARY = /Automated adversarial review/i;
const AR_FINDING = /^!\[Adversarial Review: (High|Medium|Low)\]/; // excludes High Risk highlights + replies

export function classify(pr) {
  if (pr.state === 'MERGED') return { status: STATUS.MERGED, detail: '' };
  if (pr.state === 'CLOSED') return { status: STATUS.CLOSED, detail: '' };

  const threads = pr.reviewThreads?.nodes || [];
  const firstBody = t => t.comments?.nodes?.[0]?.body || '';
  const openAll = threads.filter(t => !t.isResolved && !/Adversarial Review: High Risk/.test(firstBody(t)));
  const openAR = openAll.filter(t => AR_FINDING.test(firstBody(t)));
  const hasAR = (pr.reviews?.nodes || []).some(r => AR_SUMMARY.test(r.body || ''))
    || threads.some(t => AR_FINDING.test(firstBody(t)));

  if (pr.isDraft) {
    if (!hasAR) return { status: STATUS.DRAFT_NO_AR, detail: '' };
    if (openAR.length) return { status: STATUS.DRAFT_AR_COMMENTS, detail: `${openAR.length} unresolved finding(s)` };
    return { status: STATUS.DRAFT_READY, detail: 'adversarial review addressed' };
  }

  // Not a draft. mergeable can be UNKNOWN while GitHub computes it — signal "keep previous".
  if (pr.mergeable === 'UNKNOWN') return { status: null, detail: 'GitHub still computing mergeability' };
  if (pr.mergeable === 'MERGEABLE' && ['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus)) {
    return { status: STATUS.MERGEABLE, detail: '' };
  }
  const why = [];
  if (openAll.length) why.push(`${openAll.length} unresolved thread(s)`);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') why.push('changes requested');
  if (why.length) return { status: STATUS.READY_COMMENTS, detail: why.join(', ') };
  const blocked = { BLOCKED: 'needs approval / checks', BEHIND: 'branch behind base', DIRTY: 'merge conflicts',
    UNSTABLE: 'failing checks', DRAFT: '' }[pr.mergeStateStatus] ?? pr.mergeStateStatus?.toLowerCase();
  return { status: STATUS.READY_AWAITING, detail: blocked || '' };
}

// Flatten everything written on a PR (excluding bots) into { login, body, createdAt, url }.
function items(pr) {
  const out = [];
  if (pr.author) out.push({ login: pr.author.login, body: pr.body || '', createdAt: pr.createdAt, url: pr.url, isDescription: true });
  const add = n => { if (n?.author && n.author.__typename !== 'Bot' && !/\[bot\]$/.test(n.author.login)) out.push({ login: n.author.login, body: n.body || '', createdAt: n.createdAt, url: n.url }); };
  (pr.comments?.nodes || []).forEach(add);
  (pr.reviews?.nodes || []).filter(r => r.body?.trim()).forEach(add);
  (pr.reviewThreads?.nodes || []).forEach(t => (t.comments?.nodes || []).forEach(add));
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const snippet = s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
const lc = s => s.toLowerCase();

export function mentionInfo(pr, login) {
  const re = new RegExp(`@${login.replace(/[-]/g, '\\-')}(?![\\w-])`, 'i');
  const hits = items(pr).filter(i => lc(i.login) !== lc(login) && re.test(i.body));
  const last = hits.at(-1);
  return { count: hits.length, latest: last && { author: last.login, text: snippet(last.body), url: last.url, createdAt: last.createdAt, where: last.isDescription ? 'description' : 'comment' } };
}

export function replyInfo(pr, login) {
  const all = items(pr).filter(i => !i.isDescription);
  const mine = all.filter(i => lc(i.login) === lc(login));
  const myLast = mine.at(-1)?.createdAt || '';
  const after = all.filter(i => lc(i.login) !== lc(login) && i.createdAt > myLast);
  const last = after.at(-1);
  return { newCount: after.length, myLast, latest: last && { author: last.login, text: snippet(last.body), url: last.url, createdAt: last.createdAt } };
}

// ---------- notifications ----------
function osa(lines, args) {
  spawn('osascript', [...lines.flatMap(l => ['-e', l]), ...args], { detached: true, stdio: 'ignore' }).unref();
}

// events: [{ ref, title, url, headline, detail }]
function notify(events) {
  if (!events.length) return;
  const one = events.length === 1 ? events[0] : null;
  const title = one ? `${one.ref}: ${one.headline}` : `${events.length} PR updates`;
  const msg = one ? `${one.title}${one.detail ? `\n\n${one.detail}` : ''}` : events.map(e => `• ${e.ref}: ${e.headline}`).join('\n');
  const openUrl = one ? one.url : `http://localhost:${PORT}`;

  if (NOTIFY === 'banner') {
    osa(['on run argv', 'display notification (item 1 of argv) with title "PR Status" subtitle (item 2 of argv) sound name "Glass"', 'end run'], [msg, title]);
    return;
  }
  osa([
    'on run argv',
    'set r to display alert (item 2 of argv) message (item 1 of argv) buttons {"Dismiss", "Open"} default button "Open" giving up after 3600',
    'if button returned of r is "Open" then open location (item 3 of argv)',
    'end run',
  ], [msg, title, openUrl]);
  spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- poll loop ----------
async function pollMyPRs(events) {
  const prs = await fetchMyPRs();
  const live = new Set();
  const flag = state.init.prs; // first-ever poll establishes a baseline without flags
  let pending = false;
  for (const pr of prs) {
    const ref = refOf(pr);
    live.add(ref);
    const prev = state.prs[ref];
    const { status, detail } = classify(pr);
    if (!status && !prev) { pending = true; continue; } // mergeability not computed yet — retry shortly
    if (!status) pending = true;
    const next = status || prev.status;
    let badge = prev?.badge || null;
    if (prev && prev.status !== next) {
      badge = 'update';
      events.push({ ref, title: pr.title, url: pr.url, headline: next, detail: `Was: ${prev.status}` });
    } else if (!prev && flag) badge = 'new';
    state.prs[ref] = { status: next, detail, title: pr.title, url: pr.url, badge,
      since: prev && prev.status === next ? prev.since : new Date().toISOString(),
      changedFrom: prev && prev.status !== next ? prev.status : prev?.changedFrom };
  }
  // Auto-tracked PRs that left the open search (merged/closed): look up the final state once,
  // keep them flagged until dismissed, then they drop off.
  for (const [ref, prev] of Object.entries(state.prs)) {
    if (live.has(ref) || state.manual.includes(ref) || prev.gone) continue;
    const [owner, name, num] = splitRef(ref);
    let status = STATUS.CLOSED;
    try {
      const d = await graphql(`query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${num}) { ...P } } } ${FRAGMENT}`);
      const pr = d.repository?.pullRequest;
      if (pr) status = classify(pr).status;
    } catch {}
    if (status === STATUS.MERGED || status === STATUS.CLOSED) {
      events.push({ ref, title: prev.title, url: prev.url, headline: status, detail: `Was: ${prev.status}` });
      state.prs[ref] = { ...prev, status, detail: '', badge: 'update', gone: true, changedFrom: prev.status, since: new Date().toISOString() };
    }
  }
  state.init.prs = true;
  return pending;
}

function pollMentions(list, events) {
  const flag = state.init.mentions;
  const next = {};
  for (const pr of list) {
    const ref = refOf(pr);
    const prev = state.mentions[ref];
    const info = mentionInfo(pr, state.login);
    let badge = prev?.badge || null;
    if (!prev && flag) badge = 'new';
    else if (prev && info.count > prev.count) badge = 'update';
    if (flag && (!prev || info.count > prev.count) && info.latest) {
      events.push({ ref, title: pr.title, url: info.latest.url, headline: `${info.latest.author} mentioned you`, detail: info.latest.text });
    }
    next[ref] = { title: pr.title, url: pr.url, author: pr.author?.login, ...info, badge };
  }
  state.mentions = next;
  state.init.mentions = true;
}

function pollReviewing(list, events) {
  const flag = state.init.reviewing;
  const next = {};
  for (const pr of list) {
    const ref = refOf(pr);
    const prev = state.reviewing[ref];
    const info = replyInfo(pr, state.login);
    let badge = prev?.badge || null;
    // New replies = more comments after your last one than last time (resets when you reply).
    const grew = prev && info.newCount > 0 && (info.myLast !== prev.myLast ? false : info.newCount > prev.newCount);
    if (grew || (!prev && flag && info.newCount > 0)) {
      badge = 'update';
      events.push({ ref, title: pr.title, url: info.latest.url, headline: `${info.latest.author} replied`, detail: info.latest.text });
    }
    next[ref] = { title: pr.title, url: pr.url, author: pr.author?.login, ...info, badge };
  }
  state.reviewing = next;
  state.init.reviewing = true;
}

let polling = null;
async function poll() {
  if (polling) return polling;
  polling = (async () => {
    const events = [];
    const errors = [];
    let pending = false;
    try { pending = await pollMyPRs(events); } catch (e) { errors.push(`my PRs: ${e.message}`); }
    try {
      const act = await fetchActivity();
      state.login = act.login;
      pollMentions(act.mentioned, events);
      pollReviewing(act.reviewing, events);
    } catch (e) { errors.push(`mentions/reviews: ${e.message}`); }
    state.lastPoll = new Date().toISOString();
    state.lastError = errors.join(' · ') || null;
    if (errors.length) console.error('poll failed:', state.lastError);
    if (events.length) console.log(state.lastPoll, events.map(e => `${e.ref}: ${e.headline}`).join(' | '));
    notify(events);
    if (pending) setTimeout(poll, 30_000);
    save();
    polling = null;
  })();
  return polling;
}

function dismiss(section, ref) {
  const bucket = state[section];
  if (!bucket) return;
  for (const r of ref ? [ref] : Object.keys(bucket)) {
    if (!bucket[r]) continue;
    if (bucket[r].gone) delete bucket[r];
    else bucket[r].badge = null;
  }
}

// ---------- HTTP ----------
const html = readFileSync(join(DIR, 'index.html'), 'utf8');
const body = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  if (req.method === 'GET' && req.url === '/api/state') {
    return json(res, 200, { ...state, pollMinutes: POLL_MS / 60_000, trackMine: TRACK_MINE });
  }
  if (req.method === 'POST' && req.url === '/api/refresh') { await poll(); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && req.url === '/api/add') {
    const ref = parseRef((await body(req)).pr);
    if (!ref) return json(res, 400, { error: 'Use a PR URL or owner/repo#123' });
    if (!state.manual.includes(ref)) state.manual.push(ref);
    await poll();
    return json(res, 200, { ok: true, ref });
  }
  if (req.method === 'POST' && req.url === '/api/remove') {
    const { ref } = await body(req);
    state.manual = state.manual.filter(r => r !== ref);
    delete state.prs[ref];
    save();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/dismiss') {
    const { section, ref } = await body(req); // ref omitted = dismiss all in section; section omitted = everything
    for (const s of section ? [section] : ['prs', 'mentions', 'reviewing']) dismiss(s, ref);
    save();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/test-notify') {
    notify([{ ref: 'test/repo#1', title: 'Test notification', url: `http://localhost:${PORT}`, headline: STATUS.DRAFT_READY, detail: `Was: ${STATUS.DRAFT_NO_AR}` }]);
    return json(res, 200, { ok: true });
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`PR Status Tracker on http://localhost:${PORT} — polling every ${POLL_MS / 60_000} min`);
  poll();
  setInterval(poll, POLL_MS);
});
