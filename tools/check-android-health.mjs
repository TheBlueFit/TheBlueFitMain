#!/usr/bin/env node
/**
 * Pre-flight check for Health Connect in the Android build.
 * Run from the FRONTEND project root (the folder that holds package.json, capacitor.config.* and android/):
 *     node tools/check-android-health.mjs [path-to-frontend-root]
 * It only reads files; it changes nothing.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || process.cwd());
const results = [];
const ok = (m) => results.push(["OK  ", m]);
const bad = (m) => results.push(["FAIL", m]);
const warn = (m) => results.push(["WARN", m]);
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const major = (v) => Number(String(v || "").replace(/^[^\d]*/, "").split(".")[0]) || null;

// 1. package.json: plugin present and its major version equals Capacitor's major version
const pkgRaw = read(path.join(root, "package.json"));
if (!pkgRaw) {
  bad(`package.json not found in ${root}. Run this from the frontend root, or pass its path.`);
} else {
  const pkg = JSON.parse(pkgRaw);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const plugin = deps["@capgo/capacitor-health"];
  const core = deps["@capacitor/core"];
  const android = deps["@capacitor/android"];
  if (!plugin) bad("@capgo/capacitor-health is not in package.json -> npm install @capgo/capacitor-health");
  else ok(`@capgo/capacitor-health ${plugin}`);
  if (!core) bad("@capacitor/core missing from package.json");
  if (!android) bad("@capacitor/android missing from package.json -> npm install @capacitor/android");
  if (plugin && core && major(plugin) !== major(core))
    bad(`Plugin major (${major(plugin)}) must equal Capacitor major (${major(core)}). Install @capgo/capacitor-health@${major(core)} (or upgrade Capacitor).`);
  else if (plugin && core) ok(`Plugin major matches Capacitor major (${major(core)})`);
  if (!deps["capacitor-native-settings"]) warn("capacitor-native-settings not in package.json (only used as a fallback for opening settings)");
}

// 2. Android project exists
const androidDir = path.join(root, "android");
if (!fs.existsSync(androidDir)) {
  bad("android/ folder not found -> npm run build && npx cap add android && npx cap sync android");
} else {
  ok("android/ folder found");

  // 3. minSdk >= 26
  const vars = read(path.join(androidDir, "variables.gradle"));
  const m = vars && vars.match(/minSdkVersion\s*=\s*(\d+)/);
  if (!m) warn("Could not read minSdkVersion from android/variables.gradle");
  else if (Number(m[1]) < 26) bad(`minSdkVersion is ${m[1]}; Health Connect needs 26 or higher (edit android/variables.gradle).`);
  else ok(`minSdkVersion ${m[1]}`);

  // 4. plugin registered in the native project
  const capPlugins = read(path.join(androidDir, "app", "src", "main", "assets", "capacitor.plugins.json"));
  if (!capPlugins) warn("capacitor.plugins.json not generated yet -> run: npx cap sync android");
  else if (!/capgo|Health/i.test(capPlugins)) bad("Health plugin is NOT registered in capacitor.plugins.json -> run: npx cap sync android");
  else ok("Health plugin registered with Capacitor (capacitor.plugins.json)");

  // 5. the app must not remove the plugin's manifest entries
  const manifest = read(path.join(androidDir, "app", "src", "main", "AndroidManifest.xml"));
  if (!manifest) bad("android/app/src/main/AndroidManifest.xml not found");
  else {
    if (/tools:node=["']remove["'][^>]*health|health[^>]*tools:node=["']remove["']/i.test(manifest))
      bad("AndroidManifest.xml removes a health permission (tools:node=remove).");
    else ok("Manifest does not strip health permissions (the plugin adds READ_STEPS / SLEEP / HEART_RATE / CALORIES itself on build)");
  }

  // 6. privacy policy for the Health Connect permission screen
  const strings = read(path.join(androidDir, "app", "src", "main", "res", "values", "strings.xml")) || "";
  const asset = fs.existsSync(path.join(androidDir, "app", "src", "main", "assets", "public", "privacypolicy.html"));
  if (/health_connect_privacy_policy_url/.test(strings)) ok("Privacy policy URL string is set");
  else if (asset) ok("privacypolicy.html is bundled in assets/public");
  else warn("No privacy policy found. Put privacypolicy.html in the web 'public/' folder (then npm run build && npx cap sync android) or set health_connect_privacy_policy_url in strings.xml. Health Connect shows a blank page without it.");
}

for (const [tag, msg] of results) console.log(`${tag}  ${msg}`);
const failed = results.some(([t]) => t === "FAIL");
console.log(failed ? "\nFix the FAIL lines above, then rebuild." : "\nNothing blocking found in the project files.");
process.exit(failed ? 1 : 0);
