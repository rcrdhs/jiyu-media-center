sub init()
  m.top.functionName = "runTask"
end sub

sub runTask()
  out = {
    ok: true
    error: ""
    local: buildLocalRow()
    sports: []
    seriesPopular: []
    seriesAiring: []
    seriesTrending: []
  }

  sports = fetchFutbolXFootball()
  out.sports = sports.items
  if sports.ok <> true
    out.error = sports.error
  end if

  series = fetchSeriesCatalog()
  out.seriesPopular = series.popular
  out.seriesAiring = series.airing
  out.seriesTrending = series.trending
  if series.ok <> true
    if out.error = ""
      out.error = series.error
    else
      out.error = out.error + " · " + series.error
    end if
  end if

  m.top.response = out
end sub

function buildLocalRow() as object
  items = []
  profile = ensureDeviceProfile()
  items.Push({
    id: "local-tvj"
    title: "TVJ"
    kind: "hls"
    url: tvjUrlForMaxHeight(profile.maxHeight)
    poster: "https://i.imgur.com/R4PoC3L.png"
    detail: "Television Jamaica · ≤" + Str(profile.maxHeight).Trim() + "p"
    handle: ""
  })
  items.Push({
    id: "local-nationwide"
    title: "Nationwide"
    kind: "hls"
    url: "https://jiyu-nnn.free-river.workers.dev/live.m3u8"
    poster: "pkg:/images/channel-poster_hd.png"
    detail: "Nationwide News Network · plays in Jiyu (Cloudflare)"
    handle: "@nnn-RADIOLIVE"
  })
  items.Push({
    id: "local-cvm"
    title: "CVM"
    kind: "info"
    url: ""
    poster: "pkg:/images/channel-poster_hd.png"
    detail: "CVM needs a Vimeo token — use phone or desktop Jiyu"
    handle: ""
  })
  return items
end function

function fetchSeriesCatalog() as object
  empty = { ok: false, error: "", popular: [], airing: [], trending: [] }
  base = rokuHlsBase()
  if base = invalid or base = ""
    empty.error = "roku-hls missing"
    return empty
  end if
  token = rokuHlsToken()
  endpoint = base + "/api/series/catalog"
  if token <> invalid and token <> ""
    endpoint = endpoint + "?token=" + UrlEncode(token)
  end if
  raw = httpGetTimed(endpoint, "", 20000)
  if raw = invalid or raw = ""
    empty.error = "Series catalog unreachable — start npm run roku-hls"
    return empty
  end if
  data = ParseJson(raw)
  if data = invalid or data.ok <> true
    err = "Series catalog bad response"
    if data <> invalid and data.error <> invalid then err = data.error
    empty.error = err
    return empty
  end if
  return {
    ok: true
    error: ""
    popular: asItemList(data.popular)
    airing: asItemList(data.airing)
    trending: asItemList(data.trending)
  }
end function

function asItemList(arr as dynamic) as object
  out = []
  if arr = invalid then return out
  for each it in arr
    if it <> invalid then out.Push(it)
  end for
  return out
end function

function fetchFutbolXFootball() as object
  raw = httpGetTimed("https://www.futbol-x.xyz/api/football.json", "https://www.futbol-x.xyz/", 12000)
  if raw = invalid or raw = ""
    return { ok: false, error: "Could not reach Futbol-x", items: [] }
  end if
  data = ParseJson(raw)
  if data = invalid or data.streams = invalid
    return { ok: false, error: "Futbol-x returned bad JSON", items: [] }
  end if
  if data.success = false
    return { ok: false, error: "Futbol-x success=false", items: [] }
  end if

  nowStamp = nowStampUtcPlus3()
  items = []
  for each block in data.streams
    if block <> invalid and block.streams <> invalid
      for each match in block.streams
        item = futbolXMatchItem(match, nowStamp)
        if item <> invalid
          items.Push(item)
        end if
        if items.Count() >= 10 then exit for
      end for
    end if
    if items.Count() >= 10 then exit for
  end for

  return { ok: true, error: "", items: items }
end function

function nowStampUtcPlus3() as string
  dt = CreateObject("roDateTime")
  dt.Mark()
  return stampFromEpochSeconds(dt.AsSeconds() + (3 * 3600))
end function

