//! Frontière GPUI des tokens : `WaifuTheme` devient un global, `Palette` en donne les couleurs aux vues en `Hsla`,
//! et `install` copie les mêmes tokens dans `gpui_component::Theme` pour que `Input`, `Textarea` et `Button` les lisent.

use gpui_kit::component::{Theme, ThemeMode as KitMode};
use gpui_kit::*;

use crate::theme::{Accent, AccentChoice, Rgba, ThemeMode, WaifuTheme};

impl Global for WaifuTheme {}

impl Rgba {
    /// Couleur GPUI équivalente (alpha conservé).
    pub fn hsla(self) -> Hsla {
        gpui_kit::rgba(u32::from_be_bytes([self.0, self.1, self.2, self.3])).into()
    }
}

/// Couleurs que lisent les vues de WaifuChat, dérivées du `WaifuTheme` courant.
#[derive(Clone, Copy)]
pub struct Palette {
    pub background: Hsla,
    pub panel: Hsla,
    pub hover: Hsla,
    pub selected: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    pub text_secondary: Hsla,
    pub accent: Hsla,
    pub error: Hsla,
    /// Fond des champs de saisie (`bg-bg-tertiary`) : posé explicitement, le kit ne rend que 30 % de `input`.
    pub field: Hsla,
    pub scrim: Hsla,
    /// Pastille de présence : en ligne (succès), absent (avertissement), hors ligne (texte secondaire).
    pub presence_online: Hsla,
    pub presence_away: Hsla,
    pub presence_offline: Hsla,
    /// Couleurs des disques d'initiales (repli sans photo), toutes tirées du thème ; choisies par `grouping::avatar_slot`.
    pub avatar_fallbacks: [Hsla; 6],
}

impl Palette {
    /// Sans `install` (tests de vues, harnais), le thème sombre par défaut s'applique.
    pub fn of(cx: &App) -> Self {
        match cx.try_global::<WaifuTheme>() {
            Some(theme) => Self::from_theme(theme),
            None => Self::from_theme(&WaifuTheme::new(ThemeMode::Dark, &AccentChoice::Solid(Accent::DEFAULT_BASE))),
        }
    }

    pub fn from_theme(t: &WaifuTheme) -> Self {
        let s = &t.surfaces;
        Self {
            background: s.bg_primary.hsla(),
            panel: s.bg_secondary.hsla(),
            hover: s.bg_hover.hsla(),
            selected: s.bg_active.hsla(),
            border: s.border.hsla(),
            text: s.text_primary.hsla(),
            text_secondary: s.text_secondary.hsla(),
            accent: t.accent.base.hsla(),
            error: t.status.danger.hsla(),
            field: s.bg_tertiary.hsla(),
            avatar_fallbacks: [
                t.accent.base.hsla(),
                t.status.success.hsla(),
                t.status.info.hsla(),
                t.status.warning.hsla(),
                t.status.danger.hsla(),
                t.accent.link.hsla(),
            ],
            presence_online: t.status.success.hsla(),
            presence_away: t.status.warning.hsla(),
            presence_offline: s.text_secondary.hsla(),
            scrim: Rgba::hex_a(0x000000b0).hsla(),
        }
    }
}

fn kit_mode(mode: ThemeMode) -> KitMode {
    match mode {
        ThemeMode::Light => KitMode::Light,
        ThemeMode::Dark | ThemeMode::Oled => KitMode::Dark,
    }
}

/// À appeler **une fois** avant l'ouverture de fenêtre : pose le global `WaifuTheme`, passe le kit en sombre
/// puis copie les tokens dans ses couleurs (correspondance de `UI-MAPPING.md` §3.3).
pub fn install(mode: ThemeMode, accent: &AccentChoice, cx: &mut App) {
    let waifu = WaifuTheme::new(mode, accent);
    Theme::change(kit_mode(mode), None, cx);
    Theme::update(cx, |theme| apply(&waifu, &mut theme.colors));
    cx.set_global(waifu);
}

/// Champs de `ThemeColor` renseignés par [`apply`] (consignés dans le rapport).
pub fn apply(w: &WaifuTheme, c: &mut gpui_kit::component::ThemeColor) {
    let s = &w.surfaces;
    let (bg1, bg2, bg3) = (s.bg_primary.hsla(), s.bg_secondary.hsla(), s.bg_tertiary.hsla());
    let (hover, active) = (s.bg_hover.hsla(), s.bg_active.hsla());
    let (text, text2, border) = (s.text_primary.hsla(), s.text_secondary.hsla(), s.border.hsla());
    let base = w.accent.base.hsla();
    let accent_hover = w.accent.hover.hsla();

    c.background = bg1;
    c.foreground = text;
    c.border = border;
    c.input = bg3;
    c.muted = bg3;
    c.secondary = bg3;
    c.secondary_hover = hover;
    c.secondary_active = active;
    c.secondary_foreground = text;
    c.muted_foreground = text2;
    c.accent = hover;
    c.accent_foreground = text;
    c.list = bg1;
    c.list_hover = hover;
    c.list_active = active;
    c.primary = base;
    c.primary_hover = accent_hover;
    c.primary_active = base;
    c.primary_foreground = gpui_kit::white();
    c.ring = base;
    c.caret = base;
    c.link = w.accent.link.hsla();
    c.link_hover = w.accent.link_hover.hsla();
    c.selection = w.accent.dim.hsla();
    c.popover = bg2;
    c.popover_foreground = text;
    c.sidebar = bg2;
    c.sidebar_foreground = text;
    c.sidebar_border = border;
    c.title_bar = bg1;
    c.title_bar_border = border;
    c.scrollbar = s.scrollbar_track.hsla();
    c.scrollbar_thumb = s.scrollbar_thumb.hsla();
    c.success = w.status.success.hsla();
    c.danger = w.status.danger.hsla();
    c.warning = w.status.warning.hsla();
    c.info = w.status.info.hsla();

    // Boutons : le kit lit des champs `button*` distincts de `primary` / `secondary`.
    let white = gpui_kit::white();
    c.button = bg3;
    c.button_hover = hover;
    c.button_active = active;
    c.button_foreground = text;
    c.button_primary = base;
    c.button_primary_hover = accent_hover;
    c.button_primary_active = base;
    c.button_primary_foreground = white;
    c.button_secondary = bg3;
    c.button_secondary_hover = hover;
    c.button_secondary_active = active;
    c.button_secondary_foreground = text;
    c.button_danger = c.danger;
    c.button_danger_hover = c.danger;
    c.button_danger_active = c.danger;
    c.button_danger_foreground = white;
}
