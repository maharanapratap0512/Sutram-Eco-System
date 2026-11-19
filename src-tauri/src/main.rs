// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(not(debug_assertions))]
use tauri::{Manager, Url};

/// Strips the Windows verbatim/canonicalize prefix (`\\?\` or `\\?\UNC\`)
/// which causes Node.js, SQLite, and path resolution in child processes to fail.
fn clean_path(path: PathBuf) -> PathBuf {
    let p = path.canonicalize().unwrap_or(path);
    #[cfg(target_os = "windows")]
    {
        let s = p.to_string_lossy().to_string();
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", stripped));
        } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    p
}

/// Locates a writable path for `sutram-desktop.log` (next to .exe, cwd, or temp).
fn get_log_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("sutram-desktop.log");
            if std::fs::OpenOptions::new().create(true).append(true).open(&p).is_ok() {
                return clean_path(p);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("sutram-desktop.log");
        if std::fs::OpenOptions::new().create(true).append(true).open(&p).is_ok() {
            return clean_path(p);
        }
    }
    clean_path(std::env::temp_dir().join("sutram-desktop.log"))
}

/// Appends a timestamped line to `sutram-desktop.log`.
fn log_msg(msg: &str) {
    let log_path = get_log_path();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        use std::io::Write;
        let _ = writeln!(f, "[sutram-desktop] {}", msg);
    }
}

fn is_server_running() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:3300".parse().unwrap(),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".github"
            | "node_modules"
            | "dist"
            | "target"
            | "SutramData"
            | "SutramData_backup"
            | "temp"
            | "tmp"
    )
}

/// Checks a directory and its immediate subdirectories dynamically for `sutramServer/server.js`.
fn check_dir_for_server(dir: &Path) -> Option<PathBuf> {
    // 1. Direct inside this directory
    let direct = dir.join("sutramServer").join("server.js");
    if direct.exists() {
        return Some(clean_path(direct));
    }
    let direct_srv = dir.join("server").join("server.js");
    if direct_srv.exists() {
        return Some(clean_path(direct_srv));
    }

    // 2. Scan immediate subdirectories dynamically (handles any folder name: sutram, Sutram-Eco-System, app, etc.)
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    if should_skip_dir(file_name) {
                        continue;
                    }
                }
                let candidate = path.join("sutramServer").join("server.js");
                if candidate.exists() {
                    return Some(clean_path(candidate));
                }
                let candidate_srv = path.join("server").join("server.js");
                if candidate_srv.exists() {
                    return Some(clean_path(candidate_srv));
                }
            }
        }
    }

    None
}

/// Automatically detects `server.js` dynamically across exe location, cwd, and parents.
fn find_server_script() -> Option<PathBuf> {
    // 1. Check around the executable location
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if let Some(found) = check_dir_for_server(exe_dir) {
                return Some(found);
            }
            if let Some(parent) = exe_dir.parent() {
                if let Some(found) = check_dir_for_server(parent) {
                    return Some(found);
                }
                if let Some(grandparent) = parent.parent() {
                    if let Some(found) = check_dir_for_server(grandparent) {
                        return Some(found);
                    }
                }
            }
            // macOS .app Resources
            let res = exe_dir.join("../Resources");
            if let Some(found) = check_dir_for_server(&res) {
                return Some(found);
            }
            // macOS .app/Contents/MacOS/../../../
            let mac_root = exe_dir.join("../../..");
            if let Some(found) = check_dir_for_server(&mac_root) {
                return Some(found);
            }
        }
    }

    // 2. Check current working directory
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = check_dir_for_server(&cwd) {
            return Some(found);
        }
        if let Some(parent) = cwd.parent() {
            if let Some(found) = check_dir_for_server(parent) {
                return Some(found);
            }
        }
    }

    None
}

