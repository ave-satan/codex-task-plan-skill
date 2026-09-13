#!/bin/sh
set -eu
cd -P "$(dirname "$0")"
mkdir -p 'build/Task Plan Companion.app/Contents/MacOS' 'build/Task Plan Companion.app/Contents/Resources' build/module-cache
swiftc -swift-version 5 -module-cache-path build/module-cache main.swift -o 'build/Task Plan Companion.app/Contents/MacOS/TaskPlanCompanion' -framework AppKit -framework SwiftUI
cp Info.plist 'build/Task Plan Companion.app/Contents/Info.plist'
rm -rf 'build/Task Plan Companion.app/Contents/Resources/agent-icons'
cp -R ../assets/agent-icons 'build/Task Plan Companion.app/Contents/Resources/agent-icons'
codesign --force --sign - 'build/Task Plan Companion.app'
