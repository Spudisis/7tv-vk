plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.vk7tv.installer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.vk7tv.installer"
        // 28 — та же нижняя граница, что у модуля: ниже неё модуль всё равно
        // не запустится, незачем пускать установщик на устройства без модуля.
        minSdk = 28
        targetSdk = 34
        versionCode = 14
        versionName = "0.3.11"
    }

    buildFeatures {
        buildConfig = true
    }

    // liblspatch.so лежит внутри lspatch.jar как ресурс assets/lspatch/so/...,
    // а не в lib/ APK. Читается через getResourceAsStream, поэтому распаковывать
    // и не сжимать его не нужно — но и мешать упаковке ресурсов нельзя.
    packaging {
        // classes.dex установщика — это весь конвейер LSPatch (apkzlib, guava,
        // bouncycastle…), больше 10 МБ. По умолчанию AGP кладёт dex в APK без
        // сжатия ради быстрой установки и mmap; но у человека со слабым
        // интернетом узкое место — сам скачиваемый размер, а не установка.
        // Сжатый dex вдвое меньше, качается надёжнее — компромисс в нашу пользу.
        dex {
            useLegacyPackaging = true
        }
        resources {
            // apkzlib и его зависимости тащат за собой служебные файлы, которые
            // при слиянии ресурсов конфликтуют между собой. Нам они не нужны.
            excludes += setOf(
                "META-INF/*.kotlin_module",
                "META-INF/versions/**",
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/*.SF",
                "META-INF/*.DSA",
                "META-INF/*.RSA",
                "META-INF/maven/**",
                "META-INF/proguard/**",
                "**/module-info.class",
            )
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        // guava и apkzlib в lspatch.jar собраны под свежую джаву и трогают
        // java.time / java.nio.file — десугаринг подставляет их на старых API.
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Собранный APK самого модуля кладём в assets установщика как офлайн-запас:
    // если GitHub недоступен, патчим тем, что было на момент сборки установщика.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("bundledModule"))

    // liblspatch.so лежит в lspatch.jar по пути assets/lspatch/so/<arch>/…,
    // а не в lib/. Слияние java-ресурсов AGP выкидывает любые .so (их, мол,
    // должен паковать другой шаг — но тот смотрит только в lib/). Достаём их
    // сами и кладём в Android-assets по ТОМУ ЖЕ zip-пути assets/lspatch/so/…:
    // так LSPatch найдёт их через getResourceAsStream ровно там, где ищет.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("lspatchNative"))
}

dependencies {
    // Весь конвейер патча: LSPatch + apkzlib + подпись + jcommander/gson —
    // всё уже внутри этого fat-jar из релиза JingMatrix/LSPatch (GPL-3).
    implementation(files("libs/lspatch.jar"))
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")
}

// Кладём свежесобранный APK модуля в assets под именем module.apk.
// Это запасной вариант; штатно установщик тянет последний релиз с GitHub.
val bundleModule by tasks.registering(Copy::class) {
    dependsOn(":app:assembleDebug")
    from(project(":app").layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(layout.buildDirectory.dir("bundledModule/module"))
    rename { "module.apk" }
}

// Вытаскиваем четыре liblspatch.so из fat-jar. Корень assets-папки уже
// маппится в zip-путь assets/, поэтому ведущий assets/ из записей jar снимаем —
// иначе получилось бы assets/assets/lspatch/so/…
val extractLspatchNative by tasks.registering(Copy::class) {
    from(zipTree("libs/lspatch.jar")) {
        // Только ARM: реальные телефоны — arm64 (и armeabi-v7a для 32-битных
        // приложений). x86/x86_64 нужны лишь эмуляторам, а это ~1 МБ лишнего
        // веса в скачивании установщика. Патчить на x86-устройстве всё равно
        // почти некому.
        include("assets/lspatch/so/arm64-v8a/**")
        include("assets/lspatch/so/armeabi-v7a/**")
    }
    eachFile { path = path.removePrefix("assets/") }
    includeEmptyDirs = false
    into(layout.buildDirectory.dir("lspatchNative"))
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(bundleModule, extractLspatchNative)
}
