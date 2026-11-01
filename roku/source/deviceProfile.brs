' Roku device profile — mirrors src/lib/deviceProfile.ts (lite/balanced/high → maxQuality).
' Classifies from model + UI resolution; used to cap HLS height per title.

function ensureDeviceProfile() as object
  di = CreateObject("roDeviceInfo")
  model = ""
  display = ""
  if di <> invalid
    model = toStrSafe(di.GetModel())
    display = toStrSafe(di.GetModelDisplayName())
  end if

  uiH = 720
  if di <> invalid
    ' GetUIResolution returns { width, height, name } on modern firmware.
    ui = di.GetUIResolution()
    if ui <> invalid and ui.height <> invalid then uiH = Int(ui.height)
  end if

  deviceClass = classifyRokuDevice(model, display, uiH)
  maxHeight = 720
  if deviceClass = "balanced" then maxHeight = 1080
  if deviceClass = "high" then maxHeight = 1080

  summary = rokuProfileSummary(model, display, uiH, deviceClass, maxHeight)
  return {
    model: model
    display: display
    uiHeight: uiH
    deviceClass: deviceClass
    maxHeight: maxHeight
    summary: summary
  }
end function

function classifyRokuDevice(model as string, display as string, uiHeight as integer) as string
  blob = LCase(model + " " + display)

  ' Known weak / HD-only living-room sets (blank on 1080p ABR).
  if Instr(1, blob, "40fs3850") > 0 then return "lite"
  if Instr(1, blob, "fs3850") > 0 then return "lite"
  if Instr(1, blob, "32s3") > 0 then return "lite"
  if Instr(1, blob, "24s3") > 0 then return "lite"
  if Instr(1, blob, "roku express") > 0 and Instr(1, blob, "4k") = 0 then return "lite"
  if Instr(1, blob, "roku lt") > 0 then return "lite"
  if Instr(1, blob, "roku hd") > 0 then return "lite"

  ' HD UI often means the SoC is decode-limited for 1080p50/60.
  if uiHeight > 0 and uiHeight <= 720 then return "lite"

  ' Stronger sticks / Ultra-class.
  if Instr(1, blob, "ultra") > 0 then return "high"
  if Instr(1, blob, "streambar") > 0 then return "balanced"
  if Instr(1, blob, "streaming stick 4k") > 0 then return "balanced"
  if Instr(1, blob, "premiere") > 0 then return "balanced"
  if Instr(1, blob, "4k") > 0 then return "balanced"

  ' Default mid Roku → balanced (1080 cap).
  return "balanced"
end function

function rokuProfileSummary(model as string, display as string, uiHeight as integer, deviceClass as string, maxHeight as integer) as string
  name = display
  if name = "" then name = model
  if name = "" then name = "Roku"
  classLabel = "Balanced"
  if deviceClass = "lite" then classLabel = "Lite"
  if deviceClass = "high" then classLabel = "High"
  return name + " · UI " + Str(uiHeight).Trim() + "p → " + classLabel + " · max " + Str(maxHeight).Trim() + "p"
end function

' TVJ Univtec ladder: 360 / 540 / 720 / 1080 — pick by device maxHeight.
function tvjUrlForMaxHeight(maxHeight as integer) as string
  base = "https://vod2live.univtec.com/manifest/a99a1804-dc83-411f-8c1c-b62f08cdfa59"
  if maxHeight <= 480 then return base + "/1160000.m3u8"
  if maxHeight <= 720 then return base + "/1660000.m3u8"
  ' 1080-capable: still prefer 720 media playlist on Roku — master ABR often blanks.
  ' Balanced/high may use 720p rung (5160000) which is true 720.
  return base + "/5160000.m3u8"
end function

function toStrSafe(v as dynamic) as string
  if v = invalid then return ""
  t = type(v)
  if t = "roString" or t = "String" then return v
  return Str(v).Trim()
end function
