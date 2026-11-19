#!/usr/bin/env bash
# One-time: create the release signing key for The Blue Fit and print what to paste into GitHub secrets.
# Needs Java's keytool (comes with Android Studio / any JDK). Run from anywhere:
#     bash tools/make-release-key.sh
#
# KEEP the .jks file and passwords somewhere safe (password manager + offline backup).
# If you lose them you can never update the app under the same signing identity.
set -euo pipefail

KEYSTORE="${1:-thebluefit-release.jks}"
ALIAS="${2:-thebluefit}"

if [ -e "$KEYSTORE" ]; then
  echo "$KEYSTORE already exists; refusing to overwrite it." >&2
  exit 1
fi

read -r -s -p "Choose a keystore password (6+ chars): " STOREPASS; echo
read -r -s -p "Repeat it: " STOREPASS2; echo
[ "$STOREPASS" = "$STOREPASS2" ] || { echo "Passwords differ." >&2; exit 1; }

keytool -genkeypair -v \
  -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$STOREPASS" -keypass "$STOREPASS" \
  -dname "CN=The Blue Fit, O=The Blue Fit, C=IN"

base64 < "$KEYSTORE" | tr -d '\n' > keystore.base64.txt

cat <<EOF

Done. Add these in GitHub: Settings > Secrets and variables > Actions > New repository secret
  ANDROID_KEYSTORE_BASE64   = contents of keystore.base64.txt
  ANDROID_KEYSTORE_PASSWORD = the password you just typed
  ANDROID_KEY_ALIAS         = $ALIAS
  ANDROID_KEY_PASSWORD      = the same password (PKCS12 uses one password)

Then delete keystore.base64.txt, and back up $KEYSTORE outside the repository.
EOF
