sub init()
  m.poster = m.top.findNode("poster")
  m.title = m.top.findNode("title")
  m.frame = m.top.findNode("frame")
  m.focusRing = m.top.findNode("focusRing")
end sub

sub onContentSet()
  item = m.top.itemContent
  if item = invalid then return
  m.title.text = item.title
  if item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
    m.poster.uri = item.HDPosterUrl
  else
    m.poster.uri = "pkg:/images/channel-poster_hd.png"
  end if
end sub

sub onFocusPercent()
  focused = m.top.focusPercent > 0.5
  if focused
    m.focusRing.color = &hF0B429FF
    m.frame.color = &h2A3340FF
  else
    m.focusRing.color = &h1A1F2700
    m.frame.color = &h1A1F27FF
  end if
end sub
