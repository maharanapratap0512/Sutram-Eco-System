// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(not(debug_assertions))]
use tauri::{Manager, Url};

fn is_server_running() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:3300".parse().unwrap(),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn find_server_script() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("sutram").join("sutramServer").join("server.js"));
        candidates.push(cwd.join("Sutram-Eco-System").join("sutramServer").join("server.js"));
        candidates.push(cwd.join("app").join("sutramServer").join("server.js"));
        candidates.push(cwd.join("sutramServer").join("server.js"));
        candidates.push(cwd.join("server").join("server.js"));
        candidates.push(cwd.join("..").join("sutramServer").join("server.js"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Portable root layout: SutramPortable/Sutram.exe beside SutramPortable/sutram/
            candidates.push(exe_dir.join("sutram").join("sutramServer").join("server.js"));
            candidates.push(exe_dir.join("Sutram-Eco-System").join("sutramServer").join("server.js"));
            candidates.push(exe_dir.join("app").join("sutramServer").join("server.js"));
            // Portable inside sutram/: Sutram.exe next to sutramServer/
            candidates.push(exe_dir.join("sutramServer").join("server.js"));
            candidates.push(exe_dir.join("server").join("server.js"));
            // macOS .app/Contents/Resources
            candidates.push(exe_dir.join("../Resources/sutramServer/server.js"));
            // macOS .app placed OUTSIDE sutram/: SutramPortable/Sutram.app beside sutram/
            candidates.push(exe_dir.join("../../../sutram/sutramServer/server.js"));
            candidates.push(exe_dir.join("../../../Sutram-Eco-System/sutramServer/server.js"));
            candidates.push(exe_dir.join("../../../app/sutramServer/server.js"));
            // macOS .app placed INSIDE sutram/ or dev binary inside src-tauri/target/debug/
            candidates.push(exe_dir.join("../../../sutramServer/server.js"));
            candidates.push(exe_dir.join("../../sutramServer/server.js"));
            // Release .app inside src-tauri/target/release/bundle/macos/Sutram.app/Contents/MacOS/
            candidates.push(exe_dir.join("../../../../../../sutramServer/server.js"));
            candidates.push(exe_dir.join("../../../../../../../sutramServer/server.js"));
        }
    }

    for path in candidates {
        if path.exists() {
            return path.canonicalize().ok().or(Some(path));
        }
    }
    None
}

fn find_node_binary(server_dir: &Path) -> String {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(sutram_root) = server_dir.parent() {
        #[cfg(target_os = "windows")]
        {
            candidates.push(sutram_root.join("runtime").join("node.exe"));
            if let Some(portable_root) = sutram_root.parent() {
                candidates.push(portable_root.join("runtime").join("node.exe"));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(sutram_root.join("runtime").join("node"));
            if let Some(portable_root) = sutram_root.parent() {
                candidates.push(portable_root.join("runtime").join("node"));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/usr/bin/node"));
    }

    for path in candidates {
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }

    "node".to_string()
}

fn start_backend_if_needed() -> Option<Child> {
    if is_server_running() {
        return None;
    }

    if let Some(script_path) = find_server_script() {
        let server_dir = script_path.parent().unwrap_or_else(|| Path::new("."));
        let node_bin = find_node_binary(server_dir);

        let mut cmd = Command::new(&node_bin);
        cmd.arg(&script_path)
            .current_dir(server_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let child = cmd.spawn();

        if let Ok(proc) = child {
            // Wait briefly for server to bind port 3300
            for _ in 0..15 {
                if is_server_running() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            return Some(proc);
        }
    }

    None
}

fn main() {
    let backend_child = Mutex::new(start_backend_if_needed());

    let app = tauri::Builder::default()
        .setup(|_app| {
            // In release builds, load live UI served from local sutramServer (http://localhost:3300)
            // so applying an update.zip to sutram/dist/ updates the app immediately without rebuilding the .exe/.app!
            #[cfg(not(debug_assertions))]
            {
                if is_server_running() {
                    if let Some(window) = _app.get_webview_window("main") {
                        if let Ok(url) = Url::parse("http://localhost:3300") {
                            let _ = window.navigate(url);
                        }
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Sutram desktop application");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut guard) = backend_child.lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
