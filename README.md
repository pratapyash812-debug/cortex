# Cortex for Apple Silicon

This repository builds the complete Cortex notes app for Apple M-series Macs.
The app embeds Python and uses macOS Cocoa/WebKit. Your friend does not need
Python, Node, Ollama, an AI model, or an account to use the finished app.

The starting payload is the verified Cortex 1.2.2 release. It includes the editor,
notebooks and contents, equations, graphs, tables, sketches, imports, PDF search,
verified local backups and existing optional folder sync. It includes no personal
notes, course materials, recovery drafts, settings, credentials or Windows runtime.

## Build on GitHub

Push this repository to `main`. The **Build Cortex for Apple Silicon** workflow
uses GitHub's standard `macos-15` arm64 runner and CPython 3.13. It checks the
payload, tests/rebuilds the frontend, builds `Cortex.app`, tests the actual bundled
PDF worker, opens a disposable Cocoa/WebKit window, and verifies a read-only DMG.

Download the **Cortex-macOS-AppleSilicon** artifact from the successful Actions run.
It contains the `.dmg`, SHA-256 checksum and test/build receipts. A failed test
does not produce a claimed completed release.

The default CI artifact is explicitly named **UNNOTARIZED**. It is a local/private
test build; macOS may block an unnotarized downloaded app. A normal trusted build
for sharing needs an Apple Developer ID certificate and notarization. No workflow
disables Gatekeeper or changes a user's security settings.

## Build locally on a Mac

Use native Apple Silicon CPython 3.13 and existing Xcode command-line tools.
The builder checks prerequisites; it does not install Homebrew, Python, Node or
system software. Python build dependencies go into an isolated output-folder venv.

```sh
python3 build_macos.py --output output/local
```

The prebuilt web interface is included, so a local build does not require Node.
For a Developer ID-signed and notarized build, use an installed certificate and a
previously configured `notarytool` keychain profile:

```sh
python3 build_macos.py --output output/release \
  --developer-id 'Developer ID Application: YOUR NAME (TEAMID)' \
  --notary-profile 'YOUR_EXISTING_KEYCHAIN_PROFILE'
```

These explicit flags authorize uploading the built app/DMG to Apple's notary
service. Credentials are read from the existing keychain and are never stored in
the repository. Do not put certificates, passwords or API keys in this repository.

## Installation and notes

Open the finished DMG, drag **Cortex.app** to **Applications**, eject the image,
and launch Cortex. New notes are stored in `~/Documents/Cortex`; local automatic
backups and PDF indexes use `~/Library/Application Support/Cortex`. The app starts
with an empty notebook. Existing user data is never bundled in the DMG.

The target architecture is **arm64**, with macOS 13 declared as the minimum.
The CI smoke test runs on macOS 15; compatibility with every older Mac release
requires a separate real-device check. Keep a backup on another drive or your own
cloud storage to protect against device loss.

## Important packaging details

- The bundled server resolves its web assets through PyInstaller's resource root.
- The frozen app dispatches `--cortex-pdf-worker` before importing the GUI, so PDF
  indexing does not accidentally launch another app window or assume a separate
  Python executable exists.
- The DMG contains a self-contained application and an Applications shortcut.
- The builder verifies the app's code-signature integrity, architecture, backend,
  Cocoa UI and read-only disk image before writing its build receipt.
- Third-party frontend notices are retained in `THIRD-PARTY-NOTICES`; Python
  package versions are recorded in the output build receipt directory.

The current preparation was performed on Windows. The first successful macOS CI
run is required before claiming that a finished DMG has been produced or tested.
