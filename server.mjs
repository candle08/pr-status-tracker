#!/usr/bin/env node
// PR Status Tracker — local tool. Polls GitHub (via the `gh` CLI) every 5 minutes,
// classifies each PR, and pops up a macOS notification when a status changes.
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
// { manual: ["owner/repo#123"], prs: { "owner/repo#123": { status, title, url, detail, since } }, lastPoll, lastError }
let state = { manual: [], prs: {}, lastPoll: null, lastError: null };
if (existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch {}
}
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ---------- GitHub ----------
const FRAGMENT = `fragment P on PullRequest {
  number title url isDraft state mergeable mergeStateStatus reviewDecision
  repository { nameWithOwner }
  reviews(last: 50) { nodes { body } }
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { body } } } }
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
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/) || s.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

async function fetchPRs() {
  const parts = [];
  if (TRACK_MINE) {
    parts.push(`mine: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50) {
      nodes { ...P } }`);
  }
  state.manual.forEach((ref, i) => {
    const [, owner, name, num] = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    parts.push(`m${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      pullRequest(number: ${num}) { ...P } }`);
  });
  if (!parts.length) return [];
  const data = await graphql(`query { ${parts.join('\n')} } ${FRAGMENT}`);
  const prs = [...(data.mine?.nodes || [])];
  state.manual.forEach((_, i) => { const p = data[`m${i}`]?.pullRequest; if (p) prs.push(p); });
  const seen = new Set();
  return prs.filter(p => p?.number && !seen.has(p.url) && seen.add(p.url));
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

// ---------- notifications ----------
function osa(lines, args) {
  const p = spawn('osascript', [...lines.flatMap(l => ['-e', l]), ...args], { detached: true, stdio: 'ignore' });
  p.unref();
}

function notify(changes) {
  if (!changes.length) return;
  const one = changes.length === 1 ? changes[0] : null;
  const title = one ? `${one.ref} → ${one.to}` : `${changes.length} PRs changed status`;
  const msg = one
    ? `${one.title}\n\nWas: ${one.from}`
    : changes.map(c => `• ${c.ref}: ${c.to}`).join('\n');
  const openUrl = one ? one.url : `http://localhost:${PORT}`;

  if (NOTIFY === 'banner') {
    osa(['on run argv', 'display notification (item 1 of argv) with title "PR Status" subtitle (item 2 of argv) sound name "Glass"', 'end run'],
      [msg, title]);
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
let polling = null;
async function poll() {
  if (polling) return polling;
  polling = (async () => {
    try {
      const prs = await fetchPRs();
      const changes = [];
      const live = new Set();
      let pending = false;
      for (const pr of prs) {
        const ref = `${pr.repository.nameWithOwner}#${pr.number}`;
        live.add(ref);
        const prev = state.prs[ref];
        const { status, detail } = classify(pr);
        if (!status && !prev) { pending = true; continue; } // mergeability not computed yet — retry shortly
        if (!status) pending = true;
        const next = status || prev.status;
        if (prev && prev.status !== next) changes.push({ ref, title: pr.title, url: pr.url, from: prev.status, to: next });
        state.prs[ref] = { status: next, detail, title: pr.title, url: pr.url,
          since: prev && prev.status === next ? prev.since : new Date().toISOString() };
      }
      // PRs that left the "my open PRs" search (merged/closed) — look them up once to report the final state.
      for (const ref of Object.keys(state.prs)) {
        if (live.has(ref)) continue;
        if (!state.manual.includes(ref)) {
          const [, owner, name, num] = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
          try {
            const d = await graphql(`query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${num}) { ...P } } } ${FRAGMENT}`);
            const pr = d.repository?.pullRequest;
            const { status } = pr ? classify(pr) : { status: STATUS.CLOSED };
            const prev = state.prs[ref];
            if (status && status !== prev.status && (status === STATUS.MERGED || status === STATUS.CLOSED)) {
              changes.push({ ref, title: prev.title, url: prev.url, from: prev.status, to: status });
            }
          } catch {}
          delete state.prs[ref];
        }
      }
      state.lastPoll = new Date().toISOString();
      state.lastError = null;
      notify(changes);
      if (pending) setTimeout(poll, 30_000);
      if (changes.length) console.log(new Date().toISOString(), changes.map(c => `${c.ref}: ${c.from} -> ${c.to}`).join(' | '));
    } catch (e) {
      state.lastError = e.message;
      console.error('poll failed:', e.message);
    } finally {
      save();
      polling = null;
    }
  })();
  return polling;
}

// ---------- HTTP ----------
const html = readFileSync(join(DIR, 'index.html'), 'utf8');
const body = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  if (req.method === 'GET' && req.url === '/api/state') {
    return json(res, 200, { ...state, pollMinutes: POLL_MS / 60_000, trackMine: TRACK_MINE, nextPoll: state.lastPoll ? new Date(Date.parse(state.lastPoll) + POLL_MS).toISOString() : null });
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
  if (req.method === 'POST' && req.url === '/api/test-notify') {
    notify([{ ref: 'test/repo#1', title: 'Test notification', url: `http://localhost:${PORT}`, from: STATUS.DRAFT_NO_AR, to: STATUS.DRAFT_READY }]);
    return json(res, 200, { ok: true });
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`PR Status Tracker on http://localhost:${PORT} — polling every ${POLL_MS / 60_000} min`);
  poll();
  setInterval(poll, POLL_MS);
});
