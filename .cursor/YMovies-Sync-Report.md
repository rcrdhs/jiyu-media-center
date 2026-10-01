# YMovies Sync Report

Generated: 2026-08-28T05:53:39.731Z

## Summary

| Metric | Value |
|---|---|
| **Source** | https://ww.ymovies.vip/movie/filter/series/ |
| **Pages fetched** | 512 (stopped at page 512) |
| **Total titles synced** | **19,942** |
| **Crawl time** | 306.3s |
| **Jiyu scraper version** | 39 |

## Integration status

- **Catalog source:** `builtin-ymovies` — YMovies · TV Series (Library → Websites)
- **Shelf:** TV Series → Full Shows (alongside M2Box / NetMirror)
- **Episodes:** AJAX chain (`/ajax/movie/seasons/`, `/ajax/movie/season/episodes/`, …)
- **Playback:** Web Browser → `watching.html?ep=S_E` (Server A1/A2 in-page)

## Episode API probe (No Game No Life)

- Seasons endpoint: OK
- Season 1 episodes: 12

## Sample titles (page 1)

- No Game No Life (`s1ax4`)
- Hollywood Crime Story the Mob Takes Over the Movies (`s740a`)
- Dalliance (`s731o`)
- Bluey Book Reads (`s5ibe`)
- The Fabulous Five (`s1yuu`)
- Mom Knows Best? (`s740k`)
- The Airport Chaplain (`s707z`)
- Vikings, The Making Of An Empire (`s61it`)

## NetMirror overlap

NetMirror/freemovies.lol returned **522** during probe — direct poster overlap not measured.
YMovies catalog is ~19,942 show-level entries vs NetMirror ~4,650 when online.

## Next launch

Jiyu will auto-sync YMovies on startup (scraper v39 bump). Open **Library → Sync** if the shelf is empty.

---
*Report written by `scripts/sync-ymovies-catalog.cjs`*
