#!/usr/bin/env node
// PR Status Tracker — local tool. Polls GitHub (via the `gh` CLI) every 5 minutes and shows:
//   1. My PRs       — classified into review statuses; pop-up when a status changes
//   2. Mentioned    — open PRs where someone @-mentioned you (description or comments)
//   3. Reviewing    — open PRs by others you commented on / reviewed, with replies since your last comment
// Every PR gets auto-generated "next steps". Anything new or changed is flagged NEW / UPDATE
// (and its new next steps highlighted) until you dismiss it. PRs you mark deprioritised sink
// to the bottom and stop popping up.
//
//   node server.mjs            -> http://localhost:4777
//
// Env:
//   PORT=4777                  dashboard port
//   POLL_MINUTES=5             poll interval
//   NOTIFY=alert|banner        alert = dialog that stays until dismissed (default); banner = Notification Center
//   TRACK_MINE=1|0             auto-track every open PR you authored (default 1)
//   VOLUME=4                   ding loudness (1 = normal system level; higher is louder)

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
const VOLUME = String(process.env.VOLUME || 4);

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
// prs/mentions/reviewing: { "owner/repo#123": { title, url, badge: 'new'|'update'|null, steps: [{id,text,url}], newSteps: [id], ... } }
// deprioritised: ["owner/repo#123"] — applies in every section
let state = { manual: [], deprioritised: [], prs: {}, mentions: {}, reviewing: {}, init: {}, login: null, lastPoll: null, lastError: null };
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
  latestReviews(first: 20) { nodes { author { login } state } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { name conclusion status detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved path comments(first: 1) { nodes { body url author { login } } } } }
}`;

// Everything written on a PR, for mention / reply detection.
const ACTIVITY = `fragment A on PullRequest {
  number title url createdAt
  repository { nameWithOwner }
  author { login }
  body
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } } } }
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
const firstComment = t => t.comments?.nodes?.[0] || {};
const openThreads = pr => (pr.reviewThreads?.nodes || [])
  .filter(t => !t.isResolved && !/Adversarial Review: High Risk/.test(firstComment(t).body || ''));

export function classify(pr) {
  if (pr.state === 'MERGED') return { status: STATUS.MERGED, detail: '' };
  if (pr.state === 'CLOSED') return { status: STATUS.CLOSED, detail: '' };

  const threads = pr.reviewThreads?.nodes || [];
  const openAll = openThreads(pr);
  const openAR = openAll.filter(t => AR_FINDING.test(firstComment(t).body || ''));
  const hasAR = (pr.reviews?.nodes || []).some(r => AR_SUMMARY.test(r.body || ''))
    || threads.some(t => AR_FINDING.test(firstComment(t).body || ''));

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

const snippet = (s, n = 140) => String(s || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '')
  .replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

// Checks on the head commit. A check name counts as failing/pending only if no run of it succeeded (reruns).
function checks(pr) {
  const roll = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!roll) return { failing: [], pending: [] };
  const runs = (roll.contexts?.nodes || []).map(c => c.__typename === 'CheckRun'
    ? { name: c.name, url: c.detailsUrl, ok: ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion), bad: ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.conclusion), wait: c.status !== 'COMPLETED' }
    : { name: c.context, url: c.targetUrl, ok: c.state === 'SUCCESS', bad: ['FAILURE', 'ERROR'].includes(c.state), wait: ['PENDING', 'EXPECTED'].includes(c.state) });
  const okNames = new Set(runs.filter(r => r.ok).map(r => r.name));
  const uniq = list => [...new Map(list.filter(r => !okNames.has(r.name)).map(r => [r.name, r])).values()];
  return { failing: uniq(runs.filter(r => r.bad)), pending: uniq(runs.filter(r => r.wait)) };
}

