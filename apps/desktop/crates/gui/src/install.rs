//! Native messaging host registration.
//!
//! Chrome finds a native messaging host by reading a manifest whose location
//! differs per platform, and whose contents differ in one field:
//!
//! | platform | manifest location                                                        | executable field |
//! | -------- | ------------------------------------------------------------------------ | ---------------- |
//! | Windows  | `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>` (registry)      | `path`           |
//! | macOS    | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<n>.json` | `path`        |
//! | Linux    | `~/.config/google-chrome/NativeMessagingHosts/<name>.json`                | `path`           |
//!
//! The registry key on Windows points at the manifest *file*, not the
//! executable — a detail that is easy to get wrong and produces a silent
//! "Specified native messaging host not found" in the browser.
//!
//! Registration is per-user (`HKCU`, `~/…`), so it never needs elevation.

use std::path::{Path, PathBuf};

use ltb_core::Result;

/// The host name the extension connects to. Must match
/// `NATIVE_HOST_NAME` in `apps/extension/src/background/transport.ts`.
pub const HOST_NAME: &str = "com.local_tool_bridge.host";

/// Where the manifest lives on this platform.
pub fn manifest_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // On Windows the manifest is a file whose location is arbitrary; the
        // registry key points at it. It is kept beside the other config.
        ltb_core::config_dir().map(|dir| dir.join(format!("{HOST_NAME}.json")))
    }

    #[cfg(target_os = "macos")]
    {
        directories::UserDirs::new().map(|dirs| {
            dirs.home_dir()
                .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json"))
        })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Chrome, Chromium, and most derivatives read the same path.
        directories::UserDirs::new().map(|dirs| {
            dirs.home_dir()
                .join(".config/google-chrome/NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json"))
        })
    }
}

/// The manifest contents.
///
/// `allowed_origins` is the security boundary: Chrome refuses to launch the host
/// for any extension not listed, which is why native messaging needs no shared
/// secret of its own.
pub fn manifest_json(executable: &Path, extension_id: &str) -> String {
    let origin = if extension_id.is_empty() {
        // An unset id would silently produce a manifest that permits nobody.
        "chrome-extension://REPLACE_WITH_YOUR_EXTENSION_ID/".to_string()
    } else {
        format!("chrome-extension://{extension_id}/")
    };

    serde_json::json!({
        "name": HOST_NAME,
        "description": "Local tool bridge for the AI web app",
        "path": executable.display().to_string(),
        "type": "stdio",
        "allowed_origins": [origin],
    })
    .to_string()
}

/// Whether a manifest is registered for this platform.
pub fn native_host_registered() -> bool {
    #[cfg(windows)]
    {
        windows_manifest_registered()
    }

    #[cfg(not(windows))]
    {
        manifest_path().map(|path| path.exists()).unwrap_or(false)
    }
}

/// Writes the manifest and registers it with the OS.
pub fn install(executable: &Path, extension_id: &str) -> Result<PathBuf> {
    let path = manifest_path().ok_or_else(|| {
        ltb_core::BridgeError::internal("No per-user config directory is available on this system")
    })?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ltb_core::BridgeError::from_io("Failed to create the manifest directory", error)
        })?;
    }

    std::fs::write(&path, manifest_json(executable, extension_id)).map_err(|error| {
        ltb_core::BridgeError::from_io("Failed to write the host manifest", error)
    })?;

    #[cfg(windows)]
    register_windows(&path)?;

    Ok(path)
}

/// Removes the registration.
pub fn uninstall() -> Result<()> {
    #[cfg(windows)]
    unregister_windows()?;

    if let Some(path) = manifest_path() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| {
                ltb_core::BridgeError::from_io("Failed to remove the host manifest", error)
            })?;
        }
    }
    Ok(())
}

// --- Windows registry ------------------------------------------------------

#[cfg(windows)]
const REGISTRY_KEY: &str =
    r"Software\Google\Chrome\NativeMessagingHosts\com.local_tool_bridge.host";

#[cfg(windows)]
fn register_windows(manifest: &Path) -> Result<()> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY_CURRENT_USER, REG_SZ,
    };

    // `RegCreateKeyW` is used rather than `RegCreateKeyExW`: the latter takes a
    // `SECURITY_ATTRIBUTES` pointer, which would pull in the whole
    // `Win32_Security` feature just to pass NULL. The handle it returns already
    // has full access, which is all that is needed here.
    let key: Vec<u16> = REGISTRY_KEY
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let value: Vec<u16> = manifest
        .display()
        .to_string()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut handle = std::mem::zeroed();

        let status = RegCreateKeyW(HKEY_CURRENT_USER, key.as_ptr(), &mut handle);
        if status != ERROR_SUCCESS {
            return Err(ltb_core::BridgeError::internal(format!(
                "RegCreateKey failed with status {status}; \
                 check that you can write to HKEY_CURRENT_USER"
            )));
        }

        // The default (unnamed) value holds the manifest path. Windows expects
        // UTF-16, hence the byte length being twice the code-unit count.
        let status = RegSetValueExW(
            handle,
            std::ptr::null(),
            0,
            REG_SZ,
            value.as_ptr() as *const u8,
            (value.len() * 2) as u32,
        );

        RegCloseKey(handle);

        if status != ERROR_SUCCESS {
            return Err(ltb_core::BridgeError::internal(format!(
                "RegSetValueEx failed with status {status}"
            )));
        }
    }

    Ok(())
}

#[cfg(windows)]
fn unregister_windows() -> Result<()> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};

    let key: Vec<u16> = REGISTRY_KEY
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let status = RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr());
        // Deleting a key that was never created is not a failure.
        if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
            return Err(ltb_core::BridgeError::internal(format!(
                "RegDeleteKey failed with status {status}"
            )));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_manifest_registered() -> bool {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ,
    };

    let key: Vec<u16> = REGISTRY_KEY
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut handle = std::mem::zeroed();
        if RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_READ, &mut handle) != ERROR_SUCCESS
        {
            return false;
        }

        // A key that exists but has no value is not a usable registration, so
        // the value's presence is queried rather than assumed.
        let mut size = 0u32;
        let status = RegQueryValueExW(
            handle,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        );
        RegCloseKey(handle);

        status == ERROR_SUCCESS && size > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_names_the_host_and_extension() {
        let json = manifest_json(Path::new("/opt/ltb-host"), "abcdefghijklmnop");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["name"], HOST_NAME);
        assert_eq!(parsed["type"], "stdio");
        assert_eq!(parsed["path"], "/opt/ltb-host");
        assert_eq!(
            parsed["allowed_origins"][0],
            "chrome-extension://abcdefghijklmnop/"
        );
    }

    #[test]
    fn an_empty_extension_id_does_not_grant_blanket_access() {
        // A manifest with no usable origin must not accidentally allow everyone.
        let json = manifest_json(Path::new("/opt/ltb-host"), "");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let origin = parsed["allowed_origins"][0].as_str().unwrap();
        assert!(origin.contains("REPLACE_WITH_YOUR_EXTENSION_ID"));
    }

    #[test]
    fn a_manifest_path_is_available() {
        // The config directory should exist on any supported desktop platform.
        assert!(manifest_path().is_some());
    }
}
