#!/bin/bash
# Compila el APK sin Gradle ni dependencias. Uso: ./build.sh [debug]
# debug: apunta al servidor local (adb reverse), con otro id, para probar sin tocar la versión real.
set -euo pipefail
cd "$(dirname "$0")"
MODE=${1:-release}; VERSION_CODE=${VERSION_CODE:-1}; VERSION_NAME=${VERSION_NAME:-1.0}
SDK=/opt/homebrew/share/android-commandlinetools; BT=$SDK/build-tools/35.0.0; JAR=$SDK/platforms/android-35/android.jar
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; export PATH="$JAVA_HOME/bin:$PATH"
B=build/$MODE; rm -rf "$B"; mkdir -p "$B/gen" "$B/classes" "$B/dex" "$B/tmp/src"
cp -R src/. "$B/tmp/src/"; cp AndroidManifest.xml "$B/tmp/AndroidManifest.xml"; EXTRA=()
if [ "$MODE" = debug ]; then
  sed -i '' 's#https://albertogxrcia.github.io/notas/#http://127.0.0.1:5173/#' "$B/tmp/src/com/albertogxrcia/notas/MainActivity.java"
  sed -i '' 's#usesCleartextTraffic="false"#usesCleartextTraffic="true"#; s#android:label="@string/app_name"#android:label="Notas prueba"#' "$B/tmp/AndroidManifest.xml"
  EXTRA=(--rename-manifest-package com.albertogxrcia.notas.debug)
fi
"$BT/aapt2" compile --dir res -o "$B/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$B/tmp/AndroidManifest.xml" --java "$B/gen" -o "$B/base.apk" "$B/res.zip" \
  --min-sdk-version 30 --target-sdk-version 35 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" ${EXTRA[@]+"${EXTRA[@]}"}
javac -nowarn -Xlint:-options --release 8 -classpath "$JAR" -d "$B/classes" $(find "$B/gen" "$B/tmp/src" -name '*.java')
"$BT/d8" --release --min-api 30 --lib "$JAR" --output "$B/dex" $(find "$B/classes" -name '*.class')
(cd "$B/dex" && zip -q -j ../base.apk classes.dex)
"$BT/zipalign" -f -p 4 "$B/base.apk" "$B/aligned.apk"
set -a; source ../.env; set +a
KS=notas-release.jks
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias notas -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass:env NOTAS_KS_PASS -keypass:env NOTAS_KS_PASS -dname "CN=Notas" >/dev/null 2>&1
fi
OUT=build/Notas${MODE/release/}.apk; [ "$MODE" = debug ] && OUT=build/Notas-debug.apk
"$BT/apksigner" sign --ks "$KS" --ks-key-alias notas --ks-pass env:NOTAS_KS_PASS --key-pass env:NOTAS_KS_PASS --out "$OUT" "$B/aligned.apk"
"$BT/apksigner" verify "$OUT" && echo "APK correcto: android/$OUT ($(( $(stat -f %z "$OUT") / 1024 )) KB)"
