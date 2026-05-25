# Android Release

Chama release APKs must be signed with the same Android keystore for every
future update. Keep the keystore and passwords outside git.

## 1. Generate the release keystore

Run this locally and enter a strong password when prompted:

```sh
mkdir -p android/keystore
keytool -genkeypair \
  -v \
  -keystore android/keystore/chama-release.jks \
  -alias chama-v1 \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=Chama, OU=Chama, O=Chama, L=New York, ST=NY, C=US"
```

Back up `android/keystore/chama-release.jks` and the passwords immediately.
Losing them means future APK updates cannot be signed as the same app.

## 2. Configure signing

Copy the example file and fill in the real passwords:

```sh
cp android/keystore.properties.example android/keystore.properties
```

Expected local file:

```properties
storeFile=keystore/chama-release.jks
storePassword=...
keyAlias=chama-v1
keyPassword=...
```

`android/keystore.properties` and `android/keystore/` are ignored by git.

CI or one-off builds may instead set:

```sh
CHAMA_ANDROID_STORE_FILE=keystore/chama-release.jks
CHAMA_ANDROID_STORE_PASSWORD=...
CHAMA_ANDROID_KEY_ALIAS=chama-v1
CHAMA_ANDROID_KEY_PASSWORD=...
```

## 3. Build the signed APK

```sh
./scripts/android-release.sh
```

The script runs typecheck, tests, web build, Capacitor sync, Gradle release
build, and prints the APK path plus SHA-256 hash.

Expected APK:

```text
android/app/build/outputs/apk/release/app-release.apk
```

Install and smoke test before publishing:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

## 4. Publish order

1. Push the source commit and `vX.Y.Z` tag.
2. Create the GitHub release with the APK and SHA-256.
3. Publish the same APK through Zapstore with the Chama publisher identity.

