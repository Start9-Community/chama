#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct BridgeSidecar(Mutex<Option<CommandChild>>);

#[derive(Clone, Debug)]
struct BridgeRuntime {
    bind: SocketAddr,
    bridge_url: String,
    instance_id: Option<String>,
    data_dir_override: Option<PathBuf>,
}

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

fn default_bridge_addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 8787))
}

fn loopback_addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

fn port_is_available(addr: SocketAddr) -> bool {
    TcpListener::bind(addr).is_ok()
}

fn ephemeral_loopback_addr() -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let addr = listener.local_addr()?;
    drop(listener);
    Ok(addr)
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn sanitize_instance_id(raw: &str) -> String {
    let sanitized = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if sanitized.is_empty() {
        "instance".to_owned()
    } else {
        sanitized
    }
}

fn choose_bridge_runtime() -> Result<BridgeRuntime, Box<dyn std::error::Error>> {
    let instance_id = optional_env("CHAMA_TAURI_INSTANCE_ID");
    let forced_port = optional_env("CHAMA_TAURI_BRIDGE_PORT")
        .map(|value| {
            value
                .parse::<u16>()
                .map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!("invalid CHAMA_TAURI_BRIDGE_PORT: {value}"),
                    )
                })
        })
        .transpose()?;

    let bind = if let Some(port) = forced_port {
        loopback_addr(port)
    } else {
        let default = default_bridge_addr();
        if port_is_available(default) {
            default
        } else {
            ephemeral_loopback_addr()?
        }
    };

    Ok(BridgeRuntime {
        bind,
        bridge_url: format!("http://{bind}"),
        instance_id,
        data_dir_override: optional_env("CHAMA_TAURI_BRIDGE_DATA_DIR").map(PathBuf::from),
    })
}

fn bridge_data_dir(
    app: &tauri::App,
    runtime: &BridgeRuntime,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(override_dir) = &runtime.data_dir_override {
        return if override_dir.is_absolute() {
            Ok(override_dir.clone())
        } else {
            Ok(app.path().app_data_dir()?.join(override_dir))
        };
    }

    let base = app.path().app_data_dir()?;
    if let Some(instance_id) = &runtime.instance_id {
        return Ok(base.join(format!(
            "fedimint-bridge-{}",
            sanitize_instance_id(instance_id)
        )));
    }

    if runtime.bind == default_bridge_addr() {
        Ok(base.join("fedimint-bridge"))
    } else {
        Ok(base.join(format!("fedimint-bridge-{}", runtime.bind.port())))
    }
}

fn js_string(value: &str) -> String {
    format!("{value:?}")
}

fn bridge_init_script(runtime: &BridgeRuntime) -> String {
    let bridge_url = js_string(&runtime.bridge_url);
    let instance_id = runtime
        .instance_id
        .as_deref()
        .map(js_string)
        .unwrap_or_else(|| "null".to_owned());

    format!(
        r#"
;window.__CHAMA_NATIVE_FEDIMINT__ = Object.freeze({{
  bridgeUrl: {bridge_url},
  instanceId: {instance_id}
}});
"#,
    )
}

fn start_bridge_sidecar(
    app: &mut tauri::App,
    runtime: &BridgeRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = bridge_data_dir(app, runtime)?;
    std::fs::create_dir_all(&data_dir)?;

    let data_dir_arg = data_dir.to_string_lossy().to_string();
    let bind_arg = runtime.bind.to_string();
    eprintln!(
        "[chama-tauri] starting Fedimint bridge at {} using {}",
        runtime.bridge_url,
        data_dir.display(),
    );

    let (mut rx, child) = app
        .shell()
        .sidecar("chama-fedimint-bridge")?
        .args([
            "--data-dir",
            data_dir_arg.as_str(),
            "serve",
            "--bind",
            bind_arg.as_str(),
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
    let bridge_runtime = choose_bridge_runtime().expect("failed to configure Chama bridge runtime");
    let init_script = bridge_init_script(&bridge_runtime);

    let app = tauri::Builder::default()
        .append_invoke_initialization_script(init_script)
        .plugin(tauri_plugin_shell::init())
        // HTTP plugin: lets the WebView's market-data fetches (BTC price, FX
        // rates) run from Rust (reqwest) instead of the WebView, which blocks
        // cross-origin requests from the custom tauri:// origin. See
        // DECISIONS.md 2026-06-06. Scope is locked to the price/FX hosts in
        // capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        .setup(move |app| {
            start_bridge_sidecar(app, &bridge_runtime)?;
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
