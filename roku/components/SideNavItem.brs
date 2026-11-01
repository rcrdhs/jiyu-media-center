sub init()
  m.pill = m.top.findNode("pill")
  m.dot = m.top.findNode("dot")
  m.label = m.top.findNode("label")
  m.accent = &h8B95A8FF
end sub

sub onContentSet()
  item = m.top.itemContent
  if item = invalid then return
  m.label.text = item.title
  if item.accent <> invalid
    m.accent = item.accent
  else
    m.accent = &h8B95A8FF
  end if
  m.dot.color = m.accent
  applyChrome(m.top.focusPercent > 0.5)
end sub

sub onFocusPercent()
  applyChrome(m.top.focusPercent > 0.5)
end sub

sub applyChrome(focused as boolean)
  if focused
    ' Gold capsule like desktop .nav a.active / Home highlight.
    m.pill.color = &hF0B42933
    m.label.color = &hF0B429FF
    m.dot.color = &hF0B429FF
  else
    m.pill.color = &h00000000
    m.label.color = &hE8ECF4FF
    m.dot.color = m.accent
  end if
end sub
