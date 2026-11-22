// Campus Surfers backend. One serverless function, data kept in a Vercel Blob store.
//
// Blob path layout (all data is packed into the file name, so the file bodies stay tiny):
//   n/<slug>~<pid>                       a claimed player name (keeps names unique)
//   p/<pid>~<base64url name>~<joined>    a registered player
//   s/<ts>~<pid>~<score>~<secs>~<dist>~<snacks>~<lap>~<rankIdx>   one finished run

const crypto = require('crypto');

const blobLib = () => import('@vercel/blob');

async function listAll(prefix) {
  const { list } = await blobLib();
  let cursor;
  const out = [];
  do {
    const r = await list({ prefix, limit: 1000, cursor });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function putText(pathname, body) {
  const { put } = await blobLib();
  const opts = { addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain' };
  try {
    return await put(pathname, body, Object.assign({ access: 'public' }, opts));
  } catch (e) {
    if (/private/i.test(String((e && e.message) || ''))) {
      return await put(pathname, body, Object.assign({ access: 'private' }, opts));
    }
    throw e;
  }
}

const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const validPid = pid => typeof pid === 'string' && /^[a-z0-9]{12}$/.test(pid);
const validName = name => typeof name === 'string' && /^[A-Za-z0-9 ._'-]{2,20}$/.test(name) && slugOf(name).length >= 2;
const num = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

// read everything and build per-player stats
async function loadAll() {
  const [pBlobs, sBlobs] = await Promise.all([listAll('p/'), listAll('s/')]);
  const players = new Map();
  pBlobs
    .map(b => b.pathname.slice(2).split('~'))
    .filter(p => p.length >= 3)
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .forEach(([pid, b64, joined]) => {
      let name = pid;
      try { name = Buffer.from(b64, 'base64url').toString('utf8'); } catch (e) {}
      const prev = players.get(pid);
      players.set(pid, {
        pid, name,
        joined: prev ? prev.joined : Number(joined),
        runs: 0, best: 0, bestSecs: 0, bestTs: 0, firstRun: 0, lastRun: 0, totalSecs: 0, totalScore: 0, bestRank: 0
      });
    });
  const runs = [];
  sBlobs.forEach(b => {
    const f = b.pathname.slice(2).replace(/\.txt$/, '').split('~');
    if (f.length < 8) return;
    const run = { ts: Number(f[0]), pid: f[1], score: Number(f[2]), secs: Number(f[3]), dist: Number(f[4]), snacks: Number(f[5]), lap: Number(f[6]), rank: Number(f[7]) };
    const p = players.get(run.pid);
    if (!p) return;
    run.name = p.name;
    runs.push(run);
    p.runs++;
    p.totalSecs += run.secs;
    p.totalScore += run.score;
    if (!p.firstRun || run.ts < p.firstRun) p.firstRun = run.ts;
    if (run.ts > p.lastRun) p.lastRun = run.ts;
    if (run.score > p.best || (run.score === p.best && run.ts < p.bestTs)) {
      p.best = run.score; p.bestSecs = run.secs; p.bestTs = run.ts; p.bestRank = run.rank;
    }
  });
  const board = Array.from(players.values())
    .filter(p => p.runs > 0)
    .sort((a, b) => b.best - a.best || a.bestTs - b.bestTs);
  runs.sort((a, b) => b.ts - a.ts);
  return { players, board, runs };
}

function adminOk(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  const got = String(req.headers['x-admin-key'] || '');
  if (!want) return null;
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(want), h(got));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('a');
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (action === 'ping') return send(200, { ok: true });
    if (!process.env.BLOB_READ_WRITE_TOKEN) return send(503, { error: 'storage_not_connected' });

    // ---- claim a player name ----
    if (req.method === 'POST' && action === 'join') {
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      const pid = body.pid;
      if (!validName(name)) return send(400, { error: 'bad_name' });
      if (!validPid(pid)) return send(400, { error: 'bad_pid' });
      const slug = slugOf(name);
      const mine = `n/${slug}~${pid}`;
      // 1 round trip: is the name already claimed by someone else?
      const existing = await listAll(`n/${slug}~`);
      if (existing.length && !existing.some(b => b.pathname === mine)) return send(409, { error: 'name_taken' });
      // 2 writes in parallel: claim the name and register the player
      const b64 = Buffer.from(name, 'utf8').toString('base64url');
      if (existing.length) return send(200, { pid, name });   // this player already holds the name: nothing to write
      await Promise.all([putText(mine, '1'), putText(`p/${pid}~${b64}~${Date.now()}`, '1')]);
      // 1 round trip: if two people claimed the same name at once, the earliest claim wins
      if (!existing.length) {
        const again = (await listAll(`n/${slug}~`)).sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt) || a.pathname.localeCompare(b.pathname));
        if (again.length && again[0].pathname !== mine) {
          const { del } = await blobLib();
          const lost = again.find(b => b.pathname === mine);
          await Promise.all([lost ? del(lost.url).catch(() => {}) : null, listAll(`p/${pid}~`).then(l => Promise.all(l.map(x => del(x.url).catch(() => {}))))]).catch(() => {});
          return send(409, { error: 'name_taken' });
        }
      }
      return send(200, { pid, name });
    }

    // ---- save a finished run ----
    if (req.method === 'POST' && action === 'score') {
      const pid = body.pid;
      if (!validPid(pid)) return send(400, { error: 'bad_pid' });
      const score = num(body.score, 0, 1000000);
      const secs = num(body.secs, 1, 7200);
      const dist = num(body.dist, 0, 1000000);
      const snacks = num(body.snacks, 0, 999);
      const lap = num(body.lap, 1, 99);
      const rank = num(body.rankIdx, 0, 5);
      if ([score, secs, dist, snacks, lap, rank].includes(null)) return send(400, { error: 'bad_run' });
      // plausibility: top speed is about 18 m/s and every score source is bounded
      if (dist > secs * 30 + 100 || score > dist + snacks * 210 + lap * 100 + secs * 30 + 200) return send(400, { error: 'implausible_run' });
      const known = await listAll(`p/${pid}~`);
      if (!known.length) return send(403, { error: 'unknown_player' });
      await putText(`s/${Date.now()}~${pid}~${score}~${secs}~${dist}~${snacks}~${lap}~${rank}.txt`, '1');
      return send(200, { ok: true });
    }

    // ---- admin dashboard data ----
    if (req.method === 'GET' && action === 'admin') {
      const ok = adminOk(req);
      if (ok === null) return send(503, { error: 'admin_password_not_set' });
      if (!ok) { await new Promise(r => setTimeout(r, 500)); return send(401, { error: 'wrong_password' }); }
      const { players, board, runs } = await loadAll();
      const everyone = Array.from(players.values()).sort((a, b) => b.joined - a.joined);
      return send(200, {
        now: Date.now(),
        totals: {
          players: players.size,
          played: board.length,
          runs: runs.length,
          best: board.length ? board[0].best : 0,
          avgScore: runs.length ? Math.round(runs.reduce((s, r) => s + r.score, 0) / runs.length) : 0,
          totalSecs: runs.reduce((s, r) => s + r.secs, 0)
        },
        board: board.map(({ pid, name, joined, runs, best, bestSecs, bestTs, firstRun, lastRun, totalSecs, bestRank }) => ({ pid, name, joined, runs, best, bestSecs, bestTs, firstRun, lastRun, totalSecs, bestRank })),
        players: everyone.map(p => ({ pid: p.pid, name: p.name, joined: p.joined, runs: p.runs, best: p.best })),
        recent: runs.slice(0, 200)
      });
    }

    return send(404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    return send(500, { error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) });
  }
};
