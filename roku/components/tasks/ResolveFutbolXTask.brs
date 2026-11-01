sub init()
  m.top.functionName = "runTask"
end sub

sub runTask()
  rawUrl = m.top.rawUrl
  title = m.top.title
  if title = invalid then title = "Match"
  out = signFutbolXUrl(rawUrl)
  out.title = title
  m.top.response = out
end sub

' Simple path that had picture: sign master → validate → play signed master (no media-playlist swap, no bridge).
function signFutbolXUrl(rawUrl as dynamic) as object
  if rawUrl = invalid or rawUrl = ""
    return { ok: false, error: "No Futbol-x URL", proxiedUrl: "" }
  end if
  parts = parseHttpUrl(rawUrl)
  if parts = invalid
    return { ok: false, error: "Bad Futbol-x URL", proxiedUrl: "" }
  end if

  tokenApi = "https://www.futbol-x.xyz/api/token.js?path=" + UrlEncode(parts.path)
  tokenApi = tokenApi + "&sourceHost=" + UrlEncode(parts.host)
  tokenApi = tokenApi + "&expires=900"
  raw = httpGet(tokenApi, "https://www.futbol-x.xyz/", "application/json")
  if raw = invalid or raw = ""
    return { ok: false, error: "Futbol-x token API unreachable", proxiedUrl: "" }
  end if
  data = ParseJson(raw)
  if data = invalid
    return { ok: false, error: "Bad token JSON", proxiedUrl: "" }
  end if
  if data.success <> true
    err = "Token failed"
    if data.error <> invalid then err = data.error
    return { ok: false, error: err, proxiedUrl: "" }
  end if

  signed = rawUrl
  if data.tokenRequired = false
    signed = rawUrl
  else if data.url <> invalid and data.url <> ""
    signed = data.url
  else
    return { ok: false, error: "No signed HLS URL", proxiedUrl: "" }
  end if

  pl = httpGet(signed, "https://www.futbol-x.xyz/", "application/vnd.apple.mpegurl,*/*")
  if pl = invalid or pl = "" or Instr(1, pl, "#EXTM3U") = 0
    return { ok: false, error: "Stream offline — pick a live match", proxiedUrl: "" }
  end if
  if Instr(1, pl, "EXT-X-STREAM-INF") = 0 and Instr(1, pl, "#EXTINF") = 0
    return { ok: false, error: "Stream offline (no bitrates) — pick a live match", proxiedUrl: "" }
  end if

  expiresIn = 900
  if data.expiresIn <> invalid then expiresIn = Int(data.expiresIn)
  return { ok: true, error: "", proxiedUrl: signed, rawUrl: rawUrl, expiresIn: expiresIn }
end function

function parseHttpUrl(url as string) as object
  u = url
  scheme = ""
  if Left(LCase(u), 8) = "https://"
    scheme = "https"
    u = Mid(u, 9)
  else if Left(LCase(u), 7) = "http://"
    scheme = "http"
    u = Mid(u, 8)
  else
    return invalid
  end if
  slash = Instr(1, u, "/")
  if slash = 0
    return { scheme: scheme, host: u, path: "/" }
  end if
  host = Left(u, slash - 1)
  rest = Mid(u, slash)
  q = Instr(1, rest, "?")
  path = rest
  if q > 0 then path = Left(rest, q - 1)
  if path = "" then path = "/"
  return { scheme: scheme, host: host, path: path }
end function

function UrlEncode(s as string) as string
  xfer = CreateObject("roUrlTransfer")
  return xfer.Escape(s)
end function

function httpGet(url as string, referer as string, accept as string) as dynamic
  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.EnableEncodings(true)
  xfer.SetUrl(url)
  if accept <> "" then xfer.AddHeader("Accept", accept)
  xfer.AddHeader("User-Agent", "JiyuRoku/0.1 (Roku; futbolx)")
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
      if code >= 200 and code < 300 then return body
      return invalid
    end if
    if clock.TotalMilliseconds() >= 12000
      xfer.AsyncCancel()
      return invalid
    end if
  end while
  return invalid
end function
