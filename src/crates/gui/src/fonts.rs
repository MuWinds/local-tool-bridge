use eframe::egui::{FontData, FontDefinitions, FontFamily};

/// Noto Sans CJK SC is bundled with the application so CJK rendering does not
/// depend on the host OS, Linux distribution, or installed system fonts.
///
/// The font is distributed under the SIL Open Font License 1.1; see
/// `assets/fonts/NOTICE.txt` for attribution and the upstream source.
const CJK_FONT: &[u8] = include_bytes!("../../../../assets/fonts/NotoSansCJKsc-Regular.otf");
const CJK_FACE: &str = "NotoSansCJKsc";

/// Installs the bundled Simplified Chinese-capable CJK fallback font into egui.
///
/// The font is appended to both proportional and monospace families so Latin
/// text keeps egui's normal metrics while Chinese characters fall through to
/// Noto Sans CJK SC. Keeping the bytes embedded also makes Linux packages
/// self-contained and deterministic across distributions.
pub fn install(ctx: &eframe::egui::Context) {
    let mut fonts = FontDefinitions::default();
    fonts
        .font_data
        .insert(CJK_FACE.to_owned(), FontData::from_static(CJK_FONT));

    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .push(CJK_FACE.to_owned());
    }

    ctx.set_fonts(fonts);
    tracing::info!(font = CJK_FACE, "installed bundled CJK font");
}

#[cfg(test)]
mod tests {
    use super::*;
    use eframe::egui::epaint::Fonts;
    use eframe::egui::epaint::text::LayoutJob;
    use eframe::egui::{Color32, FontId};

    /// Guards against a truncated or otherwise unparsable bundled font.
    ///
    /// A damaged font file still compiles, because `include_bytes!` embeds
    /// whatever happens to be on disk. The failure is silent rather than loud:
    /// truncation leaves `cmap` intact, so the font still claims the CJK
    /// codepoints, while `hmtx` and the outline table are unreadable. Every
    /// glyph is then laid out with zero advance and the UI draws nothing at
    /// all, instead of falling back to the tofu boxes a missing font produces.
    #[test]
    fn bundled_font_renders_cjk() {
        let mut fonts = FontDefinitions::default();
        fonts
            .font_data
            .insert(CJK_FACE.to_owned(), FontData::from_static(CJK_FONT));

        // Replace the default faces rather than appending, so the measured width
        // can only come from the bundled font; otherwise egui's own faces would
        // still contribute their (tofu) advances and mask a broken file.
        for family in [FontFamily::Proportional, FontFamily::Monospace] {
            fonts.families.insert(family, vec![CJK_FACE.to_owned()]);
        }

        let fonts = Fonts::new(1.0, 8192, fonts);
        let job = LayoutJob::simple_singleline(
            "本地工具桥接".to_owned(),
            FontId::proportional(20.0),
            Color32::WHITE,
        );
        let width: f32 = fonts
            .layout_job(job)
            .rows
            .iter()
            .map(|row| row.rect.width())
            .sum();

        assert!(
            width > 0.0,
            "the bundled CJK font laid out zero-width glyphs; \
             assets/fonts/NotoSansCJKsc-Regular.otf is probably truncated"
        );
    }
}