/// Automatically detects the Node.js binary, checking bundled runtime, C:\Program Files\nodejs\node.exe, and standard paths.
fn find_node_binary(server_dir: &Path, exe_dir: Option<&Path>) -> String {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Portable embedded runtime: <server_dir>/../runtime/node.exe
    if let Some(sutram_root) = server_dir.parent() {
        #[cfg(target_os = "windows")]
        candidates.push(sutram_root.join("runtime").join("node.exe"));
        #[cfg(not(target_os = "windows"))]
        candidates.push(sutram_root.join("runtime").join("node"));

        if let Some(parent) = sutram_root.parent() {
            #[cfg(target_os = "windows")]
            candidates.push(parent.join("runtime").join("node.exe"));
            #[cfg(not(target_os = "windows"))]
            candidates.push(parent.join("runtime").join("node"));
        }
    }

    // 2. Portable embedded runtime relative to .exe
    if let Some(dir) = exe_dir {
        #[cfg(target_os = "windows")]
        {
            candidates.push(dir.join("runtime").join("node.exe"));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("runtime").join("node.exe"));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(dir.join("runtime").join("node"));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("runtime").join("node"));
            }
        }
    }

    // 3. Standard Windows installation paths
    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"));

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local_app_data).join("Programs").join("node").join("node.exe"));
            candidates.push(PathBuf::from(&local_app_data).join("Programs").join("nodejs").join("node.exe"));
            candidates.push(PathBuf::from(&local_app_data).join("nodejs").join("node.exe"));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(&app_data).join("nvm").join("current").join("node.exe"));
            candidates.push(PathBuf::from(&app_data).join("npm").join("node.exe"));
        }
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(&user_profile).join(".nvm").join("current").join("bin").join("node.exe"));
        }
    }

    // 4. Standard macOS / Linux paths
    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/usr/bin/node"));
        candidates.push(PathBuf::from("/bin/node"));
    }

    for path in candidates {
        if path.exists() {
            return clean_path(path).to_string_lossy().to_string();
        }
    }

    "node".to_string()
}

fn start_backend_if_needed() -> Option<Child> {
    log_msg("=== Starting Sutram Desktop Launcher ===");

    if is_server_running() {
        log_msg("Port 3300 is already active. Reusing existing backend instance.");
        return None;
    }

    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));

    if let Some(script_path) = find_server_script() {
        let server_dir = script_path.parent().unwrap_or_else(|| Path::new("."));
        let node_bin = find_node_binary(server_dir, exe_dir.as_deref());

        log_msg(&format!("Found backend script: {}", script_path.display()));
        log_msg(&format!("Resolved node binary: {}", node_bin));
        log_msg(&format!("Working directory: {}", server_dir.display()));

        let mut cmd = Command::new(&node_bin);
        cmd.arg(&script_path)
            .current_dir(server_dir);

        let log_path = get_log_path();
        log_msg(&format!("Streaming backend output to: {}", log_path.display()));

        let stdout_f = std::fs::OpenOptions::new().create(true).append(true).open(&log_path);
        let stderr_f = std::fs::OpenOptions::new().create(true).append(true).open(&log_path);

        if let (Ok(out), Ok(err)) = (stdout_f, stderr_f) {
            cmd.stdout(Stdio::from(out));
            cmd.stderr(Stdio::from(err));
        } else {
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        match cmd.spawn() {
            Ok(mut proc) => {
                log_msg("Backend node process spawned successfully. Waiting up to 20 seconds for port 3300...");
                for i in 1..=100 {
                    if is_server_running() {
                        log_msg(&format!("Backend ready on port 3300 after ~{} ms!", i * 200));
                        return Some(proc);
                    }
                    if let Ok(Some(status)) = proc.try_wait() {
                        log_msg(&format!("ERROR: Backend node process exited prematurely with status: {}", status));
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                log_msg("WARNING: Port 3300 not yet open after 20s. Backend is still running; background navigator will monitor.");
                Some(proc)
            }
            Err(e) => {
                log_msg(&format!("ERROR: Failed to spawn node process: {}", e));
                None
            }
        }
    } else {
        log_msg("ERROR: Could not locate sutramServer/server.js in any candidate directory.");
        None
    }
}

fn main() {
    let backend_child = Mutex::new(start_backend_if_needed());

    let app = tauri::Builder::default()
        .setup(|_app| {
            // In release builds, continuously monitor for port 3300 in the background
            // and auto-navigate the webview window as soon as the backend is reachable!
            #[cfg(not(debug_assertions))]
            {
                let app_handle = _app.handle().clone();
                std::thread::spawn(move || {
                    log_msg("Background navigator thread active. Monitoring port 3300...");
                    for _ in 0..120 {
                        if is_server_running() {
                            log_msg("Port 3300 is active! Navigating main window to http://localhost:3300...");
                            if let Some(window) = app_handle.get_webview_window("main") {
                                if let Ok(url) = Url::parse("http://localhost:3300") {
                                    if let Err(err) = window.navigate(url) {
                                        log_msg(&format!("ERROR: Failed to navigate window: {}", err));
                                    } else {
                                        log_msg("SUCCESS: Main window navigated to http://localhost:3300.");
                                    }
                                }
                            }
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                    log_msg("TIMEOUT: Port 3300 did not become ready after 30 seconds.");
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Sutram desktop application");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            log_msg("Sutram Desktop application exiting. Stopping backend process...");
            if let Ok(mut guard) = backend_child.lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
