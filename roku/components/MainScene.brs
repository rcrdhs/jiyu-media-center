' Hardcoded NNN livestream page — always the current on-air show, never a single VODs id.
function nnnLiveUrl() as string
  return "https://www.youtube.com/@nnn-RADIOLIVE/live"
end function

sub init()
  m.status = m.top.findNode("status")
  m.rows = m.top.findNode("rows")
  m.nav = m.top.findNode("nav")
  m.stageTitle = m.top.findNode("stageTitle")
  m.stageBlurb = m.top.findNode("stageBlurb")
  m.sidebar = m.top.findNode("sidebar")
  m.sidebarEdge = m.top.findNode("sidebarEdge")
  m.brand = m.top.findNode("brand")
  m.brandLogo = m.top.findNode("brandLogo")
  m.brandTag = m.top.findNode("brandTag")
  m.browseLabel = m.top.findNode("browseLabel")
  m.watchLabel = m.top.findNode("watchLabel")
  m.watchHint = m.top.findNode("watchHint")
  m.syncBar = m.top.findNode("syncBar")
  m.syncBarTrack = m.top.findNode("syncBarTrack")
  m.syncBarFill = m.top.findNode("syncBarFill")
  m.syncBarMsg = m.top.findNode("syncBarMsg")
  m.syncBarPct = m.top.findNode("syncBarPct")
  m.homeCounter = m.top.findNode("homeCounter")
  m.homeCounterLabel = m.top.findNode("homeCounterLabel")
  m.homeCounterValue = m.top.findNode("homeCounterValue")
  m.homeCounterSub = m.top.findNode("homeCounterSub")
  m.video = m.top.findNode("video")
  m.playerShade = m.top.findNode("playerShade")
  m.playStatus = m.top.findNode("playStatus")
  m.choiceShade = m.top.findNode("choiceShade")
  m.choiceTitle = m.top.findNode("choiceTitle")
  m.choiceHint = m.top.findNode("choiceHint")
  m.choiceList = m.top.findNode("choiceList")
  m.catalog = invalid
  m.sectionId = "home"
  m.focusTarget = "rows"
  m.playing = false
  m.bufferStarted = 0
  m.bufferTimer = invalid
  m.bufferReloaded = false
  m.choiceOpen = false
  m.choiceActions = []
  m.fxRetry = 0
  m.syncPct = 8
  m.deviceProfile = ensureDeviceProfile()
  m.maxHeight = m.deviceProfile.maxHeight
  if m.brandTag <> invalid
    m.brandTag.text = "自由 · " + UCase(Left(m.deviceProfile.deviceClass, 1)) + Mid(m.deviceProfile.deviceClass, 2)
  end if

  m.rows.observeField("rowItemSelected", "onItemSelected")
  m.video.observeField("state", "onVideoState")
  if m.choiceList <> invalid
    m.choiceList.observeField("itemSelected", "onChoiceSelected")
  end if
  if m.nav <> invalid
    m.nav.observeField("itemSelected", "onNavSelected")
    m.nav.observeField("itemFocused", "onNavFocused")
    buildSideNav()
  end if

  ' Paint local row immediately so a sports-task crash can't leave a blank load screen.
  paintSection("home")
  m.rows.visible = true
  m.rows.setFocus(true)
  m.focusTarget = "rows"
  m.status.text = m.deviceProfile.summary
  setSyncBar("Sports · Series", 12, true)
  startSyncPulse()
  startCatalogFetch()
end sub

sub setSyncBar(message as string, pct as integer, show as boolean)
  if m.syncBar = invalid then return
  m.syncBar.visible = show
  if m.syncBarTrack <> invalid then m.syncBarTrack.visible = show
  if m.syncBarFill <> invalid then m.syncBarFill.visible = show
  if m.syncBarMsg <> invalid
    m.syncBarMsg.visible = show
    m.syncBarMsg.text = message
  end if
  if m.syncBarPct <> invalid
    m.syncBarPct.visible = show
    if pct < 0
      m.syncBarPct.text = "…"
    else if pct >= 100
      m.syncBarPct.text = "100%"
    else
      m.syncBarPct.text = Str(pct).Trim() + "%"
    end if
  end if
  if m.syncBarFill <> invalid and show
    w = Int(184 * pct / 100)
    if w < 8 then w = 8
    if w > 184 then w = 184
    if pct < 0 then w = 48
    m.syncBarFill.width = w
  end if
end sub

