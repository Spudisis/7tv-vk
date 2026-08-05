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
        versionCode = 18
        versionName = "0.4.2"
    }

    buildFeatures {
        buildConfig = true
    }

    // Два канала обновлений. Пробные сборки не должны доезжать до тех, у кого
    // стоит обычный установщик, поэтому у пробной — своё имя пакета (стоит
    // рядом, а не поверх), своя подпись в названии и свой набор тегов на
    // GitHub (см. Releases.ours).
    flavorDimensions += "channel"
    productFlavors {
        create("stable") {
            dimension = "channel"
            buildConfigField("boolean", "DEV_CHANNEL", "false")
            resValue("string", "app_name", "VK7TV")
        }
        create("dev") {
            dimension = "channel"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("boolean", "DEV_CHANNEL", "true")
            resValue("string", "app_name", "VK7TV dev")
        }
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
    // ВСЕ четыре ABI обязательны. LSPatch при патче добавляет liblspatch.so
    // под каждый ABI, который есть в оригинале ВК, читая его из наших ассетов
    // по assets/lspatch/so/<abi>/. У «универсальных» APK ВК (ими и патчат)
    // внутри есть lib/x86 и lib/x86_64 — без x86-библиотеки патч падает на
    // «Патчу приложение ВК…». Экономия ~1 МБ того не стоит.
    from(zipTree("libs/lspatch.jar")) {
        include("assets/lspatch/so/**")
    }
    // до этого каталог мог остаться с прошлой сборки — чистим, чтобы фильтр
    // «все ABI» не путался со старым усечённым набором
    doFirst { delete(layout.buildDirectory.dir("lspatchNative")) }
    eachFile { path = path.removePrefix("assets/") }
    includeEmptyDirs = false
    into(layout.buildDirectory.dir("lspatchNative"))
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(bundleModule, extractLspatchNative)
}
