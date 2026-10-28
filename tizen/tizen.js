/* Samsung TV boot. Classic (non-module) script that runs before the app bundle.
 * Keep it ES5: 2018-2020 sets run an old Chromium. */
(function () {
  var html = document.documentElement
  html.className += ' is-tizen tv-mode'
  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('is-tizen')
  })

  /* keyCode -> app media key (same names MainActivity sends on Android TV). */
  var MEDIA = {
    415: 'play', // MediaPlay
    19: 'pause', // MediaPause
    10252: 'playpause', // MediaPlayPause
    413: 'stop', // MediaStop
    417: 'forward', // MediaFastForward
    412: 'rewind', // MediaRewind
    10233: 'next', // MediaTrackNext
    10232: 'previous', // MediaTrackPrevious
  }
  var REGISTER = [
    'MediaPlay',
    'MediaPause',
    'MediaPlayPause',
    'MediaStop',
    'MediaFastForward',
    'MediaRewind',
    'MediaTrackNext',
    'MediaTrackPrevious',
  ]
  try {
    if (window.tizen && tizen.tvinputdevice && tizen.tvinputdevice.registerKeyBatch) {
      tizen.tvinputdevice.registerKeyBatch(REGISTER)
    } else if (window.tizen && tizen.tvinputdevice) {
      REGISTER.forEach(function (name) {
        try {
          tizen.tvinputdevice.registerKey(name)
        } catch (err) {
          /* not on this model */
        }
      })
    }
  } catch (err) {
    /* desktop test */
  }

  function emit(name, detail) {
    var ev
    try {
      ev = new CustomEvent(name, { detail: detail })
    } catch (err) {
      ev = document.createEvent('CustomEvent')
      ev.initCustomEvent(name, false, false, detail)
    }
    window.dispatchEvent(ev)
  }

  /* Capture on window, registered before React: the app never sees raw 10009 /
   * media keyCodes, only jiyu:tizen-back / jiyu:tizen-media-key (tvMode.ts). */
  window.addEventListener(
    'keydown',
    function (event) {
      var code = event.keyCode
      if (code === 10009) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) emit('jiyu:tizen-back', {})
        return
      }
      var key = MEDIA[code]
      if (key) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) emit('jiyu:tizen-media-key', { key: key })
      }
    },
    true,
  )

  /* Pause when the TV hides the app (Home / source switch). */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) return
    var vids = document.getElementsByTagName('video')
    for (var i = 0; i < vids.length; i++) {
      try {
        vids[i].pause()
      } catch (err) {
        /* ignore */
      }
    }
  })
})()
