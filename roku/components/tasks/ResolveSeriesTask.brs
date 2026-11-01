sub init()
  m.top.functionName = "runTask"
end sub

sub runTask()
  title = m.top.title
  if title = invalid then title = ""
  tmdbId = m.top.tmdbId
  season = m.top.season
  episode = m.top.episode
  if season = invalid or season < 1 then season = 1
  if episode = invalid or episode < 1 then episode = 1

  if tmdbId = invalid or tmdbId = ""
    m.top.response = { ok: false, error: "Missing TMDB id", title: title }
    return
  end if

  base = rokuHlsBase()
  if base = invalid or base = ""
    m.top.response = {
      ok: false
      error: "roku-hls base URL missing — run npm run pack:roku"
      title: title
    }
    return
  end if

  maxHeight = m.top.maxHeight
  if maxHeight = invalid or maxHeight < 360
    profile = ensureDeviceProfile()
    maxHeight = profile.maxHeight
  end if

  token = rokuHlsToken()
  endpoint = base + "/api/series/resolve?tmdbId=" + UrlEncode(tmdbId)
  endpoint = endpoint + "&season=" + Str(season).Trim() + "&episode=" + Str(episode).Trim()
  endpoint = endpoint + "&maxHeight=" + Str(maxHeight).Trim()
  if token <> invalid and token <> ""
    endpoint = endpoint + "&token=" + UrlEncode(token)
  end if

  raw = httpGet(endpoint, 90000)
  if raw = invalid or raw = ""
    m.top.response = {
      ok: false
      error: "roku-hls series resolve failed — is npm run roku-hls running?"
      title: title
    }
    return
  end if

  data = ParseJson(raw)
  if data = invalid or data.ok <> true or data.proxiedUrl = invalid or data.proxiedUrl = ""
    err = "Could not resolve series stream"
    if data <> invalid and data.error <> invalid and data.error <> "" then err = data.error
    m.top.response = { ok: false, error: err, title: title }
    return
  end if

  m.top.response = {
    ok: true
    proxiedUrl: data.proxiedUrl
    provider: data.provider
    season: season
    episode: episode
    title: title
  }
end sub

function httpGet(url as string, timeoutMs as integer) as dynamic
  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.EnableEncodings(true)
  xfer.SetUrl(url)
  xfer.AddHeader("Accept", "application/json")
  xfer.AddHeader("User-Agent", "JiyuRoku/0.1 (Roku; series)")
  token = rokuHlsToken()
  if token <> invalid and token <> ""
    xfer.AddHeader("X-Jiyu-Token", token)
  end if

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

function UrlEncode(s as string) as string
  xfer = CreateObject("roUrlTransfer")
  return xfer.Escape(s)
end function
