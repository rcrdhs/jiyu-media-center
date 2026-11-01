sub init()
  m.poster = m.top.findNode("poster")
  m.title = m.top.findNode("title")
  m.meta = m.top.findNode("meta")
  m.card = m.top.findNode("card")
  m.body = m.top.findNode("body")
  m.focusOuter = m.top.findNode("focusOuter")
  m.focusRing = m.top.findNode("focusRing")
  m.liveChip = m.top.findNode("liveChip")
  m.liveLabel = m.top.findNode("liveLabel")
end sub

sub onContentSet()
  item = m.top.itemContent
  if item = invalid then return
  m.title.text = item.title

  meta = ""
  if item.ShortDescriptionLine1 <> invalid then meta = item.ShortDescriptionLine1
  if meta = "" and item.detail <> invalid then meta = item.detail
  m.meta.text = meta

  if item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
    m.poster.uri = item.HDPosterUrl
  else
    m.poster.uri = "pkg:/images/channel-poster_hd.png"
  end if

  live = false
  if Instr(1, LCase(meta), "live") > 0 then live = true
  if item.kind <> invalid
    k = LCase(item.kind)
    if k = "futbolx" or k = "hls" or k = "nationwide" or k = "youtube" then live = true
    if k = "series" or k = "info" then live = false
  end if
  m.liveChip.visible = live
  m.liveLabel.visible = live
end sub

sub onFocusPercent()
  focused = m.top.focusPercent > 0.5
  if focused
    m.focusOuter.color = &hF0B429FF
    m.focusRing.color = &h080A0DFF
    m.card.color = &h171D26FF
    m.body.color = &h171D26FF
    m.title.color = &hF0B429FF
  else
    m.focusOuter.color = &h00000000
    m.focusRing.color = &h00000000
    m.card.color = &h10141AFF
    m.body.color = &h10141AFF
    m.title.color = &hE8ECF4FF
  end if
end sub
