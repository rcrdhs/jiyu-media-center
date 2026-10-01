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

async function cdp(wsUrl, method, params = {}, timeoutMs = 180000) {
  const WebSocket = require('ws')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const id = 1
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error('CDP timeout ' + method))
    }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })))
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
  if (!page) throw new Error('no page')

  const expression = `(() => new Promise(async (resolve, reject) => {
    try {
      const catalog = window.signalDesktop?.tmdbTvCatalog;
      if (!catalog) return reject(new Error('no tmdbTvCatalog'));
      const result = await catalog('animation', 400, { withExternalIds: false });
      if (!result.ok) return reject(new Error(result.error || 'failed'));
      const ANIME_LANGS = new Set(['ja','ko','zh','th']);
      const ADULT = /\\b(south park|family guy|american dad|rick and morty|futurama|the simpsons)\\b/i;
      const counts = { anime: 0, kids: 0, series: 0 };
      const samples = { anime: [], kids: [], series: [] };
      for (const show of result.shows || []) {
        const title = show.name || '';
        const lang = String(show.originalLanguage || '').toLowerCase();
        const genres = show.genreIds || [];
        const adult = ADULT.test(title);
        let bucket = 'series';
        if (genres.includes(10762) && !adult) bucket = 'kids';
        else if (ANIME_LANGS.has(lang)) bucket = 'anime';
        else if (genres.includes(10751) && !adult) bucket = 'kids';
        counts[bucket]++;
        if (samples[bucket].length < 8) samples[bucket].push(title);
      }
      resolve({ total: result.shows.length, counts, samples, hasLang: result.shows.filter(s => s.originalLanguage).length });
    } catch (e) {
      reject(e);
    }
  }))()`

  const r = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(JSON.stringify(r.result?.value, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
