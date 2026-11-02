# Desktop build, testing and signing

## Local development

Install the Rust stable toolchain and the platform prerequisites listed in the Tauri v2 prerequisites guide. From `src-tauri`, run:

```sh
cargo test
cargo check
```

Build the desktop app from the repository root after installing the Tauri CLI:

```sh
cargo install tauri-cli --version '^2'
cargo tauri build
```

SQLite lives in the operating system's application data directory. Do not place the database in the installation directory.

## CI coverage

The desktop workflow builds on Ubuntu, macOS and Windows and runs Rust tests. Browser smoke tests run on Chromium, Firefox and WebKit using Playwright. Hosted CI is not a substitute for manual verification on real Safari installations, supported Windows versions, or signed/notarized release artifacts.

## Signing secrets

Unsigned builds are produced when signing secrets are absent. To publish signed installers, configure the repository's protected release environment with the platform signing credentials:
- macOS: Apple Developer ID Application certificate and notarization credentials.
- Windows: Authenticode signing certificate or a trusted signing service.
- Linux: package signing key if distributing through a signed repository.

Never commit certificates, private keys, passwords, Apple API keys, or signing tokens. Configure the corresponding Tauri signing environment variables in the release environment before enabling release publication.

## Backup safety

Backups contain the complete SQLite database, including customer data and payment records. Store them securely. Restore validates SQLite integrity and schema version before replacing the active database. Keep an independent copy before restoring.
