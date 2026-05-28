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

Release builds also compile and package the native Rust Fedimint bridge. Install
Android Studio's **NDK (Side by side)** package before building, or set
`ANDROID_NDK_HOME` to an existing NDK path. This is required: the release script
refuses APKs that do not contain `lib/arm64-v8a/libchama_fedimint_bridge.so`.

```sh
./scripts/android-release.sh
```

The script runs typecheck, tests, web build, Capacitor sync, native Fedimint
bridge build, Gradle release build, APK bridge verification, and prints the APK
path plus SHA-256 hash.

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

## 5. Publish to Zapstore

Chama keeps Zapstore metadata in `zapstore.yaml`. The config points `zsp` at
the local release APK, so build or reuse the APK before publishing.

First-time setup needs one manual identity link between the Android signing
certificate and the Chama Zapstore publisher npub:

```sh
# One-time helper file; delete it after linking.
keytool -importkeystore \
  -srckeystore android/keystore/chama-release.jks \
  -destkeystore /private/tmp/chama-zapstore-release.p12 \
  -deststoretype PKCS12 \
  -srcalias chama-v1 \
  -destalias chama-v1

KEYSTORE_PASSWORD=... SIGN_WITH=browser \
  zsp identity --link-key /private/tmp/chama-zapstore-release.p12 --link-key-expiry 2y
```

Before approving a browser signer prompt, confirm the signer pubkey is the
publisher in `zapstore.yaml`. The Chama publisher is:

```text
npub1ytm3v8mkup6mnc9z2zjy0zz2czdsfd3kal7hcup6jgu5a5lm885qhup3z6
```

For the current release, or any local manual publish:

```sh
SIGN_WITH=browser CHAMA_ZSP_BIN=/path/to/zsp \
  ./scripts/android-release.sh --no-build --zapstore
```

For CI/CD, use a NIP-46 bunker URL stored in secret management rather than an
`nsec` in shell history or repository files:

```sh
SIGN_WITH='bunker://...' ./scripts/release-all.sh --github-release --zapstore
```
