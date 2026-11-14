plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.stefanmayer06.inkbridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.stefanmayer06.inkbridge"
        // Android 9: the oldest Boox pen tablets still in use run 10
        minSdk = 28
        targetSdk = 34
        versionCode = 9
        versionName = "0.9.0"
        ndk {
            // Boox tablets are ARM; the SDK's native pen reader comes for these
            abiFilters += setOf("armeabi-v7a", "arm64-v8a")
        }
    }

    signingConfigs {
        // releases: the key in the CI secrets, so updates install over the previous version
        create("release") {
            val path = System.getenv("BRIDGE_KEYSTORE")
            if (path != null && file(path).exists()) {
                storeFile = file(path)
                storePassword = System.getenv("BRIDGE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("BRIDGE_KEY_ALIAS")
                keyPassword = System.getenv("BRIDGE_KEY_PASSWORD")
            }
        }
        // without those secrets: a fixed test key (public, in the repository), so that every test
        // build still installs over the previous one instead of each CI run signing with a new key
        create("test") {
            storeFile = file("test-signing.jks")
            storePassword = "inkbridge-test"
            keyAlias = "inkbridge-test"
            keyPassword = "inkbridge-test"
        }
    }

    buildTypes {
        release {
            // the Onyx SDK reaches the firmware through reflection: keep everything
            isMinifyEnabled = false
            val release = signingConfigs.getByName("release")
            signingConfig = if (release.storeFile != null) release else signingConfigs.getByName("test")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            pickFirsts += "lib/*/libc++_shared.so"
            useLegacyPackaging = true
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Onyx's pen SDK (firmware pen drawing). 1.5.9 (November 2026): its pen reader no longer
    // knows only three digitizer names; with 1.4.11 the Note Air 6C reported the pen hovering
    // but never touching
    implementation("com.onyx.android.sdk:onyxsdk-pen:1.5.9")
    implementation("com.onyx.android.sdk:onyxsdk-device:1.3.7")
    // the SDK calls hidden Android APIs (EpdController)
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:4.3")
    // the control channel from Obsidian (ws://127.0.0.1)
    implementation("org.java-websocket:Java-WebSocket:1.5.7")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// The unit test classpath, for running the Bridge without Android in the end-to-end test (dev/fastink-e2e.cjs)
afterEvaluate {
    tasks.register("writeTestClasspath") {
        val test = tasks.named<Test>("testDebugUnitTest")
        dependsOn("compileDebugUnitTestKotlin")
        val out = layout.buildDirectory.file("test-classpath.txt")
        doLast { out.get().asFile.writeText(test.get().classpath.asPath) }
    }
}
