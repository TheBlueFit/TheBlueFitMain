# iPhone Apple Health sync + logo — what changed

## Logo
- `public/icons/`: icon-192/512 (any), icon-maskable-192/512, apple-touch-icon (180), icon-1024 (for @capacitor/assets → native app icons), favicon-32, logo-round(.png/-128) (in-app).
- `app/favicon.ico` regenerated. `app/manifest.json` (+ copy in `public/manifest.json`) uses navy `#1C2541`.
- `app/layout.tsx`: one shared `<PwaHead/>` (the signed-in layout previously had NO manifest / apple-touch-icon tags).
- Logo shown on the login screen and in the mobile header. `public/sw.js` cache bumped to v3.
- After deploy iPhone users must remove and re-add the home-screen icon to see the new one (iOS caches it).

## Apple Health on iPhone
Web apps / home-screen apps cannot read Apple Health (HealthKit is native-only). So:
1. Athlete taps **Turn on Apple Health sync** (client dashboard, iPhone only) → personal sync key (copied to clipboard).
2. Taps **Get the shortcut**, pastes the key once, allows Health access.
3. Adds one Time-of-Day automation (Run Immediately). Done.

### You must do once: build & share the shortcut
1. In Shortcuts build the shortcut described under "How to build the shortcut" in the card
   (URL = `<API>/health-sync/ingest`, put an **Import Question** on the key field so it asks on install).
2. Share → Copy iCloud Link.
3. Set `NEXT_PUBLIC_IOS_SHORTCUT_URL=<that link>` in the frontend environment and rebuild.

### Backend
New routes (in `functions/core_api/main.py`): `POST/DELETE /athlete/health-sync/key`, `GET /athlete/health-sync/status`,
`POST /health-sync/ingest` (auth = sync key, write-only for that athlete). Only a SHA-256 of the key is stored.
Tests: `python3 tests/test_health_sync.py`.

### Native iOS app (least user effort: install, tap Allow once)
The iOS app now uses the same `@capgo/capacitor-health` code path as Android (the "coming soon" deferral is removed).
If HealthKit isn't available the card automatically falls back to the Shortcut setup above. To ship it:
1. `npx cap add ios` (if not yet), `npx cap sync ios`.
2. Xcode → Signing & Capabilities → add **HealthKit**.
3. Info.plist: `NSHealthShareUsageDescription` = "The Blue Fit reads your steps, sleep, calories and heart rate to show your progress to you and your coach."
4. Apple Developer account → TestFlight / App Store.
