' Hardcoded NNN livestream page — always the current on-air show, never a single VODs id.
function nnnLiveUrl() as string
  return "https://www.youtube.com/@nnn-RADIOLIVE/live"
end function

sub init()
  m.status = m.top.findNode("status")
  m.rows = m.top.findNode("rows")
  m.video = m.top.findNode("video")
  m.playerShade = m.top.findNode("playerShade")
  m.playStatus = m.top.findNode("playStatus")
  m.choiceShade = m.top.findNode("choiceShade")
  m.choiceTitle = m.top.findNode("choiceTitle")
  m.choiceHint = m.top.findNode("choiceHint")
  m.choiceList = m.top.findNode("choiceList")
  m.catalog = invalid
  m.playing = false
  m.bufferStarted = 0
  m.bufferTimer = invalid
  m.choiceOpen = false
  m.choiceActions = []

  m.rows.observeField("rowItemSelected", "onItemSelected")
  m.video.observeField("state", "onVideoState")
  if m.choiceList <> invalid
    m.choiceList.observeField("itemSelected", "onChoiceSelected")
  end if

  m.status.text = "Loading local channels and live football…"
  startCatalogFetch()
end sub

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
  end if
  return false
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

  content = CreateObject("roSGNode", "ContentNode")
  content.AppendChild(makeRow("Local live", res.local))
  sportsTitle = "Live football"
  if res.sports = invalid or res.sports.Count() = 0
    sportsTitle = "Live football (none on now)"
  end if
  content.AppendChild(makeRow(sportsTitle, res.sports))

  m.rows.content = content
  m.rows.visible = true
  m.rows.setFocus(true)

  msg = "OK · TVJ + Nationwide stay in Jiyu · football needs PC bridge"
  if res.error <> invalid and res.error <> ""
    msg = msg + " · sports: " + res.error
  else if res.sports <> invalid
    msg = msg + " · " + Str(res.sports.Count()).Trim() + " football cards"
  end if
  m.status.text = msg
end sub

function makeRow(title as string, items as dynamic) as object
  row = CreateObject("roSGNode", "ContentNode")
  row.title = title
  if items = invalid then return row
  for each it in items
    node = CreateObject("roSGNode", "ContentNode")
    ' Don't use field name "id" — ContentNode already owns that.
    node.AddFields({
      itemId: it.id
      title: it.title
      kind: it.kind
      url: it.url
      detail: it.detail
      handle: it.handle
    })
    if it.poster <> invalid and it.poster <> ""
      node.HDPosterUrl = it.poster
    else
      node.HDPosterUrl = "pkg:/images/channel-poster_hd.png"
    end if
    node.ShortDescriptionLine1 = it.detail
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
  else if kind = "nationwide" or kind = "youtube"
    ' Legacy kinds — still stay in Jiyu via Cloudflare HLS.
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
  m.playerShade.visible = true
  m.video.visible = true
  m.video.control = "play"
  m.video.setFocus(true)
  m.playing = true
  m.bufferStarted = 0
  m.playVia = via
  m.rows.visible = false
  label = playViaLabel(via)
  m.status.text = "Playing " + title + label
  if m.playStatus <> invalid
    m.playStatus.visible = true
    m.playStatus.text = "Playing " + title + label + " · Back to exit"
  end if
  ensureBufferWatch()
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
  if via = "bridge" then return " · PC bridge"
  if via = "cloudflare" then return " · Cloudflare"
  return ""
end function

sub ensureBufferWatch()
  if m.bufferTimer <> invalid then return
  m.bufferTimer = createObject("roSGNode", "Timer")
  m.bufferTimer.repeat = true
  m.bufferTimer.duration = 1
  m.bufferTimer.observeField("fire", "onBufferWatch")
  m.bufferTimer.control = "start"
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
    ' Live bridge lagged — leave the spinner instead of hanging forever.
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
      err = err + " — start npm run roku-hls on the PC (same Wi‑Fi). Staying in Jiyu."
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
' 2) Else PC bridge (yt-dlp) — never the YouTube app
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

  ' Stay in Jiyu — unwrap the hardcoded /live page through the PC bridge.
  m.status.text = "Unwrapping NNN livestream via PC bridge…"
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

sub stopPlayer(statusMsg = "")
  if m.playing
    m.video.control = "stop"
    m.video.visible = false
    m.playerShade.visible = false
    if m.playStatus <> invalid then m.playStatus.visible = false
    m.playing = false
    m.bufferStarted = 0
    m.rows.visible = true
    m.rows.setFocus(true)
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
    stopPlayer(err)
  else if state = "finished"
    stopPlayer("Stream ended — try the card again")
  else if state = "playing"
    m.bufferStarted = 0
  else if state = "buffering"
    if m.bufferStarted = 0 then m.bufferStarted = CreateObject("roDateTime").AsSeconds()
  end if
end sub

sub onDeepLink()
  ' Reserved for store deep links later.
end sub
