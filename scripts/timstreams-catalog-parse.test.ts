/**
 * Tim Streams catalog mapping (public /api shape, no network).
 * Run: npx tsx scripts/timstreams-catalog-parse.test.ts
 */
import assert from 'node:assert/strict'
import {
  playableTimStreamsMirrors,
  timStreamsChannelToItem,
  timStreamsChannelsToItems,
  timStreamsEventToItem,
  timStreamsItemSportId,
  timStreamsLiveUpcomingToItems,
  timStreamsSportChipsFromItems,
  type TimStreamsLiveUpcoming,
} from '../src/lib/timStreams'
import {
  isSportsAlwaysLiveItem,
  isSportsLiveNowItem,
  isSportsUpcomingItem,
} from '../src/lib/streamed'

const NOW = Date.parse('2026-11-23T07:30:00Z')

const LIVE: TimStreamsLiveUpcoming = {
  genres: [
    {
      id: 7,
      name: 'Basketball',
      sub_categories: [{ id: 1, name: 'National Basketball Association', featured: true }],
    },
    {
      id: 8,
      name: 'American Football',
      sub_categories: [{ id: 1, name: 'National Football League', featured: true }],
    },
    {
      id: 2,
      name: 'Motorsport',
      sub_categories: [{ id: 2, name: 'Floracing' }],
    },
  ],
  events: [
    {
      url: 'oklahoma-city-thunder-v-miami-heat-401910030',
      name: 'Oklahoma City Thunder @ Miami Heat',
      logo: '/img/nba-401910030.png',
      genre: 7,
      sub_genre: 1,
      time: '2026-11-22T18:00',
      isevent: true,
      vip: false,
      streams: [
        { name: 'NBA League Pass', url: 'https://shoewiki.click/zoyv27d5-1443', vip: false },
        { name: 'Backup', url: 'https://shoewiki.click/backup-heat', vip: false },
        { name: '4K HEVC', url: 'https://shoewiki.click/vip-heat', vip: true },
      ],
    },
    {
      url: 'vikings-v-49ers-401873077',
      name: 'Vikings @ 49ers',
      genre: 8,
      sub_genre: 1,
      time: '2026-11-22T20:20',
      isevent: true,
      vip: false,
      streams: [{ name: 'NBC', url: 'https://shoewiki.click/bdl7my34-491', vip: false }],
    },
    {
      url: 'vip-only-event',
      name: 'VIP Only',
      genre: 7,
      time: '2026-11-22T18:00',
      vip: false,
      streams: [{ name: 'VIP', url: 'https://shoewiki.click/vip-only', vip: true }],
    },
  ],
}

const nba = timStreamsEventToItem(LIVE.events![0], LIVE.genres, NOW)
assert.ok(nba, 'NBA event should become a shelf row')
assert.equal(nba?.category, 'sports')
assert.equal(nba?.tags?.includes('timstreams'), true)
assert.equal(nba?.tags?.includes('basketball'), true)
assert.equal(nba?.url, 'https://shoewiki.click/zoyv27d5-1443')
assert.equal(nba?.sportsAltSources?.length, 1, 'VIP mirror must be excluded; one clear backup remains')
assert.equal(nba?.sportsAltSources?.[0].url, 'https://shoewiki.click/backup-heat')
assert.equal(nba?.poster, 'https://tim-streams.com/img/nba-401910030.png')
assert.match(String(nba?.title), / · TS$/)
assert.equal(timStreamsItemSportId(nba!), 'basketball')

const nfl = timStreamsEventToItem(LIVE.events![1], LIVE.genres, NOW)
assert.equal(nfl?.tags?.includes('american-football'), true)
assert.equal(nfl?.sportsAltSources, undefined)

const vipOnly = timStreamsEventToItem(LIVE.events![2], LIVE.genres, NOW)
assert.equal(vipOnly, null, 'events with only VIP mirrors stay off the shelf')

const liveItems = timStreamsLiveUpcomingToItems(LIVE, NOW)
assert.equal(liveItems.length, 2)

