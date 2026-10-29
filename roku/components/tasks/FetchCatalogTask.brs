sub init()
  m.top.functionName = "runTask"
end sub

sub runTask()
  out = {
    ok: false
    error: ""
    local: []
    sports: []
  }

  out.local = buildLocalRow()
  sports = fetchPpvFootball()
  out.sports = sports.items
  if sports.ok
    out.ok = true
  else
    out.error = sports.error
    out.ok = true
  end if

  m.top.response = out
end sub

function buildLocalRow() as object
  items = []
  items.Push({
    id: "local-tvj"
    title: "TVJ"
    kind: "hls"
    url: "https://vod2live.univtec.com/manifest/a99a1804-dc83-411f-8c1c-b62f08cdfa59.m3u8"
    poster: "https://i.imgur.com/R4PoC3L.png"
    detail: "Television Jamaica · HLS"
    handle: ""
  })
  items.Push({
    id: "local-nationwide"
    title: "Nationwide"
    kind: "hls"
    ' Cloudflare Worker resolves @nnn-RADIOLIVE/live → proxied HLS (no PC bridge).
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

function fetchPpvFootball() as object
  raw = httpGet("https://api.ppv.st/api/streams", "https://ppv.st/")
  if raw = invalid or raw = ""
    return { ok: false, error: "Could not reach PPV.st", items: [] }
  end if
  data = ParseJson(raw)
  if data = invalid or data.streams = invalid
    return { ok: false, error: "PPV.st returned bad JSON", items: [] }
  end if

  nowSec = CreateObject("roDateTime").AsSeconds()
  items = []
  for each cat in data.streams
    catName = ""
    if cat.category <> invalid then catName = LCase(cat.category)
    isFootball = false
    if Instr(1, catName, "football") > 0 then isFootball = true
    if Instr(1, catName, "soccer") > 0 then isFootball = true
    if isFootball and cat.streams <> invalid
      for each s in cat.streams
        if isLivePpv(s, nowSec)
          title = "Match"
          if s.name <> invalid and s.name <> "" then title = s.name
          poster = ""
          if s.poster <> invalid then poster = s.poster
          detail = cat.category
          if s.tag <> invalid and s.tag <> "" then detail = detail + " · " + s.tag
          idStr = "ppv"
          if s.id <> invalid then idStr = "ppv-" + toStr(s.id)
          items.Push({
            id: idStr
            title: title
            kind: "embed"
            url: ppvWatchUrl(s)
            poster: poster
            detail: detail
            handle: ""
          })
        end if
        if items.Count() >= 40 then exit for
      end for
    end if
    if items.Count() >= 40 then exit for
  end for

  return { ok: true, error: "", items: items }
end function

function isLivePpv(s as object, nowSec as integer) as boolean
  if s.always_live = true or s.always_live = 1 then return true
  startAt = 0
  endAt = 0
  if s.starts_at <> invalid then startAt = Int(s.starts_at)
  if s.ends_at <> invalid then endAt = Int(s.ends_at)
  if startAt > 0 and startAt <= nowSec
    if endAt = 0 or endAt >= nowSec then return true
  end if
  return false
end function

function ppvWatchUrl(s as object) as string
  if s.iframe <> invalid and s.iframe <> "" then return s.iframe
  if s.uri_name <> invalid and s.uri_name <> ""
    return "https://ppv.st/" + s.uri_name
  end if
  return "https://ppv.st/"
end function

function toStr(v as dynamic) as string
  if type(v) = "roString" or type(v) = "String" then return v
  return Str(v).Trim()
end function

function httpGet(url as string, referer as string) as dynamic
  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.SetUrl(url)
  xfer.AddHeader("Accept", "application/json")
  xfer.AddHeader("User-Agent", "JiyuRoku/0.1 (Roku; first-slice)")
  if referer <> "" then xfer.AddHeader("Referer", referer)
  return xfer.GetToString()
end function
