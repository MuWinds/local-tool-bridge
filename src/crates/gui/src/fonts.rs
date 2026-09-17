//! CJK font installation for the control panel.
//!
//! ## Why this is not optional
//!
//! `eframe`'s `default_fonts` feature bundles only Ubuntu-Light and
//! NotoEmoji-Regular. Neither contains a single CJK glyph, so every Chinese
//! character this UI draws comes out as a tofu box (`□`). Measured against the
//! live window: the tab labels, the policy grid, and the audit table were all
//! unreadable, while the ASCII token and the `127.0.0.1` addresses rendered fine
//! — which is exactly the signature of a missing-coverage font rather than a
//! broken widget.
//!
//! ## Why a system font rather than a bundled one
//!
//! Bundling a CJK font would add roughly 10–20 MB to the binary, which is a
//! steep price for a control panel. Every target platform already ships a
//! reasonable UI font, so the font is loaded from the system at startup and the
//! build stays small. When no candidate is found the app still runs — it simply
//! renders the way it did before, rather than failing to start.
//!
//! ## Where the CJK font goes in the fallback chain
//!
//! egui resolves glyphs by walking the font family's list **in order**, using the
//! first face that has the glyph. Latin text therefore keeps its original
//! Ubuntu-Light face (which is what the layout metrics were tuned against) and
//! only falls through to the CJK face for characters Ubuntu lacks. Appending
//! rather than replacing is what preserves the existing English rendering.

use std::path::PathBuf;

use eframe::egui::{FontData, FontDefinitions, FontFamily};

/// A system font to try, and the exact face name egui should file it under.
///
/// Ordered by preference: a UI sans face first, then a serif fallback that is
/// present on essentially every Windows install.
struct Candidate {
    /// Path to the font file.
    path: &'static str,
    /// The name the face is registered under in `FontDefinitions`.
    face: &'static str,
}

/// Font files to try, in order of preference, for the current platform.
#[cfg(target_os = "windows")]
const CANDIDATES: &[Candidate] = &[
    Candidate {
        path: "C:/Windows/Fonts/msyh.ttc",
        face: "MicrosoftYaHei",
    },
    Candidate {
        path: "C:/Windows/Fonts/msyh.ttf",
        face: "MicrosoftYaHei",
    },
    Candidate {
        path: "C:/Windows/Fonts/simhei.ttf",
        face: "SimHei",
    },
    Candidate {
        path: "C:/Windows/Fonts/simsun.ttc",
        face: "SimSun",
    },
    Candidate {
        path: "C:/Windows/Fonts/Deng.ttf",
        face: "DengXian",
    },
];

/// Font files to try on macOS.
#[cfg(target_os = "macos")]
const CANDIDATES: &[Candidate] = &[
    Candidate {
        path: "/System/Library/Fonts/PingFang.ttc",
        face: "PingFang",
    },
    Candidate {
        path: "/System/Library/Fonts/STHeiti Light.ttc",
        face: "STHeiti",
    },
    Candidate {
        path: "/Library/Fonts/Arial Unicode.ttf",
        face: "ArialUnicode",
    },
];

/// Font files to try on Linux and other Unixes.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const CANDIDATES: &[Candidate] = &[
    Candidate {
        path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        face: "NotoSansCJK",
    },
    Candidate {
        path: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        face: "NotoSansCJK",
    },
    Candidate {
        path: "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        face: "NotoSansCJK",
    },
    Candidate {
        path: "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        face: "WenQuanYiMicroHei",
    },
    Candidate {
        path: "/usr/share/fonts/truetype/arphic/uming.ttc",
        face: "ARPLUMing",
    },
];

/// Reads the first available candidate font, if any.
fn load_cjk_font() -> Option<(&'static str, Vec<u8>)> {
    for candidate in CANDIDATES {
        let path = PathBuf::from(candidate.path);
        if let Ok(bytes) = std::fs::read(&path) {
            // A zero-length or truncated read would register a font that renders
            // nothing, which is worse than falling through to the next candidate.
            if !bytes.is_empty() {
                return Some((candidate.face, bytes));
            }
        }
    }
    None
}

/// Installs a CJK-capable fallback font into `ctx`.
///
/// Safe to call once at startup. When no system font is found the context is
/// left untouched, so the app degrades to its previous appearance instead of
/// panicking.
pub fn install(ctx: &eframe::egui::Context) {
    let Some((face, bytes)) = load_cjk_font() else {
        tracing::warn!("no CJK font found on this system; Chinese text will render as empty boxes");
        return;
    };

    let mut fonts = FontDefinitions::default();

    fonts
        .font_data
        .insert(face.to_owned(), FontData::from_owned(bytes));

    // Appended, not prepended: see the module comment on fallback order.
    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .push(face.to_owned());
    }

    ctx.set_fonts(fonts);
    tracing::info!(font = face, "installed CJK fallback font");
}