// Concrete to-do list for one of your PRs. Step ids are stable so we can tell which steps are new.
export function nextStepsForMine(pr, status) {
  if (status === STATUS.MERGED) return [{ id: 'done', text: 'Merged — nothing left to do. Dismiss to clear it.' }];
  if (status === STATUS.CLOSED) return [{ id: 'done', text: 'Closed — nothing left to do. Dismiss to clear it.' }];
  const steps = [];
  const { failing, pending } = checks(pr);
  const threads = openThreads(pr);
  const arThreads = threads.filter(t => AR_FINDING.test(firstComment(t).body || ''));
  const humanThreads = threads.filter(t => !AR_FINDING.test(firstComment(t).body || ''));
  const threadStep = (t, verb) => {
    const c = firstComment(t);
    const sev = (c.body || '').match(AR_FINDING)?.[1];
    return { id: `thread:${c.url}`, url: c.url,
      text: sev ? `${verb} ${sev} finding${t.path ? ` in ${t.path}` : ''}: ${snippet(c.body)}`
                : `${verb} ${c.author?.login || 'reviewer'}${t.path ? ` on ${t.path}` : ''}: ${snippet(c.body)}` };
  };
  const capped = (list, verb) => {
    const out = list.slice(0, 8).map(t => threadStep(t, verb));
    if (list.length > 8) out.push({ id: `more:${verb}`, text: `…and ${list.length - 8} more`, url: pr.url + '/files' });
    return out;
  };

  if (pr.mergeable === 'CONFLICTING') steps.push({ id: 'conflicts', text: 'Resolve merge conflicts with the base branch', url: pr.url });
  else if (pr.mergeStateStatus === 'BEHIND') steps.push({ id: 'behind', text: 'Update the branch with the base branch', url: pr.url });
  failing.forEach(c => steps.push({ id: `check:${c.name}`, text: `Fix failing check: ${c.name}`, url: c.url }));

  switch (status) {
    case STATUS.DRAFT_NO_AR:
      steps.push({ id: 'run-ar', text: 'Run the adversarial review (/adversarial-review-scale)', url: pr.url });
      break;
    case STATUS.DRAFT_AR_COMMENTS:
      steps.push(...capped(arThreads, 'Address'));
      break;
    case STATUS.DRAFT_READY:
      if (humanThreads.length) steps.push(...capped(humanThreads, 'Reply to'));
      if (!failing.length) steps.push({ id: 'mark-ready', text: 'Mark the PR ready for review', url: pr.url });
      break;
    case STATUS.READY_COMMENTS:
    case STATUS.READY_AWAITING: {
      (pr.latestReviews?.nodes || []).filter(r => r.state === 'CHANGES_REQUESTED').forEach(r =>
        steps.push({ id: `cr:${r.author?.login}`, text: `Address changes requested by ${r.author?.login}, then re-request their review`, url: pr.url }));
      steps.push(...capped(arThreads, 'Address'), ...capped(humanThreads, 'Reply to / resolve'));
      if (status === STATUS.READY_AWAITING) {
        const requested = (pr.reviewRequests?.nodes || []).map(r => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean);
        const approved = (pr.latestReviews?.nodes || []).some(r => r.state === 'APPROVED');
        if (pending.length) steps.push({ id: 'pending-checks', text: `Wait for checks to finish: ${pending.map(c => c.name).slice(0, 5).join(', ')}`, url: pr.url + '/checks' });
        if (requested.length) steps.push({ id: `waiting:${requested.sort().join(',')}`, text: `Waiting on review from ${requested.join(', ')} — nudge if it's been a while`, url: pr.url });
        else if (!approved) steps.push({ id: 'request-review', text: 'Request a reviewer', url: pr.url });
      }
      break;
    }
    case STATUS.MERGEABLE:
      steps.push({ id: 'merge', text: 'Merge the PR', url: pr.url });
      break;
  }
  if (!steps.length) steps.push({ id: 'none', text: 'Nothing to do right now — waiting on GitHub', url: pr.url });
  return steps;
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
const lc = s => s.toLowerCase();

export function mentionInfo(pr, login) {
  const re = new RegExp(`@${login}(?![\\w-])`, 'i');
  const hits = items(pr).filter(i => lc(i.login) !== lc(login) && re.test(i.body));
  const last = hits.at(-1);
  // Mentions you haven't answered = mentions after your last comment on the PR.
  const myLast = items(pr).filter(i => !i.isDescription && lc(i.login) === lc(login)).at(-1)?.createdAt || '';
  const unanswered = hits.filter(h => h.createdAt > myLast);
  const steps = unanswered.slice(-5).map(h => ({ id: `mention:${h.url}`, url: h.url,
    text: `Respond to ${h.login}'s mention${h.isDescription ? ' in the description' : ''}: ${snippet(h.body)}` }));
  if (!steps.length) steps.push({ id: 'none', text: 'You’ve replied since the last mention — nothing to do', url: pr.url });
  return { count: hits.length, steps,
    latest: last && { author: last.login, text: snippet(last.body, 160), url: last.url, createdAt: last.createdAt, where: last.isDescription ? 'description' : 'comment' } };
}

export function replyInfo(pr, login) {
  const all = items(pr).filter(i => !i.isDescription);
  const myLast = all.filter(i => lc(i.login) === lc(login)).at(-1)?.createdAt || '';
  const after = all.filter(i => lc(i.login) !== lc(login) && i.createdAt > myLast);
  const last = after.at(-1);
  const reRequested = (pr.reviewRequests?.nodes || []).some(r => lc(r.requestedReviewer?.login || '') === lc(login));
  const steps = [];
  if (reRequested) steps.push({ id: 'review-requested', text: 'Your review is requested — review the latest changes', url: pr.url + '/files' });
  after.slice(-5).forEach(a => steps.push({ id: `reply:${a.url}`, url: a.url, text: `Read & respond to ${a.login}: ${snippet(a.body)}` }));
  if (!steps.length) steps.push({ id: 'none', text: 'Nothing new — waiting on the author', url: pr.url });
  return { newCount: after.length, myLast, steps,
    latest: last && { author: last.login, text: snippet(last.body, 160), url: last.url, createdAt: last.createdAt } };
}

// Carry forward "new step" highlights until dismissed; mark steps that weren't there last poll.
function diffSteps(prev, steps, flag) {
  const prevIds = new Set((prev?.steps || []).map(s => s.id));
  const ids = new Set(steps.map(s => s.id));
  // prev without steps = state from before next steps existed; treat as a baseline, not a change.
  const fresh = prev?.steps && flag ? steps.filter(s => !prevIds.has(s.id) && s.id !== 'none').map(s => s.id) : [];
  const carried = (prev?.newSteps || []).filter(id => ids.has(id));
  return { newSteps: [...new Set([...carried, ...fresh])], changed: fresh.length > 0 };
}

// ---------- notifications ----------
function osa(lines, args) {
  spawn('osascript', [...lines.flatMap(l => ['-e', l]), ...args], { detached: true, stdio: 'ignore' }).unref();
}

// events: [{ ref, title, url, headline, detail }]
function notify(events) {
  events = events.filter(e => !state.deprioritised.includes(e.ref));
  if (!events.length) return;
  const one = events.length === 1 ? events[0] : null;
  const title = one ? `${one.ref}: ${one.headline}` : `${events.length} PR updates`;
  const msg = one ? `${one.title}${one.detail ? `\n\n${one.detail}` : ''}` : events.map(e => `• ${e.ref}: ${e.headline}`).join('\n');
  const openUrl = one ? one.url : `http://localhost:${PORT}`;

  if (NOTIFY === 'banner') {
    osa(['on run argv', 'display notification (item 1 of argv) with title "PR Status" subtitle (item 2 of argv)', 'end run'], [msg, title]);
    return ding();
  }
  osa([
    'on run argv',
    'set r to display alert (item 2 of argv) message (item 1 of argv) buttons {"Dismiss", "Open"} default button "Open" giving up after 3600',
    'if button returned of r is "Open" then open location (item 3 of argv)',
    'end run',
  ], [msg, title, openUrl]);
  ding();
}

// Louder than the stock notification sound: afplay's -v scales the volume (1 = normal).
function ding() {
  spawn('afplay', ['-v', VOLUME, '/System/Library/Sounds/Glass.aiff'], { detached: true, stdio: 'ignore' }).unref();
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
    const steps = nextStepsForMine(pr, next);
    const { newSteps, changed } = diffSteps(prev, steps, flag);
    let badge = prev?.badge || null;
    if (prev && prev.status !== next) {
      badge = 'update';
      events.push({ ref, title: pr.title, url: pr.url, headline: next, detail: `Was: ${prev.status}\n\nNext: ${steps[0].text}` });
    } else if (!prev && flag) badge = 'new';
    else if (changed && !badge) badge = 'update'; // e.g. a new review comment or failing check — UI flag only
    state.prs[ref] = { status: next, detail, title: pr.title, url: pr.url, badge, steps, newSteps,
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
      const steps = nextStepsForMine(null, status);
      events.push({ ref, title: prev.title, url: prev.url, headline: status, detail: `Was: ${prev.status}` });
      state.prs[ref] = { ...prev, status, detail: '', badge: 'update', gone: true, steps, newSteps: steps.map(s => s.id),
        changedFrom: prev.status, since: new Date().toISOString() };
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
    const { newSteps } = diffSteps(prev, info.steps, flag);
    let badge = prev?.badge || null;
    if (!prev && flag) badge = 'new';
    else if (prev && info.count > prev.count) badge = 'update';
    if (flag && (!prev || info.count > prev.count) && info.latest) {
      events.push({ ref, title: pr.title, url: info.latest.url, headline: `${info.latest.author} mentioned you`, detail: info.latest.text });
    }
    next[ref] = { title: pr.title, url: pr.url, author: pr.author?.login, ...info, badge,
      newSteps: !prev && flag ? info.steps.filter(s => s.id !== 'none').map(s => s.id) : newSteps };
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
    const { newSteps, changed } = diffSteps(prev, info.steps, flag);
    let badge = prev?.badge || null;
    // New replies = more comments after your last one than last time (resets when you reply).
    const grew = prev ? info.myLast === prev.myLast && info.newCount > prev.newCount : flag && info.newCount > 0;
    if (grew) {
      badge = 'update';
      events.push({ ref, title: pr.title, url: info.latest.url, headline: `${info.latest.author} replied`, detail: info.latest.text });
    } else if (changed && !badge) badge = 'update'; // e.g. your review was re-requested
    next[ref] = { title: pr.title, url: pr.url, author: pr.author?.login, ...info, badge, newSteps };
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
    else { bucket[r].badge = null; bucket[r].newSteps = []; }
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
  if (req.method === 'POST' && req.url === '/api/deprioritise') {
    const { ref, on } = await body(req);
    state.deprioritised = state.deprioritised.filter(r => r !== ref);
    if (on && ref) state.deprioritised.push(ref);
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
