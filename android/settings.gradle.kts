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
        // Onyx's public SDK repository (the pen SDK used by Boox apps)
        maven {
            name = "BooxPublic"
            url = uri("https://repo.boox.com/repository/maven-public/")
        }
    }
}

rootProject.name = "InkNotebookBridge"
include(":app")