sub startSyncPulse()
  if m.syncPulse <> invalid then return
  m.syncPulse = createObject("roSGNode", "Timer")
  m.syncPulse.repeat = true
  m.syncPulse.duration = 0.45
  m.syncPulse.observeField("fire", "onSyncPulse")
  m.syncPulse.control = "start"
end sub

sub stopSyncPulse()
  if m.syncPulse <> invalid
    m.syncPulse.control = "stop"
    m.syncPulse = invalid
  end if
end sub

sub onSyncPulse()
  if m.catalog <> invalid
    stopSyncPulse()
    return
  end if
  if m.syncPct = invalid then m.syncPct = 8
  m.syncPct = m.syncPct + 7
  if m.syncPct > 88 then m.syncPct = 88
  setSyncBar("Updating catalog…", m.syncPct, true)
end sub

sub setHomeCounter(total as integer, seriesN as integer, sportsN as integer)
  show = (m.sectionId = "home")
  if m.homeCounter <> invalid then m.homeCounter.visible = show
  if m.homeCounterLabel <> invalid then m.homeCounterLabel.visible = show
  if m.homeCounterValue <> invalid
    m.homeCounterValue.visible = show
    m.homeCounterValue.text = Str(total).Trim()
  end if
  if m.homeCounterSub <> invalid
    m.homeCounterSub.visible = show
    m.homeCounterSub.text = Str(seriesN).Trim() + " series · " + Str(sportsN).Trim() + " live"
  end if
end sub

sub buildSideNav()
  ' Same browse list + accent dots as desktop sidebar.
  items = [
    { id: "home", title: "Home", accent: &hF0B429FF },
    { id: "sports", title: "Sports", accent: &h3ECF8EFF },
    { id: "movies", title: "Movies", accent: &hE8A54BFF },
    { id: "anime", title: "Anime", accent: &h5B8DEFFF },
    { id: "series", title: "TV Series", accent: &hD45D7AFF },
    { id: "news", title: "News", accent: &hC4C9D4FF },
    { id: "kids", title: "Kids", accent: &h6EC6FFFF }
  ]
  content = CreateObject("roSGNode", "ContentNode")
  for each it in items
    node = CreateObject("roSGNode", "ContentNode")
    node.AddFields({
      itemId: it.id
      title: it.title
      accent: it.accent
    })
    content.AppendChild(node)
  end for
  m.nav.content = content
  m.nav.jumpToItem = 0
end sub

function bootLocalItems() as object
  items = []
  maxH = 720
  if m.deviceProfile <> invalid and m.deviceProfile.maxHeight <> invalid
    maxH = m.deviceProfile.maxHeight
  end if
  items.Push({
    id: "local-tvj"
    title: "TVJ"
    kind: "hls"
    url: tvjUrlForMaxHeight(maxH)
    poster: "https://i.imgur.com/R4PoC3L.png"
    detail: "Television Jamaica · ≤" + Str(maxH).Trim() + "p"
    handle: ""
  })
  items.Push({
    id: "local-nationwide"
    title: "Nationwide"
    kind: "hls"
    url: "https://jiyu-nnn.free-river.workers.dev/live.m3u8"
    poster: "pkg:/images/channel-poster_hd.png"
    detail: "Nationwide News Network · Cloudflare HLS"
    handle: "@nnn-RADIOLIVE"
  })
  items.Push({
    id: "local-cvm"
    title: "CVM"
    kind: "info"
    url: ""
    poster: "pkg:/images/channel-poster_hd.png"
    detail: "CVM live on phone or desktop Jiyu (Vimeo HLS)"
    handle: ""
  })
  return items
end function

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "back"
    if m.choiceOpen
      hidePlayChoices("Cancelled")
      return true
    end if
    if m.playing
      stopPlayer("Stopped — press OK on a card to play again")
      return true
    end if
    if m.focusTarget = "rows" and m.nav <> invalid
      m.nav.setFocus(true)
      m.focusTarget = "nav"
      return true
    end if
  end if
  if m.playing or m.choiceOpen then return false
  if key = "left" and m.focusTarget = "rows"
    if m.nav <> invalid
      m.nav.setFocus(true)
      m.focusTarget = "nav"
      return true
    end if
  end if
  if key = "right" and m.focusTarget = "nav"
    m.rows.setFocus(true)
    m.focusTarget = "rows"
    return true
  end if
  return false
end function

sub onNavFocused()
  m.focusTarget = "nav"
end sub

