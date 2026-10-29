' Jiyu Roku — first slice (local live + sports browse).
sub Main(args as dynamic)
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)

  scene = screen.CreateScene("MainScene")
  screen.Show()

  if args <> invalid and args.DoesExist("contentId")
    scene.deepLinkContentId = args.contentId
  end if

  while true
    msg = wait(0, port)
    msgType = type(msg)
    if msgType = "roSGScreenEvent"
      if msg.IsScreenClosed() then return
    end if
  end while
end sub
