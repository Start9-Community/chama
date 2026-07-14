# Android build

The `android/` directory is the Capacitor Android application project. It is required source, not a generated export: it contains the manifest, Gradle configuration, native activity, resources, signing hooks, and integration that packages Chama's Rust Fedimint bridge.

## Requirements

- Node.js 22+ and npm
- Android Studio with a compatible Android SDK
- Android NDK (Side by side), or `ANDROID_NDK_HOME`
- Rust targets installed by `scripts/build-android-fedimint-bridge.sh`

## Sync the web application

```bash
npm install
npm run android:sync
```

This builds the Vite application and copies the resulting `dist/` bundle into the Android project.

## Build from Android Studio

Open `android/` in Android Studio and build the `app` module. Debug builds can also be produced from the command line:

```bash
cd android
./gradlew :app:assembleDebug
```

Release signing credentials must stay outside Git. See `android/keystore.properties.example` for the supported local configuration and `android/app/build.gradle` for the equivalent environment variables.

The release build must contain both:

- `lib/arm64-v8a/libchama_fedimint_bridge.so`
- `lib/arm64-v8a/libc++_shared.so`

The release helper validates those libraries and rejects unexpectedly large APKs:

```bash
./scripts/android-release.sh
```