sub onNavSelected()
  if m.nav = invalid then return
  idx = m.nav.itemSelected
  if idx = invalid or idx < 0 then return
  node = m.nav.content.GetChild(idx)
  if node = invalid then return
  sid = "home"
  if node.itemId <> invalid then sid = node.itemId
  paintSection(sid)
  m.rows.setFocus(true)
  m.focusTarget = "rows"
end sub

sub paintSection(sectionId as string)
  m.sectionId = sectionId
  localItems = bootLocalItems()
  sportsItems = []
  popular = []
  airing = []
  trending = []
  if m.catalog <> invalid and m.catalog.local <> invalid then localItems = m.catalog.local
  if m.catalog <> invalid and m.catalog.sports <> invalid then sportsItems = m.catalog.sports
  if m.catalog <> invalid and m.catalog.seriesPopular <> invalid then popular = m.catalog.seriesPopular
  if m.catalog <> invalid and m.catalog.seriesAiring <> invalid then airing = m.catalog.seriesAiring
  if m.catalog <> invalid and m.catalog.seriesTrending <> invalid then trending = m.catalog.seriesTrending

  sportsN = 0
  seriesN = 0
  localN = 0
  if sportsItems <> invalid then sportsN = sportsItems.Count()
  if localItems <> invalid then localN = localItems.Count()
  if popular <> invalid then seriesN = seriesN + popular.Count()
  if airing <> invalid then seriesN = seriesN + airing.Count()
  if trending <> invalid then seriesN = seriesN + trending.Count()
  setHomeCounter(localN + sportsN + seriesN, seriesN, sportsN)

  content = CreateObject("roSGNode", "ContentNode")
  if sectionId = "home"
    setStage("Home", "Local channels")
    content.AppendChild(makeRow("Local channels", localItems))
  else if sectionId = "sports"
    setStage("Sports", "Live · Upcoming · by league")
    appendSportsOrganized(content, sportsItems)
  else if sectionId = "series"
    setStage("TV Series", "TMDB shelves · Rive play (S1E1)")
    appendSeriesRows(content, popular, airing, trending)
  else if sectionId = "news"
    setStage("News", "Local live news channels")
    content.AppendChild(makeRow("Local channels", localItems))
  else
    label = sectionTitle(sectionId)
    setStage(label, "Browse and play this shelf on phone or desktop Jiyu")
    content.AppendChild(makeRow(label, [{
      id: "soon-" + sectionId
      title: label + " on phone"
      kind: "info"
      url: ""
      poster: "pkg:/images/channel-poster_hd.png"
      detail: "Not on Roku yet"
      handle: ""
    }]))
  end if

  m.rows.content = content
  m.rows.visible = true
end sub

sub appendSeriesRows(content as object, popular as dynamic, airing as dynamic, trending as dynamic)
  if popular = invalid then popular = []
  if airing = invalid then airing = []
  if trending = invalid then trending = []
  if popular.Count() = 0 and airing.Count() = 0 and trending.Count() = 0
    content.AppendChild(makeRow("Popular", [{
      id: "series-empty"
      title: "Series loading…"
      kind: "info"
      url: ""
      poster: "pkg:/images/channel-poster_hd.png"
      detail: "Start npm run roku-hls on the PC"
      handle: ""
    }]))
    return
  end if
  if popular.Count() > 0 then appendChunkedRows(content, "Popular", popular, 3)
  if airing.Count() > 0 then appendChunkedRows(content, "Airing today", airing, 3)
  if trending.Count() > 0 then appendChunkedRows(content, "Trending", trending, 3)
end sub

sub appendChunkedRows(content as object, title as string, items as object, perRow as integer)
  total = items.Count()
  rowNum = 0
  i = 0
  while i < total
    chunk = []
    n = 0
    while n < perRow and i < total
      chunk.Push(items[i])
      i = i + 1
      n = n + 1
    end while
    label = title
    if rowNum > 0 then label = " "
    content.AppendChild(makeRow(label, chunk))
    rowNum = rowNum + 1
  end while
end sub

sub setStage(title as string, blurb as string)
  if m.stageTitle <> invalid then m.stageTitle.text = title
  if m.stageBlurb <> invalid then m.stageBlurb.text = blurb
end sub

function sectionTitle(sectionId as string) as string
  if sectionId = "movies" then return "Movies"
  if sectionId = "anime" then return "Anime"
  if sectionId = "series" then return "TV Series"
  if sectionId = "kids" then return "Kids"
  if sectionId = "news" then return "News"
  if sectionId = "sports" then return "Sports"
  return "Home"
end function

sub startCatalogFetch()
  task = createObject("roSGNode", "FetchCatalogTask")
  task.observeField("response", "onCatalog")
  task.control = "RUN"
  m.fetchTask = task