function stampFromEpochSeconds(sec as integer) as string
  if sec < 0 then sec = 0
  days = Int(sec / 86400)
  leftSec = sec - (days * 86400)
  hours = Int(leftSec / 3600)
  leftSec = leftSec - (hours * 3600)
  minutes = Int(leftSec / 60)

  z = days + 719468
  era = Int(z / 146097)
  if z < 0 then era = Int((z - 146096) / 146097)
  doe = z - (era * 146097)
  yoe = Int((doe - Int(doe / 1460) + Int(doe / 36524) - Int(doe / 146096)) / 365)
  y = yoe + (era * 400)
  doy = doe - (365 * yoe + Int(yoe / 4) - Int(yoe / 100))
  mp = Int((5 * doy + 2) / 153)
  d = doy - Int((153 * mp + 2) / 5) + 1
  m = mp + 3
  if mp >= 10 then m = mp - 9
  if m <= 2 then y = y + 1

  return pad4(y) + "-" + pad2(m) + "-" + pad2(d) + "T" + pad2(hours) + ":" + pad2(minutes)
end function

function pad2(n as integer) as string
  if n < 10 then return "0" + Str(n).Trim()
  return Str(n).Trim()
end function

function pad4(n as integer) as string
  return Str(n).Trim()
end function

function futbolXMatchItem(match as object, nowStamp as string) as object
  if match = invalid then return invalid
  name = ""
  if match.name <> invalid then name = toStr(match.name)
  uri = ""
  if match.uri_name <> invalid then uri = toStr(match.uri_name)
  if name = "" or uri = "" then return invalid

  feedUrl = ""
  feedDetail = "Futbol-x"
  if match.streams <> invalid
    for each feed in match.streams
      if feed <> invalid
        u = ""
        if feed.url <> invalid then u = toStr(feed.url)
        if u <> "" and Instr(1, LCase(u), ".m3u8") > 0
          title = ""
          if feed.title <> invalid then title = toStr(feed.title)
          if feedUrl = "" or Instr(1, LCase(title), "main") > 0
            feedUrl = u
            if title <> "" then feedDetail = title
          end if
        end if
      end if
    end for
  end if
  if feedUrl = "" then return invalid

  startAt = ""
  endAt = ""
  if match.starts_at <> invalid then startAt = Left(toStr(match.starts_at), 16)
  if match.ends_at <> invalid then endAt = Left(toStr(match.ends_at), 16)

  always = false
  if match.always_live = true or match.always_live = 1 then always = true

  live = always
  if live <> true and startAt <> "" and nowStamp <> ""
    if startAt <= nowStamp
      if endAt = "" or endAt >= nowStamp then live = true
    end if
  end if

  if live <> true then return invalid

  tag = "Football"
  if match.tag <> invalid and toStr(match.tag) <> "" then tag = toStr(match.tag)

  poster = "pkg:/images/channel-poster_hd.png"
  if match.poster <> invalid and toStr(match.poster) <> ""
    poster = toStr(match.poster)
  end if

  detail = "LIVE · " + tag + " · " + feedDetail

  return {
    id: "futbolx-" + uri
    title: name
    kind: "futbolx"
    url: feedUrl
    poster: poster
    detail: detail
    handle: uri
  }
end function

function toStr(v as dynamic) as string
  t = type(v)
  if t = "roString" or t = "String" then return v
  if t = "Integer" or t = "roInt" or t = "Float" or t = "Double" then return Str(v).Trim()
  if t = "Boolean" or t = "roBoolean"
    if v then return "true"
    return "false"
  end if
  return ""
end function

function UrlEncode(s as string) as string
  xfer = CreateObject("roUrlTransfer")
  return xfer.Escape(s)
end function

function httpGetTimed(url as string, referer as string, timeoutMs as integer) as dynamic
  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.EnableEncodings(true)
  xfer.SetUrl(url)
  xfer.AddHeader("Accept", "application/json")
  xfer.AddHeader("User-Agent", "JiyuRoku/0.1 (Roku; catalog)")
  if referer <> "" then xfer.AddHeader("Referer", referer)

  port = CreateObject("roMessagePort")
  xfer.SetMessagePort(port)
  if xfer.AsyncGetToString() <> true then return invalid

  clock = CreateObject("roTimespan")
  clock.Mark()
  while true
    msg = wait(250, port)
    if type(msg) = "roUrlEvent"
      code = msg.GetResponseCode()
      body = msg.GetString()
      if code >= 200 and code < 300 and body <> invalid and body <> ""
        return body
      end if
      return invalid
    end if
    if clock.TotalMilliseconds() >= timeoutMs
      xfer.AsyncCancel()
      return invalid
    end if
  end while
  return invalid
end function
