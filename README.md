# tvhome

A cinematic home screen for Samsung Tizen TVs, packaged as a [TizenBrew](https://github.com/reisxd/TizenBrew) app module.

- Large clock, date and local weather ([Open-Meteo](https://open-meteo.com), no key)
- Backdrop that takes its color from the focused app's icon
- Rows: **Apps** (TizenTube first, then installed apps, with Samsung bloat hidden), **Inputs** (HDMI 1–4, Sources), **PC** (wake, sleep, lock, restart, shut down), **TV** (screensaver, reload, power off)
- Screensaver after 5 idle minutes, with a drifting clock for OLED burn-in care

## Install on the TV

1. TizenBrew → Module Manager → **Add GitHub module** → `SufenueS1/tvhome@main`
2. Open **Home** from TizenBrew.
3. Optional: TizenBrew Settings → set Home as the auto-launch module, then on the TV turn on
   Settings → General → Smart Features → **Autorun Last App**.

To skip auto-launch once (for example to reach the Module Manager), hold **Up** while TizenBrew opens.
Press the **red** button on the remote to reload Home.

## PC agent (optional)

`agent/` contains a small stdlib-Python agent that lets the TV sleep, lock, restart or shut down a Windows PC.
The agent connects out to the TV and long-polls for commands, so the PC needs no inbound firewall rule.
Wake uses Wake-on-LAN from the TV.

```powershell
agent\setup.ps1 -TvIp <tv-ip> -Lat <lat> -Lon <lon> -Place "<town>"   # config + Startup shortcut, starts it
agent\setup.ps1 -Remove                                               # undo
```

`agent/config.json` holds the shared key and is never committed.

## How it fits together

| Piece | Runs | Does |
|---|---|---|
| `app/index.html` | TizenBrew's window | The UI. Talks to the service on `127.0.0.1:8095` and to TizenBrew on `127.0.0.1:8081` to open TizenTube. |
| `service/service.js` | TizenBrew's Node service | HTTP server; loads `core.js` from the CDN (`GET /__reload` refreshes it without a reboot). |
| `service/core.js` | same | App list and icons (`tizen.application`), launching, HDMI keys via the TV's own remote API, the PC link and Wake-on-LAN. |

Local requests get the full API. LAN requests get read-only endpoints; everything else needs the PC agent's key.
