# Cortex

A simple local notes app: write, add maths or a graph, and keep the work organised.

- New note opens a focused editor and saves automatically.
- A visible notebook shelf keeps every subject accessible, with note counts and global search. Notebooks open as numbered contents pages with sections and notes. Create an empty notebook or start writing immediately; original overview text remains available. Subject outlines, breadcrumbs and compact page controls keep navigation simple.
- Alt+= opens a visual equation editor.
- Insert offers clearly bordered tables, graphs/charts, inline sketches, pictures and attachments, with dark and light appearances.
- One folder/file import creates readable notes and keeps exact original files.
- Search notes and selectable PDF text, with matching-page navigation in a one-page PDF reader.
- Pinning, export, history, recently deleted notes, recovery drafts and automatic verified notebook ZIP backups.

No AI, study dashboard, reminder service, command palette or template chooser is part of the active app. Notes and subnotes are ordinary Markdown files. Ink and grouping live in `.cortex`; keep that directory with the notes. Configured folder sync remains available in Settings.

Read [Using Cortex](docs/lean-notes.md).

## Develop and verify

Use an existing Python environment with PyYAML and pypdf (the pinned release uses pypdf 6.10.0). Native mode also needs pywebview; configured encrypted sync uses cryptography and keyring. The runtime does not need NumPy, Ollama or Graphifyy.

```powershell
server\.venv\Scripts\python -m unittest discover -s server\tests
cd web
npm ci
npm run test:unit
npm run lint
npm run build
```

Run `server/server.py --vault <folder> --port 8787` or `server/desktop.py --vault <folder>`. Some development-only historical tests still exercise old source libraries; those libraries are not packaged.

## Release

Build and verify first. `packaging/stage_release.py --runtime <existing signed Python folder> --destination <new output folder>` makes a matched release from an explicit dependency set without downloads. `packaging/deploy_release.py --source <verified release> --destination <user Programs/Cortex>` verifies it, preserves signed executable bytes, backs up the prior release and rolls back a failed replacement. Close Cortex before installing. Deployment never edits notebooks or forcibly terminates an app.

## Repository layout and personal data

`server/` holds the full backend development source and tests. `web/` holds the frontend source and tests. `packaging/` contains Windows release tools and the shared list of 35 packaged runtime modules; historical compatibility libraries remain in development source but are not activated or bundled. The root Mac build tools use that same runtime list. `app/web/dist/` retains only the prebuilt application interface for Mac builds without Node.

Keep your notebook folder outside this repository. Personal notes, source documents, `.cortex` metadata, settings, recovery drafts, backups and local runtimes are not included. `.gitignore` excludes common personal-data paths and document formats.

## Apple Silicon Mac builds

This repository builds the complete Cortex notes app for Apple M-series Macs.
The app embeds Python and uses macOS Cocoa/WebKit. Your friend does not need
Python, Node, Ollama, an AI model, or an account to use the finished app.

The current source and prebuilt interface are Cortex 1.2.3. It includes the editor,
notebooks and contents, equations, graphs, tables, sketches, imports, PDF search,
verified local backups and existing optional folder sync. It includes no personal
notes, course materials, recovery drafts, settings, credentials or Windows runtime.

## Build on GitHub

Push this repository to `main` or `codex/macos-arm64`. The **Build Cortex for Apple Silicon** workflow
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

Each release must pass the native macOS CI checks before its DMG is shared.
