pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Xposed API живёт только здесь; из зависимостей он compileOnly,
        // в APK не попадает — реализацию подставляет LSPosed.
        maven("https://api.xposed.info/")
    }
}

rootProject.name = "vk7tv-module"
include(":app")