const f1 = timStreamsChannelToItem(
  {
    url: 'sky-sports-f1',
    name: 'Sky Sports F1',
    genre: 2,
    streams: [
      { name: 'English', url: 'https://shoewiki.click/f596f98r-6977', vip: false },
      { name: 'Italian', url: 'https://shoewiki.click/t5mpn192-6504', vip: false },
      { name: 'German', url: 'https://shoewiki.click/78hy66n6-8198', vip: false },
      { name: '4K HEVC', url: 'https://shoewiki.click/c89vxrvc-5087', vip: true },
    ],
  },
  NOW,
)
assert.ok(f1)
assert.equal(f1?.category, 'sports')
assert.equal(f1?.tags?.includes('24/7-streams'), true)
assert.equal(f1?.tags?.includes('motorsports'), true)
assert.equal(f1?.url, 'https://shoewiki.click/f596f98r-6977')
assert.equal(f1?.sportsAltSources?.length, 2, 'English primary, Italian+German backups, VIP skipped')
assert.equal(f1?.sportsAltSources?.[0].label, 'Italian')
assert.equal(f1?.sportsAltSources?.[1].label, 'German')
assert.doesNotMatch(String(f1?.description), /TimStreams/i)
assert.equal(nba?.sportsAltSources?.[0].label, 'Backup')
assert.doesNotMatch(String(nba?.description), /TimStreams/i)

const cnn = timStreamsChannelToItem(
  {
    url: 'cnn',
    name: 'CNN',
    genre: 5,
    flag: 'us',
    streams: [{ name: 'TimStreams', url: 'https://shoewiki.click/jmbt4tra-3346', vip: false }],
  },
  NOW,
)
assert.equal(cnn?.category, 'sports')
assert.equal(cnn?.tags?.includes('24/7-streams'), true)
assert.equal(cnn?.tags?.includes('always-live'), true)
assert.equal(isSportsAlwaysLiveItem(cnn!), true)
assert.equal(isSportsLiveNowItem(cnn!, NOW), false, '24/7 channels must not sit on Sports Live')
assert.equal(isSportsUpcomingItem(cnn!, NOW), false, '24/7 channels must not sit on Sports Upcoming')
assert.doesNotMatch(String(cnn?.description), /TimStreams/i)

const nick = timStreamsChannelToItem(
  {
    url: 'nickelodeon',
    name: 'Nickelodeon',
    genre: 3,
    streams: [{ name: 'TimStreams', url: 'https://shoewiki.click/nick', vip: false }],
  },
  NOW,
)
assert.equal(nick?.category, 'kids')
assert.equal(nick?.tags?.includes('kids-live'), true)

const amc = timStreamsChannelToItem(
  {
    url: 'amc',
    name: 'AMC',
    genre: 1,
    streams: [{ name: 'TimStreams', url: 'https://shoewiki.click/amc', vip: false }],
  },
  NOW,
)
assert.equal(amc?.category, 'series')
assert.equal(amc?.tags?.includes('247-series'), true)

const channels = timStreamsChannelsToItems({
  channels: [
    { url: 'sky-sports-f1', name: 'Sky Sports F1', genre: 2, streams: f1 && [{ name: 'English', url: f1.url, vip: false }] },
    { url: 'cnn', name: 'CNN', genre: 5, streams: [{ name: 'TimStreams', url: 'https://shoewiki.click/jmbt4tra-3346', vip: false }] },
  ],
})
const chips = timStreamsSportChipsFromItems([...liveItems, ...channels, nick!, amc!])
const ids = chips.map((c) => c.id).sort()
assert.ok(ids.includes('basketball'))
assert.ok(ids.includes('american-football'))
assert.ok(ids.includes('motorsports') || ids.includes('24/7-streams'))
assert.ok(!ids.includes('kids-live'), 'kids/series channels must not become sports chips')

assert.equal(
  playableTimStreamsMirrors([
    { name: 'A', url: 'https://shoewiki.click/a', vip: false },
    { name: 'A-dup', url: 'https://shoewiki.click/a', vip: false },
    { name: 'VIP', url: 'https://shoewiki.click/v', vip: true },
  ]).length,
  1,
)

console.log('timstreams-catalog-parse: ok', liveItems.length, 'events,', 'f1 mirrors', f1?.sportsAltSources?.length)