end sub

sub onCatalog()
  res = m.fetchTask.response
  if res = invalid
    m.status.text = "Catalog failed."
    return
  end if

  m.catalog = res
  stopSyncPulse()
  sid = m.sectionId
  if sid = invalid or sid = "" then sid = "home"
  paintSection(sid)
  if m.focusTarget <> "nav"
    m.rows.setFocus(true)
    m.focusTarget = "rows"
  end if

  sportsN = 0
  seriesN = 0
  if res.sports <> invalid then sportsN = res.sports.Count()
  if res.seriesPopular <> invalid then seriesN = seriesN + res.seriesPopular.Count()
  if res.seriesAiring <> invalid then seriesN = seriesN + res.seriesAiring.Count()
  if res.seriesTrending <> invalid then seriesN = seriesN + res.seriesTrending.Count()

  msg = "OK to play · Left opens menu"
  if res.error <> invalid and res.error <> ""
    msg = res.error
    setSyncBar("Catalog issue", 100, true)
  else
    parts = []
    parts.Push(Str(sportsN).Trim() + " live sports")
    parts.Push(Str(seriesN).Trim() + " series")
    msg = parts[0] + " · " + parts[1] + " · OK to play"
    setSyncBar("Synced · " + Str(sportsN + seriesN).Trim() + " titles", 100, true)
  end if
  m.status.text = msg
  ' Match desktop: dismiss the sync pill shortly after completion.
  m.syncHide = createObject("roSGNode", "Timer")
  m.syncHide.repeat = false
  m.syncHide.duration = 2.5
  m.syncHide.observeField("fire", "onSyncHide")
  m.syncHide.control = "start"
end sub

sub onSyncHide()
  setSyncBar("", 100, false)
end sub

' Live first (by league), then Upcoming (by league) — mirrors desktop Sports shelves.
sub appendSportsOrganized(content as object, sports as dynamic)
  if sports = invalid or sports.Count() = 0
    content.AppendChild(makeRow("Live", [{
      id: "sports-empty"
      title: "No matches right now"
      kind: "info"
      url: ""
      poster: "pkg:/images/channel-poster_hd.png"
      detail: "Check back near kickoff"
      handle: ""
    }]))
    return
  end if

  liveItems = []
  upcomingItems = []
  for each it in sports
    st = ""
    if it.status <> invalid then st = LCase(toStrSafe(it.status))
    if st = "upcoming" or (it.kind <> invalid and LCase(it.kind) = "upcoming")
      upcomingItems.Push(it)
    else
      liveItems.Push(it)
    end if
  end for

  if liveItems.Count() > 0
    appendSportsByLeague(content, "Live", liveItems)
  else
    content.AppendChild(makeRow("Live", [{
      id: "sports-live-empty"
      title: "No live matches"
      kind: "info"
      url: ""
      poster: "pkg:/images/channel-poster_hd.png"
      detail: "See Upcoming below"
      handle: ""
    }]))
  end if

  if upcomingItems.Count() > 0
    appendSportsByLeague(content, "Upcoming", upcomingItems)
  end if
end sub

sub appendSportsByLeague(content as object, statusLabel as string, items as object)
  leagues = []
  buckets = CreateObject("roAssociativeArray")
  for each it in items
    league = "Football"
    if it.league <> invalid and it.league <> "" then league = it.league
    key = LCase(league)
    list = buckets[key]
    if list = invalid
      list = []
      leagues.Push(league)
    end if
    list.Push(it)
    buckets[key] = list
  end for

  preferred = ["EPL", "LaLiga", "La Liga", "Bundesliga", "Serie A", "Ligue 1", "MLS", "UCL", "UEL"]
  ordered = []
  for each pref in preferred
    pk = LCase(pref)
    i = 0
    while i < leagues.Count()
      if LCase(leagues[i]) = pk
        ordered.Push(leagues[i])
        leagues.Delete(i)
      else
        i = i + 1
      end if
    end while
  end for
  while leagues.Count() > 0
    best = 0
    j = 1
    while j < leagues.Count()
      if LCase(leagues[j]) < LCase(leagues[best]) then best = j
      j = j + 1
    end while
    ordered.Push(leagues[best])
    leagues.Delete(best)
  end while

  for each league in ordered
    list = buckets[LCase(league)]
    if list <> invalid and list.Count() > 0
      appendChunkedRows(content, statusLabel + " · " + league, list, 3)
    end if
  end for
end sub

