/**
 * cloudBackup.ts
 *
 * UX helpers for persisting and retrieving the user's encrypted backup blob.
 *
 * v1 strategy: local file download / upload. No platform-specific iCloud
 * or Google Drive APIs. Instead:
 *
 *   Download: we produce a JSON file via `<a download>` that the browser
 *   saves to the default downloads folder. On iOS, if the user taps "Save
 *   to Files" and picks "iCloud Drive", the file lands in iCloud Drive and
 *   syncs across their Apple devices automatically — the user does not need
 *   to do anything special beyond choosing the right folder in the Files app.
 *   On Android, saving to "Google Drive" from the share sheet achieves the
 *   same via Google's app folder sync.
 *
 *   Upload: a hidden `<input type="file">` picker. User selects the blob
 *   file from wherever they stored it (downloads, iCloud Drive via Files
 *   app, Google Drive, etc.). We parse and validate the JSON.
 *
 * v2 scope (not in this file):
 *   - Native iOS: iCloud ubiquity container via WKWebView / React Native
 *     file system bridge.
 *   - Native Android: Google Drive App Folder via the Drive REST API.
 *   - Optional server mirror: POST /api/wallet/blob (opt-in; server stores
 *     ciphertext only; never sees plaintext or password).
 *
 * No external dependencies needed.
 */

import { validateBackupBlobShape, type BackupBlob } from './backupBlob'

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Trigger a JSON file download of the encrypted backup blob.
 *
 * The user's browser shows a standard "Save As" dialog (or auto-saves to
 * the downloads folder depending on browser settings). On iOS Safari the
 * user can tap "Save to Files" to store it in iCloud Drive — the file
 * syncs to other signed-in Apple devices automatically via the Files app.
 *
 * @param blob      The encrypted BackupBlob to download.
 * @param filename  Optional filename. Defaults to `caw-backup-<address>.json`.
 */
export function downloadBackupBlob(blob: BackupBlob, filename?: string): void {
  const address = blob.pubkeyAddress.slice(0, 10) // short form for readability
  const defaultFilename = `caw-backup-${address}.json`
  const name = filename ?? defaultFilename

  const json = JSON.stringify(blob, null, 2)
  const bytes = new TextEncoder().encode(json)
  const blobObj = new Blob([bytes], { type: 'application/json' })
  const url = URL.createObjectURL(blobObj)

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()

  // Clean up the object URL and DOM element after a brief delay.
  setTimeout(() => {
    URL.revokeObjectURL(url)
    document.body.removeChild(anchor)
  }, 1000)
}

/**
 * Open a file picker and parse the selected file as a BackupBlob.
 *
 * Rejects if:
 *   - The user cancels the picker (resolves to `null` instead of rejecting)
 *   - The file is not valid JSON
 *   - The JSON does not match the BackupBlob shape (wrong version, missing fields)
 *
 * Returns `null` if the user cancelled without selecting a file.
 */
export function loadBackupBlobFromFile(): Promise<BackupBlob | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'

    // Track whether a file was selected. The `cancel` event is not
    // consistently fired across all browsers, so we use a focus listener
    // on the window as a fallback to detect when the picker closes without
    // a selection.
    let settled = false

    const settle = (value: BackupBlob | null | Error) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onWindowFocus)
      document.body.removeChild(input)
      if (value instanceof Error) reject(value)
      else resolve(value)
    }

    // Safari fires `focus` on the window when the file picker is dismissed.
    // We use a short timeout to let `change` fire first if a file was selected.
    const onWindowFocus = () => {
      setTimeout(() => settle(null), 300)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        settle(null)
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        const text = reader.result as string
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          settle(new Error(`The selected file is not valid JSON: ${file.name}`))
          return
        }

        if (!validateBackupBlobShape(parsed)) {
          settle(
            new Error(
              `The selected file does not look like a CAW backup blob. ` +
              `Make sure you selected the correct file (caw-backup-*.json).`,
            ),
          )
          return
        }

        settle(parsed)
      }
      reader.onerror = () => {
        settle(new Error(`Failed to read file: ${file.name}`))
      }
      reader.readAsText(file)
    })

    document.body.appendChild(input)
    window.addEventListener('focus', onWindowFocus, { once: true })
    input.click()
  })
}
