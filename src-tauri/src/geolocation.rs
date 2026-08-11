//! "Use current location" for the geo record editor on the write page — native OS location
//! instead of the browser's Geolocation API (whose permission popup can't be restyled and, on
//! WebView2, is really just a proxy for this same Windows API anyway).
//!
//! Only implemented for Windows for now; other platforms report it as unsupported rather than
//! guessing at CoreLocation/geoclue2 bindings without hardware to test against (same "fail
//! closed" stance as `friendly_name.rs`).

#[cfg(windows)]
pub fn current_location(app: &tauri::AppHandle) -> Result<(f64, f64), String> {
    windows_impl::current_location(app)
}

#[cfg(not(windows))]
pub fn current_location(_app: &tauri::AppHandle) -> Result<(f64, f64), String> {
    Err("Geolocation is only implemented on Windows in this build".to_string())
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::mpsc;
    use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator};

    /// `RequestAccessAsync` must be called from the UI thread or it throws (see Microsoft's
    /// docs on `Geolocator.RequestAccessAsync`) — Tauri commands run on a tokio worker thread,
    /// so the actual WinRT calls are marshaled onto the app's main thread via
    /// `run_on_main_thread` and the result is sent back over a channel. The calling command
    /// itself runs inside `spawn_blocking`, so blocking this thread on `recv()` doesn't stall
    /// the async runtime.
    pub fn current_location(app: &tauri::AppHandle) -> Result<(f64, f64), String> {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(request_location());
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|_| "Lost contact with the main thread".to_string())?
    }

    fn request_location() -> Result<(f64, f64), String> {
        let access = Geolocator::RequestAccessAsync()
            .and_then(|op| op.join())
            .map_err(|e| e.message().to_string())?;

        match access {
            GeolocationAccessStatus::Allowed => {}
            GeolocationAccessStatus::Denied => {
                return Err(
                    "Location access was denied — enable it under Windows Settings > Privacy & \
                     security > Location (and allow desktop apps to use it)."
                        .to_string(),
                )
            }
            _ => return Err("Location access is unavailable on this system.".to_string()),
        }

        let geolocator = Geolocator::new().map_err(|e| e.message().to_string())?;
        let position = geolocator
            .GetGeopositionAsync()
            .and_then(|op| op.join())
            .map_err(|e| e.message().to_string())?;
        let coordinate = position.Coordinate().map_err(|e| e.message().to_string())?;
        let point = coordinate.Point().map_err(|e| e.message().to_string())?;
        let basic = point.Position().map_err(|e| e.message().to_string())?;

        Ok((basic.Latitude, basic.Longitude))
    }
}