function makeRow(title as string, items as dynamic) as object
  row = CreateObject("roSGNode", "ContentNode")
  row.title = title
  if items = invalid then return row
  for each it in items
    node = CreateObject("roSGNode", "ContentNode")
    ' Don't use field name "id" — ContentNode already owns that.
    tmdbId = ""
    if it.tmdbId <> invalid then tmdbId = it.tmdbId
    season = 1
    episode = 1
    if it.season <> invalid then season = Int(it.season)
    if it.episode <> invalid then episode = Int(it.episode)
    league = ""
    if it.league <> invalid then league = it.league
    status = ""
    if it.status <> invalid then status = it.status
    node.AddFields({
      itemId: it.id
      title: it.title
      kind: it.kind
      url: it.url
      detail: it.detail
      handle: it.handle
      tmdbId: tmdbId
      season: season
      episode: episode
      league: league
      status: status
    })
    if it.poster <> invalid and it.poster <> ""
      node.HDPosterUrl = it.poster
    else
      node.HDPosterUrl = "pkg:/images/channel-poster_hd.png"
    end if
    detail = ""
    if it.detail <> invalid then detail = it.detail
    node.ShortDescriptionLine1 = detail
    row.AppendChild(node)
  end for
  return row
end function

sub onItemSelected()
  sel = m.rows.rowItemSelected
  if sel = invalid or sel.Count() < 2 then return
  rowIndex = sel[0]
  itemIndex = sel[1]
  row = m.rows.content.GetChild(rowIndex)
  if row = invalid then return
  item = row.GetChild(itemIndex)
  if item = invalid then return
  playItem(item)
end sub

sub playItem(item as object)
  kind = item.kind
  if kind = "hls"
    via = viaForUrl(item.url)
    if via = "" and item.itemId = "local-nationwide" then via = "cloudflare"
    playHls(item.url, item.title, via)
  else if kind = "futbolx"
    m.status.text = "Signing " + item.title + "…"
    startFutbolXResolve(item)
  else if kind = "series"
    m.status.text = "Resolving " + item.title + "…"
    startSeriesResolve(item)
  else if kind = "upcoming"
    detail = item.detail
    if detail = invalid or detail = "" then detail = "Not kicked off yet"
    m.status.text = detail
  else if kind = "nationwide" or kind = "youtube"
    playHls("https://jiyu-nnn.free-river.workers.dev/live.m3u8", item.title, "cloudflare")
  else if kind = "embed"
    m.status.text = "Unwrapping " + item.title + "…"
    startEmbedResolve(item)
  else if kind = "info"
    m.status.text = item.detail
  else
    m.status.text = "Unsupported item"
  end if
end sub

sub startSeriesResolve(item as object)
  task = createObject("roSGNode", "ResolveSeriesTask")
  task.tmdbId = item.tmdbId
  season = 1
  episode = 1
  if item.season <> invalid then season = item.season
  if item.episode <> invalid then episode = item.episode
  task.season = season
  task.episode = episode
  task.title = item.title
  maxH = 720
  if m.maxHeight <> invalid then maxH = m.maxHeight
  task.maxHeight = maxH
  task.observeField("response", "onSeriesResolved")
  task.control = "RUN"
  m.seriesTask = task
end sub

sub onSeriesResolved()
  res = m.seriesTask.response
  title = "Series"
  if res <> invalid and res.title <> invalid and res.title <> "" then title = res.title
  if res = invalid or res.ok <> true
    err = "Series resolve failed"
    if res <> invalid and res.error <> invalid and res.error <> "" then err = res.error
    m.status.text = err
    return
  end if
  label = title
  if res.season <> invalid and res.episode <> invalid
    label = title + " · S" + Str(res.season).Trim() + "E" + Str(res.episode).Trim()
  end if
  playHls(res.proxiedUrl, label, "series")
end sub

' Same play path as the build that had picture for a few minutes.
sub playHls(url as string, title as string, via = "")
  if url = invalid or url = ""
    m.status.text = "No stream URL"
    return
  end if
  if via = invalid then via = ""
  content = CreateObject("roSGNode", "ContentNode")
  content.url = url
  content.title = title
  content.streamFormat = "hls"
  content.live = true
  m.video.content = content
  ' Park Video off-screen first — this TCL paints a black full-screen surface if
  ' Video appears at 0,0 before the decoder has frames.
  m.video.translation = [2000, 2000]
  m.playerShade.visible = true
  m.video.visible = true
  m.video.control = "play"
  m.video.setFocus(true)
  m.playing = true
  m.bufferStarted = 0
  m.bufferReloaded = false
  m.playVia = via
  m.rows.visible = false
  setShellVisible(false)
  label = playViaLabel(via)
  m.status.text = "Playing " + title + label
  if m.playStatus <> invalid
    m.playStatus.visible = true
    m.playStatus.text = "Buffering " + title + label + "… · Back to exit"
  end if
  ensureBufferWatch()
