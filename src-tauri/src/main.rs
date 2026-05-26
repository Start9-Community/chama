#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct BridgeSidecar(Mutex<Option<CommandChild>>);

impl BridgeSidecar {
    fn kill(&self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

impl Drop for BridgeSidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

fn stop_bridge_sidecar<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(sidecar) = app.try_state::<BridgeSidecar>() {
        sidecar.kill();
    }
}

fn start_bridge_sidecar(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?.join("fedimint-bridge");
    std::fs::create_dir_all(&data_dir)?;

    let data_dir_arg = data_dir.to_string_lossy().to_string();
    let (mut rx, child) = app
        .shell()
        .sidecar("chama-fedimint-bridge")?
        .args([
            "--data-dir",
            data_dir_arg.as_str(),
            "serve",
            "--bind",
            "127.0.0.1:8787",
        ])
        .spawn()?;

    app.manage(BridgeSidecar(Mutex::new(Some(child))));

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprint!("[chama-fedimint-bridge] {line}");
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprint!("[chama-fedimint-bridge] {line}");
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[chama-fedimint-bridge] terminated: {status:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            start_bridge_sidecar(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Chama Tauri app");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_bridge_sidecar(app_handle);
        }
        _ => {}
    });
}
