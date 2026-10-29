sub init()
  m.top.functionName = "runTask"
end sub

sub runTask()
  handle = m.top.handle
  liveUrl = m.top.liveUrl
  if handle = invalid then handle = ""
  if liveUrl = invalid then liveUrl = ""

  if liveUrl = ""
    if handle = "" then handle = "@nnn-RADIOLIVE"
    if Left(handle, 1) <> "@" then handle = "@" + handle
    liveUrl = "https://www.youtube.com/" + handle + "/live"
  end if

  html = httpGet(liveUrl)
  videoId = extractVideoId(html)
  isLive = false
  if html <> invalid
    if Instr(1, html, "isLiveNow"":true") > 0 then isLive = true
    if Instr(1, html, "LIVE_STREAM_OFFLINE") > 0 then isLive = false
  end if

  ' Prefer a direct googlevideo HLS URL so Roku can play in-channel with no PC.
  hlsUrl = extractHlsManifestUrl(html)
  if hlsUrl = "" and videoId <> ""
    hlsUrl = fetchHlsFromPlayer(videoId)
  end if
  if hlsUrl = "" and videoId <> ""
    watchHtml = httpGet("https://www.youtube.com/watch?v=" + videoId)
    hlsUrl = extractHlsManifestUrl(watchHtml)
    if isLive = false and watchHtml <> invalid
      if Instr(1, watchHtml, "isLiveNow"":true") > 0 then isLive = true
    end if
  end if

  err = ""
  watchUrl = liveUrl
  ok = false
  if hlsUrl <> "" or videoId <> ""
    ok = true
    if videoId <> "" then watchUrl = "https://www.youtube.com/watch?v=" + videoId
  else
    err = "Could not find Nationwide live on YouTube"
  end if

  m.top.response = {
    ok: ok
    videoId: videoId
    isLive: isLive
    hlsUrl: hlsUrl
    error: err
    watchUrl: watchUrl
  }
end sub

function extractVideoId(html as dynamic) as string
  if html = invalid or html = "" then return ""

  ' Prefer liveStreamability block when present.
  liveKey = Instr(1, html, """liveStreamability""")
  if liveKey > 0
    chunk = Mid(html, liveKey, 500)
    id = extractJsonString(chunk, "videoId")
    if Len(id) = 11 then return id
  end if

  start = 1
  while true
    i = Instr(start, html, """videoId""")
    if i = 0 then exit while
    colon = Instr(i, html, ":")
    if colon = 0
      start = i + 8
    else
      q1 = Instr(colon, html, """")
      if q1 = 0
        start = i + 8
      else
        q2 = Instr(q1 + 1, html, """")
        if q2 = 0
          start = i + 8
        else
          candidate = Mid(html, q1 + 1, q2 - q1 - 1)
          if Len(candidate) = 11 then return candidate
          start = q2 + 1
        end if
      end if
    end if
  end while

  j = Instr(1, html, "/watch?v=")
  if j > 0
    candidate = Mid(html, j + 9, 11)
    if Len(candidate) = 11 then return candidate
  end if
  return ""
end function

function extractHlsManifestUrl(text as dynamic) as string
  if text = invalid or text = "" then return ""
  raw = extractJsonString(text, "hlsManifestUrl")
  if raw = "" then return ""
  return unescapeJsonUrl(raw)
end function

function extractJsonString(text as string, key as string) as string
  if text = invalid or text = "" or key = "" then return ""
  needle = """" + key + """"
  i = Instr(1, text, needle)
  if i = 0 then return ""
  colon = Instr(i + Len(needle), text, ":")
  if colon = 0 then return ""
  q1 = Instr(colon, text, """")
  if q1 = 0 then return ""
  q2 = Instr(q1 + 1, text, """")
  if q2 = 0 then return ""
  return Mid(text, q1 + 1, q2 - q1 - 1)
end function

function unescapeJsonUrl(s as string) as string
  if s = invalid then return ""
  out = s
  out = out.Replace("\u0026", "&")
  out = out.Replace("\/", "/")
  out = out.Replace("\\u0026", "&")
  return out
end function

' Innertube player — try clients that historically expose live HLS.
function fetchHlsFromPlayer(videoId as string) as string
  if videoId = invalid or Len(videoId) <> 11 then return ""

  hls = playerClientTry(videoId, "VISIONOS", "1.02", "101", "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", "Apple", "RealityDevice17,1", "visionOS", "26.5.23O471")
  if hls <> "" then return hls

  hls = playerClientTry(videoId, "IOS", "21.26.4", "5", "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", "Apple", "iPhone16,2", "iPhone", "18.3.2.22D82")
  if hls <> "" then return hls

  hls = playerClientTry(videoId, "TVHTML5", "7.20241001", "7", "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36", "", "", "", "")
  return hls
end function

function playerClientTry(videoId as string, clientName as string, clientVer as string, clientId as string, ua as string, deviceMake as string, deviceModel as string, osName as string, osVersion as string) as string
  clientJson = """clientName"":""" + clientName + """,""clientVersion"":""" + clientVer + """,""hl"":""en"",""gl"":""US"""
  if ua <> "" then clientJson = clientJson + ",""userAgent"":""" + jsonEscape(ua) + """"
  if deviceMake <> "" then clientJson = clientJson + ",""deviceMake"":""" + jsonEscape(deviceMake) + """"
  if deviceModel <> "" then clientJson = clientJson + ",""deviceModel"":""" + jsonEscape(deviceModel) + """"
  if osName <> "" then clientJson = clientJson + ",""osName"":""" + jsonEscape(osName) + """"
  if osVersion <> "" then clientJson = clientJson + ",""osVersion"":""" + jsonEscape(osVersion) + """"

  body = "{""context"":{""client"":{" + clientJson + "}},""videoId"":""" + videoId + """,""playbackContext"":{""contentPlaybackContext"":{""html5Preference"":""HTML5_PREF_WANTS""}}}"

  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.SetUrl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
  xfer.AddHeader("Content-Type", "application/json")
  xfer.AddHeader("Accept", "application/json")
  xfer.AddHeader("User-Agent", ua)
  xfer.AddHeader("X-Youtube-Client-Name", clientId)
  xfer.AddHeader("X-Youtube-Client-Version", clientVer)
  xfer.AddHeader("Origin", "https://www.youtube.com")
  xfer.AddHeader("Referer", "https://www.youtube.com/")

  port = CreateObject("roMessagePort")
  xfer.SetPort(port)
  if not xfer.AsyncPostFromString(body) then return ""
  msg = wait(12000, port)
  if msg = invalid then return ""
  raw = ""
  if type(msg) = "roUrlEvent" then raw = msg.GetString()
  if raw = invalid or raw = "" then return ""
  return extractHlsManifestUrl(raw)
end function

function jsonEscape(s as string) as string
  if s = invalid then return ""
  out = s
  out = out.Replace("\", "\\")
  out = out.Replace("""", "\""")
  return out
end function

function httpGet(url as string) as dynamic
  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.SetUrl(url)
  xfer.AddHeader("Accept", "text/html,application/xhtml+xml")
  xfer.AddHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
  xfer.AddHeader("Accept-Language", "en-US,en;q=0.9")
  return xfer.GetToString()
end function