end sub

sub showVideoSurface()
  if m.video = invalid then return
  m.video.translation = [0, 0]
  if m.playerShade <> invalid then m.playerShade.visible = false
end sub

function viaForUrl(url as dynamic) as string
  if url = invalid or url = "" then return ""
  u = LCase(url)
  if Instr(1, u, "jiyu-nnn.free-river.workers.dev") > 0 then return "cloudflare"
  if Instr(1, u, "jiyu.free-river.workers.dev/nnn") > 0 then return "cloudflare"
  if Instr(1, u, "/api/mse") > 0 or Instr(1, u, "/api/hls") > 0 then return "bridge"
  return ""
end function

function playViaLabel(via as string) as string
  if via = "youtube-hls" then return " · direct YouTube"
  if via = "bridge" then return " · cloud bridge"
  if via = "cloudflare" then return " · Cloudflare"
  if via = "futbolx" then return " · Futbol-x"
  if via = "series" then return " · Rive"
  return ""
end function

sub startFutbolXResolve(item as object)
  clearFutbolXTokenTimer()
  m.fxRawUrl = item.url
  m.fxTitle = item.title
  task = createObject("roSGNode", "ResolveFutbolXTask")
  task.rawUrl = item.url
  task.title = item.title
  task.observeField("response", "onFutbolXResolved")
  task.control = "RUN"
  m.fxTask = task
end sub

sub onFutbolXResolved()
  res = m.fxTask.response
  title = m.fxTitle
  if title = invalid or title = "" then title = "Match"
  if res = invalid or res.ok <> true
    err = "Futbol-x sign failed"
    if res <> invalid and res.error <> invalid and res.error <> "" then err = res.error
    m.status.text = err
    return
  end if
  m.fxRetry = 0
  playHls(res.proxiedUrl, title, "futbolx")
  ' Refresh early — expired Flussonic tokens → Roku "no valid bitrates".
  expiresIn = 900
  if res.expiresIn <> invalid then expiresIn = Int(res.expiresIn)
  refreshAfter = Int(expiresIn * 0.6)
  if refreshAfter < 60 then refreshAfter = 60
  if refreshAfter > 480 then refreshAfter = 480
  ensureFutbolXTokenTimer(refreshAfter)
end sub

sub ensureFutbolXTokenTimer(afterSec as integer)
  clearFutbolXTokenTimer()
  m.fxTokenTimer = createObject("roSGNode", "Timer")
  m.fxTokenTimer.repeat = false
  m.fxTokenTimer.duration = afterSec
  m.fxTokenTimer.observeField("fire", "onFutbolXTokenRefresh")
  m.fxTokenTimer.control = "start"
end sub

sub clearFutbolXTokenTimer()
  if m.fxTokenTimer <> invalid
    m.fxTokenTimer.control = "stop"
    m.fxTokenTimer = invalid
  end if
end sub

sub onFutbolXTokenRefresh()
  if not m.playing then return
  if m.playVia <> "futbolx" then return
  if m.fxRawUrl = invalid or m.fxRawUrl = "" then return
  task = createObject("roSGNode", "ResolveFutbolXTask")
  task.rawUrl = m.fxRawUrl
  task.title = m.fxTitle
  task.observeField("response", "onFutbolXTokenRefreshed")
  task.control = "RUN"
  m.fxRefreshTask = task
end sub

sub onFutbolXTokenRefreshed()
  if not m.playing then return
  res = m.fxRefreshTask.response
  if res = invalid or res.ok <> true or res.proxiedUrl = invalid or res.proxiedUrl = ""
    return
  end if
  title = m.fxTitle
  if title = invalid or title = "" then title = "Match"
  ' Fresh signed master — keep playing without tearing the Video node down.
  content = CreateObject("roSGNode", "ContentNode")
  content.url = res.proxiedUrl
  content.title = title
  content.streamFormat = "hls"
  content.live = true
  m.video.content = content
  expiresIn = 900
  if res.expiresIn <> invalid then expiresIn = Int(res.expiresIn)
  refreshAfter = Int(expiresIn * 0.6)
  if refreshAfter < 60 then refreshAfter = 60
  if refreshAfter > 480 then refreshAfter = 480
  ensureFutbolXTokenTimer(refreshAfter)
