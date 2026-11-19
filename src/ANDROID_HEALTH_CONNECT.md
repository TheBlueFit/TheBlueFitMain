# Android: Health Connect permission - what to do

The app code already asks Android for Health Connect access (through `@capgo/capacitor-health`). When it
"does nothing" on the APK it is one of the causes below; the Health card on the client Today screen now says which.

| Card says | Cause | Fix |
|---|---|---|
| "This build of the app does not include the health plugin" | plugin missing from the APK | `npm i @capgo/capacitor-health@<same major as @capacitor/core>`, `npm run build`, `npx cap sync android`, reinstall APK |
| "Health Connect is not installed" (Install button) | Android 13 or older has no Health Connect | tap Install (Play Store), then Allow |
| "needs an update" | old Health Connect | tap Update |
| "Allow access in Health Connect" | Android stopped showing the pop-up after two denials | tap Open settings > App permissions > The Blue Fit > allow Steps, Sleep, Active calories, Heart rate |
| Allow button shows the pop-up | working | |

## Build steps
1. `node tools/check-android-health.mjs` from the frontend root (checks plugin version, minSdk 26, plugin registration, privacy policy).
2. `npm run build` then `npx cap sync android` (the plugin merges its own Health permissions and the privacy-policy activity into the manifest).
3. `public/privacypolicy.html` is copied into the APK; replace its text with your final policy before publishing to Google Play.
4. Uninstall the old APK first when testing (permission state is remembered per install), install, sign in as a CLIENT.

## Notes
- Android 14+ has Health Connect built in; Android 8-13 need the Play Store app.
- Google Play requires the Health Connect permission declaration form for store releases; side-loaded APKs work without it.
- Logcat filter for problems: `adb logcat | grep -i -E "health|capacitor"`.
