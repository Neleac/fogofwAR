# fogofwAR

Meta Ray-Ban Display web app: a full-screen live location map with a minimal on-map zoom slider.

- D-pad / arrow keys pan the map.
- The live location marker shows facing direction when orientation data is available.
- GPS position is tracked continuously while the app is visible.
- On glasses, pinch/select recenters on the latest GPS fix.
- Quick Right+Right selects the right-side zoom slider; quick Left+Left deselects it.
- While the zoom slider is selected, Up zooms in and Down zooms out.
- Back/Escape zooms out.
- In desktop browsers, `+`, `-`, wheel, and gesture events zoom.
- Uses Leaflet and OpenStreetMap tiles, with no paid APIs or API keys.

Run locally:

```bash
npm run dev
```

Then open the local URL printed by the server. It serves the app from `src/`, starts at `http://127.0.0.1:4173`, and uses the next free port if that one is busy. For the glasses, deploy over HTTPS so geolocation is available on-device.

Deploy for device testing:

```bash
npm run build
cd dist
vercel --yes
vercel alias set <DEPLOYMENT_URL> stage-fogofwar-display-map.vercel.app
```