end sub

sub ensureBufferWatch()
  if m.bufferTimer <> invalid then return
  m.bufferTimer = createObject("roSGNode", "Timer")
  m.bufferTimer.repeat = true
  m.bufferTimer.duration = 1
  m.bufferTimer.observeField("fire", "onBufferWatch")
  m.bufferTimer.control = "start"
end sub

sub clearBufferWatch()
  if m.bufferTimer <> invalid
    m.bufferTimer.control = "stop"
    m.bufferTimer = invalid
  end if
end sub

sub onBufferWatch()
  if not m.playing then return
  state = m.video.state
  if state = "buffering" or state = "none"
    if m.bufferStarted = 0 then m.bufferStarted = CreateObject("roDateTime").AsSeconds()
    waited = CreateObject("roDateTime").AsSeconds() - m.bufferStarted
    if m.playStatus <> invalid
      m.playStatus.text = "Buffering… " + Str(waited).Trim() + "s · Back to exit"
    end if
    if waited >= 20
      stopPlayer("Stream stalled (buffering). Try the card again — Back always exits.")
    end if
  else if state = "playing"
    m.bufferStarted = 0
    if m.playStatus <> invalid and m.video.content <> invalid
      title = m.video.content.title
      if title = invalid then title = "Live"
      via = ""
      if m.playVia <> invalid then via = m.playVia
      m.playStatus.text = "Playing " + title + playViaLabel(via) + " · Back to exit"
    end if
  end if
end sub

sub startEmbedResolve(item as object)
  task = createObject("roSGNode", "ResolveEmbedTask")
  task.iframe = item.url
  task.title = item.title
  task.observeField("response", "onEmbedResolved")
  task.control = "RUN"
  m.embedTask = task
end sub

sub onEmbedResolved()
  res = m.embedTask.response
  if res = invalid or not res.ok
    err = "Could not unwrap stream"
    if res <> invalid and res.error <> "" then err = res.error
    if m.nationwidePending = true
      err = err + " — cloud bridge unreachable. Staying in Jiyu."
      m.nationwidePending = false
    end if
    m.status.text = err
    return
  end if
  title = res.title
  if title = invalid or title = "" then title = "Live"
  via = "bridge"
  if m.nationwidePending = true then via = "bridge"
  m.nationwidePending = false
  playHls(res.proxiedUrl, title, via)
end sub

' Nationwide: always the hardcoded NNN /live page, always inside Jiyu.
' 1) Try direct YouTube HLS on the TV
' 2) Else cloud bridge (yt-dlp) — never the YouTube app
sub startNationwide(item as object)
  title = "Nationwide"
  if item <> invalid and item.title <> invalid and item.title <> "" then title = item.title

  liveUrl = nnnLiveUrl()
  m.nationwidePending = true
  m.ytItem = {
    id: "local-nationwide"
    title: title
    kind: "nationwide"
    url: liveUrl
    handle: "@nnn-RADIOLIVE"
  }

  m.status.text = "Opening NNN livestream in Jiyu…"
  task = createObject("roSGNode", "ResolveYouTubeTask")
  task.handle = "@nnn-RADIOLIVE"
  task.liveUrl = liveUrl
  task.observeField("response", "onNationwideResolved")
  task.control = "RUN"
  m.ytTask = task
end sub

sub onNationwideResolved()
  res = m.ytTask.response
  title = "Nationwide"
  if m.ytItem <> invalid and m.ytItem.title <> invalid and m.ytItem.title <> ""
    title = m.ytItem.title
  end if

  if res <> invalid and res.hlsUrl <> invalid and res.hlsUrl <> ""
    m.nationwidePending = false
    playHls(res.hlsUrl, title, "youtube-hls")
    return
  end if

  ' Stay in Jiyu — unwrap the hardcoded /live page through the cloud bridge.
  m.status.text = "Unwrapping NNN livestream via cloud bridge…"
  startEmbedResolve(m.ytItem)
end sub

sub showPlayChoices(title as string, choices as object)
  ' Kept for other flows; Nationwide never uses leave-Jiyu actions.
  m.choiceActions = choices
  content = CreateObject("roSGNode", "ContentNode")
  for each c in choices
    node = CreateObject("roSGNode", "ContentNode")
    node.title = c.label
    content.AppendChild(node)
  end for
  m.choiceList.content = content
  m.choiceList.jumpToItem = 0
  m.choiceTitle.text = title
  m.choiceShade.visible = true
  m.choiceTitle.visible = true
  m.choiceHint.visible = true
  m.choiceList.visible = true
  m.rows.visible = false
  m.choiceOpen = true
  m.status.text = title
  m.choiceList.setFocus(true)
