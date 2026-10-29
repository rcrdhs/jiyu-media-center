sub init()
  m.top.functionName = "runTask"
end sub

sub runTask()
  iframe = m.top.iframe
  title = m.top.title
  if title = invalid then title = ""
  if iframe = invalid or iframe = ""
    m.top.response = { ok: false, error: "Missing embed URL", title: title }
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
  if Instr(1, base, "127.0.0.1") > 0
    m.top.response = {
      ok: false
      error: "Set the PC LAN IP in config (run npm run pack:roku on the PC)"
      title: title
    }
    return
  end if

  token = rokuHlsToken()
  endpoint = base + "/api/resolve"
  body = "{""iframe"":""" + jsonEscape(iframe) + """}"

  xfer = CreateObject("roUrlTransfer")
  xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  xfer.InitClientCertificates()
  xfer.RetainBodyOnError(true)
  xfer.SetUrl(endpoint)
  xfer.AddHeader("Content-Type", "application/json")
  xfer.AddHeader("Accept", "application/json")
  xfer.AddHeader("User-Agent", "JiyuRoku/0.1")
  if token <> invalid and token <> ""
    xfer.AddHeader("X-Jiyu-Token", token)
  end if

  port = CreateObject("roMessagePort")
  xfer.SetPort(port)
  if not xfer.AsyncPostFromString(body)
    m.top.response = {
      ok: false
      error: "Could not start request to roku-hls at " + base
      title: title
    }
    return
  end if

  ' MSE/P2P capture + optional embed retry can need ~60s.
  msg = wait(70000, port)
  if msg = invalid
    m.top.response = {
      ok: false
      error: "roku-hls timed out at " + base + " — is npm run roku-hls running? Firewall allowing port 8791?"
      title: title
    }
    return
  end if

  raw = ""
  code = 0
  if type(msg) = "roUrlEvent"
    code = msg.GetResponseCode()
    raw = msg.GetString()
  end if

  if raw = invalid or raw = ""
    m.top.response = {
      ok: false
      error: "No response from roku-hls at " + base + " — is npm run roku-hls running on the PC?"
      title: title
    }
    return
  end if

  data = ParseJson(raw)
  if data = invalid
    m.top.response = {
      ok: false
      error: "Bad JSON from roku-hls (HTTP " + Str(code).Trim() + ")"
      title: title
    }
    return
  end if

  if data.ok = true and data.proxiedUrl <> invalid and data.proxiedUrl <> ""
    proxied = data.proxiedUrl
    ' Never play 127.0.0.1 on the TV — rewrite to the stamped PC base.
    if Instr(1, proxied, "127.0.0.1") > 0
      pathStart = Instr(1, proxied, "/api/")
      if pathStart > 0
        proxied = base + Mid(proxied, pathStart)
      end if
    end if
    m.top.response = {
      ok: true
      proxiedUrl: proxied
      mediaUrl: data.mediaUrl
      title: title
      error: ""
    }
    return
  end if

  err = "Resolve failed"
  if data.error <> invalid and data.error <> "" then err = data.error
  m.top.response = { ok: false, error: err, title: title }
end sub

function jsonEscape(s as string) as string
  if s = invalid then return ""
  out = s
  out = out.Replace("\", "\\")
  out = out.Replace("""", "\""")
  out = out.Replace(Chr(10), "\n")
  out = out.Replace(Chr(13), "\r")
  return out
end function
