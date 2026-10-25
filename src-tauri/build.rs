fn main() {
    // embed the windows manifest through the linker instead of tauri's resource, so `cargo test`
    // binaries get it too (otherwise they crash with STATUS_ENTRYPOINT_NOT_FOUND)
    let mut windows = tauri_build::WindowsAttributes::new();
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("failed to run tauri-build");
}