end sub

sub hidePlayChoices(statusMsg = "")
  m.choiceOpen = false
  m.choiceShade.visible = false
  m.choiceTitle.visible = false
  m.choiceHint.visible = false
  m.choiceList.visible = false
  m.rows.visible = true
  m.rows.setFocus(true)
  if statusMsg <> "" then m.status.text = statusMsg
end sub

sub onChoiceSelected()
  if not m.choiceOpen then return
  idx = m.choiceList.itemSelected
  if idx = invalid or idx < 0 or idx >= m.choiceActions.Count() then return
  action = m.choiceActions[idx].action
  hidePlayChoices("")
  if action = "cancel" or action = ""
    m.status.text = "Cancelled"
    return
  end if
  m.status.text = "Cancelled"
end sub

sub setShellVisible(show as boolean)
  nodes = [
    m.sidebar, m.sidebarEdge, m.brand, m.brandLogo, m.brandTag,
    m.browseLabel, m.watchLabel, m.watchHint, m.nav,
    m.stageTitle, m.stageBlurb, m.status
  ]
  for each n in nodes
    if n <> invalid then n.visible = show
  end for
  bg = m.top.findNode("bg")
  glow = m.top.findNode("glowGold")
  if bg <> invalid then bg.visible = show
  if glow <> invalid then glow.visible = show
  ' Sync bar + home counter: hide with player; restore only when appropriate.
  if not show
    setSyncBar("", 100, false)
    setHomeCounterVisible(false)
  else if m.sectionId = "home"
    setHomeCounterVisible(true)
  end if
end sub

sub setHomeCounterVisible(show as boolean)
  if m.homeCounter <> invalid then m.homeCounter.visible = show
  if m.homeCounterLabel <> invalid then m.homeCounterLabel.visible = show
  if m.homeCounterValue <> invalid then m.homeCounterValue.visible = show
  if m.homeCounterSub <> invalid then m.homeCounterSub.visible = show
end sub

sub stopPlayer(statusMsg = "")
  clearFutbolXTokenTimer()
  clearBufferWatch()
  m.fxRawUrl = ""
  if m.playing or m.video.visible = true
    m.video.control = "stop"
    m.video.visible = false
    m.video.translation = [0, 0]
    m.playerShade.visible = false
    if m.playStatus <> invalid then m.playStatus.visible = false
    m.playing = false
    m.bufferStarted = 0
    setShellVisible(true)
    m.rows.visible = true
    m.rows.setFocus(true)
    m.focusTarget = "rows"
    if statusMsg <> ""
      m.status.text = statusMsg
    else
      m.status.text = "Stopped"
    end if
  end if
end sub

sub onVideoState()
  state = m.video.state
  if state = "error"
    err = "Playback error"
    if m.video.errorMsg <> invalid and m.video.errorMsg <> ""
      err = err + ": " + m.video.errorMsg
    else if m.video.errorCode <> invalid
      err = err + " (" + Str(m.video.errorCode).Trim() + ")"
    end if
    ' Soft recovery: re-sign once (token expiry).
    if m.playVia = "futbolx" and m.fxRawUrl <> invalid and m.fxRawUrl <> ""
      if m.fxRetry = invalid then m.fxRetry = 0
      if m.fxRetry < 1
        m.fxRetry = m.fxRetry + 1
        if m.playStatus <> invalid
          m.playStatus.text = "Re-signing stream… · Back to exit"
        end if
        m.status.text = "Re-signing stream…"
        task = createObject("roSGNode", "ResolveFutbolXTask")
        task.rawUrl = m.fxRawUrl
        task.title = m.fxTitle
        task.observeField("response", "onFutbolXResolved")
        task.control = "RUN"
        m.fxTask = task
        return
      end if
    end if
    stopPlayer(err)
  else if state = "finished"
    stopPlayer("Stream ended — try another live match")
  else if state = "playing"
    m.bufferStarted = 0
    showVideoSurface()
  else if state = "buffering"
    if m.bufferStarted = 0 then m.bufferStarted = CreateObject("roDateTime").AsSeconds()
    ' Bring surface on once buffering starts so the first frame can show.
    showVideoSurface()
  end if
end sub

sub onDeepLink()
  ' Reserved for store deep links later.
end sub
