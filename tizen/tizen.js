/* Samsung TV boot. Runs before the React bundle. */
document.documentElement.classList.add('is-tizen')
document.addEventListener('DOMContentLoaded', function () {
  document.body.classList.add('is-tizen')
})

var mediaKeys = [
  'Exit',
  'MediaPlay',
  'MediaPause',
  'MediaPlayPause',
  'MediaStop',
  'MediaFastForward',
  'MediaRewind',
]

if (window.tizen && tizen.tvinputdevice && tizen.tvinputdevice.registerKey) {
  mediaKeys.forEach(function (name) {
    try {
      tizen.tvinputdevice.registerKey(name)
    } catch (err) {
      /* Key is already registered, or this TV profile does not expose it. */
    }
  })
}

document.addEventListener('keydown', function (event) {
  /* Samsung Return key. At the home hash, let the TV exit the app. */
  if (event.keyCode !== 10009) return
  var hash = location.hash || '#/'
  if (hash === '#/' || hash === '#' || hash === '#/home') return
  event.preventDefault()
  history.back()
})
