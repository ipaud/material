# Updates

MATERIAL can update itself on macOS (Apple Silicon). It does not use Squirrel or `electron-updater`: those need the
app to be signed with an Apple Developer ID, and MATERIAL is not. This is a small updater of its own
(`electron/main/updater.ts`, with the testable parts in `shared/update.ts` and `electron/main/updateDownload.ts`).

## What the user sees

- **MATERIAL → Check for Updates…** asks now and always answers ("up to date", an error, or an offer).
- **MATERIAL → Check for Updates Automatically** (on by default) controls the quiet check 8 seconds after launch, at
  most once every 24 hours. Turning it off means MATERIAL never contacts GitHub by itself.
- When a newer release exists: **Update now / Later / Release notes**. Update now downloads it (Dock icon progress),
  verifies it, then asks **Restart now / On next quit**. On next quit installs silently when the app closes.
- If the app cannot replace itself (it runs from a read-only copy, or from a folder the user cannot write to), it
  says so and opens the download page. Moving `MATERIAL.app` to Applications fixes the usual cause.
- Nothing runs in CLI (headless) mode, in development builds, or on Intel Macs.

## What it checks

See [SECURITY → Updates](SECURITY.md#updates). In short: only this repository, size + SHA-256, the right bundle id and
version, a valid bundle signature, and the old app stays untouched until all of that passes.

## Publishing a release the updater can use

1. Bump `version` in `package.json`, add the notes to `docs/RELEASE_NOTES.md`.
2. `npm run package`, then zip the bundle so the folder inside is `MATERIAL.app`:

   ```bash
   ditto -c -k --keepParent release/mac-arm64/MATERIAL.app MATERIAL-X.Y.Z-arm64.zip
   shasum -a 256 MATERIAL-X.Y.Z-arm64.zip
   ```

3. Create a GitHub release tagged `vX.Y.Z` with that zip attached. **The zip must be named exactly
   `MATERIAL-X.Y.Z-arm64.zip`**, and the release text must contain a line `SHA-256: <hash>` unless GitHub shows a
   digest for the asset. A release without either is ignored by the updater.
4. Do not publish it as a pre-release or leave it as a draft: those are never offered.

## Testing it without a real release

Point the app at a local server that returns the same JSON as GitHub's "latest release":

```bash
MATERIAL_UPDATE_FEED=http://127.0.0.1:8000/latest.json open -n release/mac-arm64/MATERIAL.app
```

The `browser_download_url` of the asset has to start with that server's origin. A development build (`npm run dev`)
checks and downloads but refuses to install, so it can never overwrite Electron's own bundle.

## Known limits

- The first MATERIAL a person installs has to be downloaded by hand; only versions from 0.8.5 on update themselves (macOS).
- On Windows the app only tells you a newer release exists and opens its page: installing by itself needs code signing.
- The checksum and the download come from the same GitHub account (see SECURITY).
- Intel Macs and Windows are not supported by the updater, because the app itself is not built for them.
