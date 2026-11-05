# AntiSpamScream

First diagnostic build for HONOR X8b (LLY-LX1), MagicOS 8 / Android 14.

This APK only checks whether Android exposes promising telephony audio route names through Shizuku shell diagnostics. It does not inject audio into cellular calls, does not record calls, and does not replace microphone audio. A matching route name is only a clue, not proof that injection is supported.

## Install and test
1. Install the APK from the GitHub Actions artifact.
2. Install Shizuku from its official source.
3. Start Shizuku using Wireless debugging (Android 11+) or ADB.
4. Open AntiSpam Scream and grant its Shizuku permission.
5. Tap "ПРОВЕРИТЬ ТЕЛЕФОН" and send the report screenshot/text.

No root, bootloader unlock, call-log access, microphone permission, or contacts permission is requested.

## Build
Run `gradle :app:assembleDebug` from this directory with JDK 17 and Android SDK 35.
