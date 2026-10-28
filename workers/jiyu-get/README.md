# jiyu (short download links)

Redirect-only Cloudflare Worker. No bindings, no secrets, no storage; separate from
`jiyu-sync`, so deploying it can never affect Continue-watching sync.

| Link | Goes to |
| --- | --- |
| `https://jiyu.free-river.workers.dev/tv` | `releases/latest/download/Jiyu-TV.apk` (universal arm64+armv7). Falls back to the arm64 APK from `latest-android.yml` while a release has no `Jiyu-TV.apk`. |
| `/tv64`, `/apk` | arm64 APK named in `latest-android.yml` |
| `/win` | Windows installer named in `latest.yml` |
| `/` | small HTML page with the links |

Targets are always GitHub `releases/latest/download/...`, so a new release needs no
redeploy. Lookups are cached 5 minutes.

Deploy (existing wrangler login):

```
cd workers/jiyu-get
wrangler deploy
```

Fire TV / Google TV "Downloader" app codes (AFTVnews): register
`https://jiyu.free-river.workers.dev/tv` once at https://go.aftvnews.com — the code
keeps working for every future release because the URL never changes.
