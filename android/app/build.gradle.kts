plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.vk7tv.module"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.vk7tv.module"
        // 28 — ради ImageDecoder/AnimatedImageDrawable: анимированные webp
        // с 7TV декодируются системой, свой GIF-декодер не нужен
        minSdk = 28
        targetSdk = 34
        versionCode = 24
        versionName = "0.5.15"
    }

    buildFeatures {
        // ради BuildConfig.VERSION_NAME в диагностике
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // ТОЛЬКО compileOnly: классы Xposed в APK попадать не должны,
    // иначе модуль конфликтует с реализацией из LSPosed.
    compileOnly("de.robv.android.xposed:api:82")
}
