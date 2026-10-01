/**
 * Dump Anime Full Shows that are not from SubsPlease via Electron CDP.
 */
const http = require('http')

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function cdp(wsUrl, method, params = {}) {
  const WebSocket = (await import('ws')).default
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const id = 1
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error('CDP timeout ' + method))
    }, 60000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }))
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id === id) {
        clearTimeout(timer)
        ws.close()
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function main() {
  const targets = await get('http://127.0.0.1:9229/json')
  const page =
    targets.find((t) => /localhost:5173/i.test(t.url) && t.type === 'page') ||
    targets.find((t) => t.type === 'page')
  if (!page) {
    console.error('No page target. Targets:', JSON.stringify(targets, null, 2))
    process.exit(1)
  }

  // Use Fetch domain via simpler Runtime.evaluate over HTTP /json/runtime/evaluate isn't available;
  // use websocket.
  const expression = `(() => new Promise(async (resolve, reject) => {
    try {
      const req = indexedDB.open('jiyu-torrent-catalog', 1);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('items', 'readonly');
        const getAll = tx.objectStore('items').getAll();
        getAll.onerror = () => reject(getAll.error || new Error('getAll failed'));
        getAll.onsuccess = () => {
          const items = getAll.result || [];
          const isSubs = (it) => {
            const u = String(it.url || '') + ' ' + String(it.detailUrl || '') + ' ' + String(it.source || '');
            return it.torrentSourceId === 'builtin-subsplease'
              || /subsplease/i.test(u)
              || /subsplease/i.test(String(it.torrentSourceId || ''));
          };
          const hasTag = (it, tag) => (it.tags || []).some((t) => String(t).toLowerCase() === tag);
          const parseEp = (title) => /\\s[-–]\\s*0*\\d{1,3}(?:\\s|$|v\\d)/i.test(String(title || ''));
          const isTmdb = (it) => it.torrentSourceId === 'builtin-tmdb-anime'
            || /^jiyu:\\/\\/tmdb-tv\\//i.test(String(it.url || ''))
            || /^jiyu:\\/\\/tmdb-tv\\//i.test(String(it.detailUrl || ''));
          const isSingleEp = (it) => {
            if (it.category !== 'anime') return false;
            if (isTmdb(it)) return false;
            if (!(it.torrentUri && /magnet:\\?|\\.torrent/i.test(String(it.torrentUri)))) return false;
            return parseEp(it.title);
          };
          const isNew = (it) => {
            if (it.category !== 'anime') return false;
            if (hasTag(it, 'new-releases')) return true;
            if (hasTag(it, 'full-shows') && !isSingleEp(it)) return false;
            return isSingleEp(it);
          };
          const isFull = (it) => {
            if (it.category !== 'anime') return false;
            if (isNew(it) || isSingleEp(it)) return false;
            if (hasTag(it, 'full-shows')) return true;
            if (isTmdb(it)) return true;
            if (it.sourceKind === 'torrent' || it.transport === 'torrent') {
              return !parseEp(it.title);
            }
            return false;
          };
          const full = items.filter(isFull);
          const nonSubs = full.filter((it) => !isSubs(it));
          const bySource = {};
          for (const it of nonSubs) {
            const k = it.torrentSourceId || it.source || 'unknown';
            bySource[k] = (bySource[k] || 0) + 1;
          }
          const titles = [...new Set(nonSubs.map((it) => String(it.title || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
          resolve({
            totalItems: items.length,
            animeFullShows: full.length,
            nonSubsPlease: nonSubs.length,
            bySource,
            titles,
          });
        };
      };
    } catch (e) {
      reject(e);
    }
  }))()`

  // Prefer chrome DevTools Protocol via ws. Check if `ws` is available.
  let result
  try {
    require.resolve('ws')
    const r = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    result = r.result?.value
  } catch (err) {
    // Fallback: use Playwright/puppeteer-less HTTP endpoint via /json/protocol not available.
    // Use Node 22 experimental websocket if present.
    if (typeof WebSocket === 'undefined') {
      // Node built-in fetch to hit nothing — install-free CDP via raw TCP is hard.
      // Try undici/ws from electron's node_modules
      const wsPath = require('path').join(
        process.cwd(),
        'node_modules',
        'electron',
        'node_modules',
        'ws',
      )
      throw new Error('ws module missing: ' + err.message)
    }
  }

  const outPath = require('path').join(process.cwd(), 'reports', 'anime-full-non-subsplease.json')
  require('fs').mkdirSync(require('path').dirname(outPath), { recursive: true })
  require('fs').writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({
    page: page.url,
    totalItems: result.totalItems,
    animeFullShows: result.animeFullShows,
    nonSubsPlease: result.nonSubsPlease,
    bySource: result.bySource,
    titleCount: result.titles.length,
    outPath,
  }, null, 2))
  // Print titles for the user-facing answer
  console.log('---TITLES---')
  for (const t of result.titles) console.log(t)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
