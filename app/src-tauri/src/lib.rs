/// Tauri 2 library entry. Kept thin on purpose — all business logic
/// (extraction, pricing, persistence) lives in the Node server, all
/// UI in the WebView. The Rust side just owns the window and a few
/// plugins:
///   * `dialog`   — native file picker (open + save).
///   * `fs`       — write the chosen export path. Paired with the
///                  dialog `save()` flow: the dialog hands back a
///                  user-confirmed path, fs writes the generated
///                  PDF / DOCX / XLSX bytes there. The capability
///                  scope is wide-open so any path the user explicitly
///                  picks works — narrowing it would reject Documents,
///                  Desktop, USB drives, etc.
///   * `opener`   — "show in Explorer" actions.
///   * `updater`  — checks a GitHub Releases-hosted `latest.json`
///                  endpoint, downloads the next signed installer,
///                  verifies it against the embedded minisign public
///                  key, and applies it on relaunch. Configured via
///                  `tauri.conf.json → plugins.updater`.
///   * `process`  — exposes `relaunch()` to JS so the update flow can
///                  restart the app after `update.install()`.
///
/// The persistent pair queue used to live in a Tauri-side SQLite DB
/// (via `tauri-plugin-sql`). It now lives in `server/centralizator.db`
/// behind the `/api/pairs` REST surface, so this Rust shell no longer
/// links sqlx / libsqlite and the WebView no longer needs a SQL IPC
/// bridge.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running Centralizator");
}
