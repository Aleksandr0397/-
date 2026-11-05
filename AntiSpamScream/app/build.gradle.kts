plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ru.antispamscream"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.antispamscream"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-diagnostic"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("dev.rikka.shizuku:api:13.1.5")
}
