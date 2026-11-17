//! Tokens de thème WaifuChat (W06) : types purs, sans dépendance GPUI. La conversion en `Hsla` se fait à la frontière
//! de la crate `ui`. Valeurs extraites de `src/styles/theme.css` (`@theme` l. 3-33, mode clair l. 204-221, OLED l. 223-240,
//! barre de titre l. 42-45, police l. 71, sélection l. 75-78, animations l. 91-199 et 259-293) et de `src/lib/accent.ts`
//! (`lightenHex` l. 19-26, `setAccentCssVars` l. 28-38, `applyAccentColor` l. 78-91, `loadAndApplyAccentColor` l. 128-133).

/// Couleur sRGB 8 bits par canal + alpha 8 bits. Écrite en `0xRRGGBB` (opaque) ou `0xRRGGBBAA` (comme le CSS à 8 chiffres).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

impl Rgba {
    /// `#rrggbb` → opaque.
    pub const fn hex(rgb: u32) -> Self {
        Self((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 0xff)
    }
    /// `#rrggbbaa` → avec alpha (ex. `#ff2d7833`).
    pub const fn hex_a(rgba: u32) -> Self {
        Self((rgba >> 24) as u8, (rgba >> 16) as u8, (rgba >> 8) as u8, rgba as u8)
    }
    /// Même couleur, autre alpha (`hex + '33'` dans `accent.ts:41`).
    pub const fn with_alpha(self, alpha: u8) -> Self {
        Self(self.0, self.1, self.2, alpha)
    }
    /// Port de `lightenHex` (`accent.ts:19-26`) : mélange avec du blanc de `amount` (0..=1), arrondi au plus proche.
    pub fn lighten(self, amount: f32) -> Self {
        let mix = |c: u8| (f32::from(c) + (255.0 - f32::from(c)) * amount).round().min(255.0) as u8;
        Self(mix(self.0), mix(self.1), mix(self.2), self.3)
    }
    /// `#rrggbb` ou `#rrggbbaa`, en minuscules (comparaison avec le CSS).
    pub fn css(self) -> String {
        if self.3 == 0xff {
            format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
        } else {
            format!("#{:02x}{:02x}{:02x}{:02x}", self.0, self.1, self.2, self.3)
        }
    }
}

/// Mode de thème : `:root` (sombre par défaut), `[data-theme="light"]` (l. 204), `[data-theme="oled"]` (l. 223).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThemeMode {
    Dark,
    Light,
    Oled,
}

/// Surface, texte, bordures, défilement : ce qui change d'un mode à l'autre (variables `--color-*` : fonds l. 4-8, texte l. 19-21, bordures l. 28-29, défilement l. 31-32).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Surfaces {
    pub bg_primary: Rgba,
    pub bg_secondary: Rgba,
    pub bg_tertiary: Rgba,
    pub bg_hover: Rgba,
    pub bg_active: Rgba,
    pub text_primary: Rgba,
    pub text_secondary: Rgba,
    pub text_muted: Rgba,
    pub border: Rgba,
    pub border_strong: Rgba,
    pub scrollbar_thumb: Rgba,
    pub scrollbar_track: Rgba,
}

/// Couleurs d'état : identiques dans les trois modes (définies une seule fois dans `@theme`, `theme.css:23-26` ; non redéfinies par les modes clair et OLED).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub success: Rgba,
    pub danger: Rgba,
    pub warning: Rgba,
    pub info: Rgba,
}

/// Famille d'accent : dérivée d'une seule couleur de base par [`Accent::from_base`] (`accent.ts:28-38`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accent {
    /// `--color-accent-pink`
    pub base: Rgba,
    /// `--color-accent-pink-hover` = base éclaircie de 18 %.
    pub hover: Rgba,
    /// `--color-accent-pink-dim` = base à alpha 0x33.
    pub dim: Rgba,
    /// `--color-link`
    pub link: Rgba,
    /// `--color-link-hover`
    pub link_hover: Rgba,
    /// `--color-mention`
    pub mention: Rgba,
    /// `--color-mention-bg` = base à alpha 0x26.
    pub mention_bg: Rgba,
    /// `--color-mention-hover-bg` = base à alpha 0x40.
    pub mention_hover_bg: Rgba,
}

impl Accent {
    /// Accent par défaut de l'application (`#ff2d78`).
    pub const DEFAULT_BASE: Rgba = Rgba::hex(0xff2d78);

    /// Accent par défaut **tel que déclaré dans le CSS statique** (`theme.css:10-17`) : le survol y est écrit en dur (l. 11)
    /// `#ff4d93`, qui n'est PAS ce que `lightenHex(#ff2d78, 0.18)` calcule (`#ff5390`, voir le test). Le web applique le
    /// calcul seulement si l'accent est modifié (`loadAndApplyAccentColor`, `accent.ts:128-133`) : un utilisateur qui
    /// n'a jamais choisi d'accent voit `#ff4d93`, celui qui re-choisit le rose par défaut voit `#ff5390`.
    /// Décision native : le défaut garde la valeur littérale (apparence actuelle de la majorité des comptes).
    pub const DEFAULT: Self = Self {
        base: Self::DEFAULT_BASE,
        hover: Rgba::hex(0xff4d93),
        dim: Rgba::hex_a(0xff2d7833),
        link: Self::DEFAULT_BASE,
        link_hover: Rgba::hex(0xff4d93),
        mention: Self::DEFAULT_BASE,
        mention_bg: Rgba::hex_a(0xff2d7826),
        mention_hover_bg: Rgba::hex_a(0xff2d7840),
    };

    /// Famille dérivée d'une couleur choisie (`setAccentCssVars`, `accent.ts:28-38`).
    pub fn from_base(base: Rgba) -> Self {
        let hover = base.lighten(0.18);
        Self {
            base,
            hover,
            dim: base.with_alpha(0x33),
            link: base,
            link_hover: hover,
            mention: base,
            mention_bg: base.with_alpha(0x26),
            mention_hover_bg: base.with_alpha(0x40),
        }
    }
}

/// Accent choisi par l'utilisateur : couleur unie, ou dégradé (`applyAccentColor(value, isGradient)`, `accent.ts:78-91`).
/// Le dégradé ne remplace que le **fond** des éléments `bg-accent-pink` ; texte, bordures et focus gardent sa première couleur.
#[derive(Clone, Debug, PartialEq)]
pub enum AccentChoice {
    Solid(Rgba),
    /// Dégradé CSS d'origine (`linear-gradient(...)`) conservé tel quel pour la persistance (`waifutxt_accent`), plus ses
    /// arrêts décodés pour le rendu natif ; `base` = première couleur hexadécimale trouvée (`accent.ts:79-80`).
    Gradient { css: String, angle_deg: f32, stops: Vec<(f32, Rgba)>, base: Rgba },
}

impl AccentChoice {
    /// Famille d'accent à appliquer. Le rose par défaut en couleur unie garde les littéraux du CSS ([`Accent::DEFAULT`]) ;
    /// tout autre choix, y compris un dégradé (qui ne contribue que par sa première couleur), est dérivé.
    pub fn family(&self) -> Accent {
        match self {
            Self::Solid(base) if *base == Accent::DEFAULT_BASE => Accent::DEFAULT,
            Self::Solid(base) | Self::Gradient { base, .. } => Accent::from_base(*base),
        }
    }
}

/// Rayons (px) : échelle Tailwind v4 utilisée par les composants (`rounded-md` 108×, `-full` 73×, `-lg` 68×, `-xl` 21×,
/// `-2xl` 3× ; comptage `grep -rhoE` sur `src/components`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Radii {
    pub none: f32,
    pub sm: f32,
    pub md: f32,
    pub lg: f32,
    pub xl: f32,
    pub xxl: f32,
    pub full: f32,
}

/// Espacement : unité de 4 px (`p-1` = 4 px, `gap-2` = 8 px, `px-3` = 12 px…).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spacing {
    pub unit: f32,
}

impl Spacing {
    /// `n` unités Tailwind (`px(0.5)` = 2 px, `px(1.5)` = 6 px, `px(3)` = 12 px).
    pub fn of(self, n: f32) -> f32 {
        self.unit * n
    }
}

/// Une taille de texte : corps et interligne en px (`text-xs` = 12/16, …).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextSize {
    pub size: f32,
    pub line_height: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Typography {
    /// `body { font-family }` (`theme.css:71`) ; l'ordre est celui de la pile CSS.
    pub font_family: &'static [&'static str],
    pub mono_family: &'static [&'static str],
    pub xs: TextSize,
    pub sm: TextSize,
    pub base: TextSize,
    pub lg: TextSize,
    pub xl: TextSize,
    pub xxl: TextSize,
    /// `font-medium`, `font-semibold`, `font-bold` (poids CSS).
    pub medium: u16,
    pub semibold: u16,
    pub bold: u16,
}

/// Une ombre (`box-shadow`) : décalage, flou, étalement, couleur.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub x: f32,
    pub y: f32,
    pub blur: f32,
    pub spread: f32,
    pub color: Rgba,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shadows {
    pub sm: [Shadow; 2],
    pub lg: [Shadow; 2],
    pub xl: [Shadow; 2],
    pub xxl: [Shadow; 1],
}

/// Durées (ms) et courbes des animations de panneaux et de fenêtres (`transition-* duration-200 ease-out`,
/// `useOverlayAnimation(…, 180)`, `emoji-picker-enter 130ms`, `avatar-liquid-* 360ms`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub panel_ms: u32,
    pub overlay_ms: u32,
    pub popover_enter_ms: u32,
    pub avatar_morph_ms: u32,
    /// `ease-out` CSS = `cubic-bezier(0, 0, 0.58, 1)`.
    pub ease_out: [f32; 4],
    /// `cubic-bezier(0.22, 1, 0.36, 1)` des animations d'avatar.
    pub ease_avatar: [f32; 4],
    /// `cubic-bezier(0.2, 0, 0.13, 1)` du sélecteur d'émojis.
    pub ease_popover: [f32; 4],
}

/// Hauteur de la barre de titre sans cadre : `--titlebar-height: 32px` (`theme.css:41-46`).
pub const TITLEBAR_HEIGHT: f32 = 32.0;

/// Thème complet : tout ce que les vues de WaifuChat lisent (jamais de couleur en dur dans une vue).
#[derive(Clone, Debug, PartialEq)]
pub struct WaifuTheme {
    pub mode: ThemeMode,
    pub surfaces: Surfaces,
    pub status: Status,
    pub accent: Accent,
    pub radii: Radii,
    pub spacing: Spacing,
    pub typography: Typography,
    pub shadows: Shadows,
    pub motion: Motion,
}

const TEXT_SELECTION: u8 = 0x33; // `::selection { background: var(--color-accent-pink-dim) }` (theme.css:75-78)

impl WaifuTheme {
    pub fn new(mode: ThemeMode, accent: &AccentChoice) -> Self {
        Self {
            mode,
            surfaces: Surfaces::of(mode),
            status: Status::STANDARD,
            accent: accent.family(),
            radii: Radii::TAILWIND,
            spacing: Spacing { unit: 4.0 },
            typography: Typography::standard(),
            shadows: Shadows::tailwind(),
            motion: Motion::STANDARD,
        }
    }

    /// Fond de la sélection de texte : l'accent à alpha `0x33`.
    pub fn selection(&self) -> Rgba {
        self.accent.base.with_alpha(TEXT_SELECTION)
    }
}

impl Surfaces {
    /// Palettes des trois modes, valeur pour valeur (sombre : `theme.css:4-8,19-21,28-29,31-32` ; clair : l. 204-221 ; OLED : l. 223-240).
    pub const fn of(mode: ThemeMode) -> Self {
        match mode {
            ThemeMode::Dark => Self {
                bg_primary: Rgba::hex(0x0b0b14),
                bg_secondary: Rgba::hex(0x12121f),
                bg_tertiary: Rgba::hex(0x1a1a2e),
                bg_hover: Rgba::hex(0x252540),
                bg_active: Rgba::hex(0x2e2e50),
                text_primary: Rgba::hex(0xe8e8f0),
                text_secondary: Rgba::hex(0x8888a8),
                text_muted: Rgba::hex(0x555570),
                border: Rgba::hex(0x2a2a40),
                border_strong: Rgba::hex(0x3a3a58),
                scrollbar_thumb: Rgba::hex(0x2a2a40),
                scrollbar_track: Rgba(0, 0, 0, 0),
            },
            ThemeMode::Light => Self {
                bg_primary: Rgba::hex(0xf0f2f5),
                bg_secondary: Rgba::hex(0xffffff),
                bg_tertiary: Rgba::hex(0xe8eaed),
                bg_hover: Rgba::hex(0xdde1e7),
                bg_active: Rgba::hex(0xc9cdd5),
                text_primary: Rgba::hex(0x1a1b1e),
                text_secondary: Rgba::hex(0x4e5058),
                text_muted: Rgba::hex(0x8a8b8f),
                border: Rgba::hex(0xd5d7dc),
                border_strong: Rgba::hex(0xb5b7bc),
                scrollbar_thumb: Rgba::hex(0xc0c2c8),
                scrollbar_track: Rgba(0, 0, 0, 0),
            },
            ThemeMode::Oled => Self {
                bg_primary: Rgba::hex(0x000000),
                bg_secondary: Rgba::hex(0x080808),
                bg_tertiary: Rgba::hex(0x111111),
                bg_hover: Rgba::hex(0x1c1c1c),
                bg_active: Rgba::hex(0x242424),
                text_primary: Rgba::hex(0xf0f0f0),
                text_secondary: Rgba::hex(0x888888),
                text_muted: Rgba::hex(0x444444),
                border: Rgba::hex(0x1c1c1c),
                border_strong: Rgba::hex(0x2c2c2c),
                scrollbar_thumb: Rgba::hex(0x1c1c1c),
                scrollbar_track: Rgba(0, 0, 0, 0),
            },
        }
    }
}

impl Status {
    pub const STANDARD: Self = Self {
        success: Rgba::hex(0x3ddc84),
        danger: Rgba::hex(0xff4458),
        warning: Rgba::hex(0xffb347),
        info: Rgba::hex(0x4dabf7),
    };
}

impl Radii {
    pub const TAILWIND: Self = Self { none: 0.0, sm: 4.0, md: 6.0, lg: 8.0, xl: 12.0, xxl: 16.0, full: 9999.0 };
}

impl Typography {
    pub fn standard() -> Self {
        Self {
            font_family: &["Segoe UI", "system-ui", "-apple-system", "sans-serif"],
            mono_family: &["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
            xs: TextSize { size: 12.0, line_height: 16.0 },
            sm: TextSize { size: 14.0, line_height: 20.0 },
            base: TextSize { size: 16.0, line_height: 24.0 },
            lg: TextSize { size: 18.0, line_height: 28.0 },
            xl: TextSize { size: 20.0, line_height: 28.0 },
            xxl: TextSize { size: 24.0, line_height: 32.0 },
            medium: 500,
            semibold: 600,
            bold: 700,
        }
    }
}

impl Shadows {
    pub fn tailwind() -> Self {
        let k = |a: f32| Rgba(0, 0, 0, (a * 255.0).round() as u8);
        let s = |x, y, blur, spread, a| Shadow { x, y, blur, spread, color: k(a) };
        Self {
            sm: [s(0.0, 1.0, 3.0, 0.0, 0.1), s(0.0, 1.0, 2.0, -1.0, 0.1)],
            lg: [s(0.0, 10.0, 15.0, -3.0, 0.1), s(0.0, 4.0, 6.0, -4.0, 0.1)],
            xl: [s(0.0, 20.0, 25.0, -5.0, 0.1), s(0.0, 8.0, 10.0, -6.0, 0.1)],
            xxl: [s(0.0, 25.0, 50.0, -12.0, 0.25)],
        }
    }
}

impl Motion {
    pub const STANDARD: Self = Self {
        panel_ms: 200,
        overlay_ms: 180,
        popover_enter_ms: 130,
        avatar_morph_ms: 360,
        ease_out: [0.0, 0.0, 0.58, 1.0],
        ease_avatar: [0.22, 1.0, 0.36, 1.0],
        ease_popover: [0.2, 0.0, 0.13, 1.0],
    };
}

/// Illustration « waifu » optionnelle (`src/lib/waifu.ts:1-29`) : deux options, `miku` par défaut.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WaifuId {
    Miku,
    Airi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WaifuOption {
    pub id: WaifuId,
    pub name: &'static str,
    /// Chemin de l'image dans `src/assets/waifu/` (à copier dans les assets de l'app native).
    pub image: &'static str,
    pub tagline: &'static str,
}

pub const WAIFU_OPTIONS: [WaifuOption; 2] = [
    WaifuOption { id: WaifuId::Miku, name: "Miku", image: "miku_waifu.png", tagline: "Cyber idol" },
    WaifuOption { id: WaifuId::Airi, name: "Airi", image: "violet_hair_waifu.png", tagline: "E-girl neon" },
];

/// `getWaifuById` (`waifu.ts:25-27`) : repli sur la première option.
pub fn waifu_by_id(id: WaifuId) -> WaifuOption {
    WAIFU_OPTIONS.iter().copied().find(|w| w.id == id).unwrap_or(WAIFU_OPTIONS[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_accent_family_matches_the_css_variables() {
        let a = AccentChoice::Solid(Accent::DEFAULT_BASE).family();
        assert_eq!(a, Accent::DEFAULT);
        assert_eq!(a.base.css(), "#ff2d78");
        assert_eq!(a.hover.css(), "#ff4d93", "theme.css:11 (--color-accent-pink-hover)");
        assert_eq!(a.dim.css(), "#ff2d7833");
        assert_eq!(a.mention_bg.css(), "#ff2d7826");
        assert_eq!(a.mention_hover_bg.css(), "#ff2d7840");
        assert_eq!((a.link, a.mention), (a.base, a.base));
        assert_eq!(a.link_hover, a.hover);
    }

    #[test]
    fn the_web_computes_a_different_hover_than_its_static_css_for_the_default_pink() {
        // Constat sur le code d'origine : lightenHex(#ff2d78, 0.18) = #ff5390 ≠ #ff4d93 (theme.css:11).
        let derived = Accent::from_base(Accent::DEFAULT_BASE);
        assert_eq!(derived.hover.css(), "#ff5390");
        assert_ne!(derived.hover, Accent::DEFAULT.hover);
        // Les autres dérivés coïncident avec le CSS statique.
        assert_eq!((derived.dim, derived.mention_bg, derived.mention_hover_bg), (Accent::DEFAULT.dim, Accent::DEFAULT.mention_bg, Accent::DEFAULT.mention_hover_bg));
    }

    #[test]
    fn dark_palette_is_the_root_block_of_theme_css() {
        let s = Surfaces::of(ThemeMode::Dark);
        assert_eq!(s.bg_primary.css(), "#0b0b14");
        assert_eq!(s.text_muted.css(), "#555570");
        assert_eq!(s.border_strong.css(), "#3a3a58");
        assert_eq!(Status::STANDARD.danger.css(), "#ff4458");
    }

    #[test]
    fn light_and_oled_override_only_surfaces() {
        let (l, o) = (Surfaces::of(ThemeMode::Light), Surfaces::of(ThemeMode::Oled));
        assert_eq!(l.bg_secondary.css(), "#ffffff");
        assert_eq!(o.bg_primary.css(), "#000000");
        assert_eq!(l.scrollbar_thumb.css(), "#c0c2c8");
        assert_ne!(l, o);
    }

    #[test]
    fn a_gradient_contributes_only_its_first_color_to_the_family() {
        let choice = AccentChoice::Gradient {
            css: "linear-gradient(135deg, #ff2d78, #7c3aed)".to_owned(),
            angle_deg: 135.0,
            stops: vec![(0.0, Rgba::hex(0xff2d78)), (1.0, Rgba::hex(0x7c3aed))],
            base: Rgba::hex(0xff2d78),
        };
        assert_eq!(choice.family(), Accent::from_base(Accent::DEFAULT_BASE), "dégradé : toujours dérivé, jamais les littéraux");
        let other = AccentChoice::Solid(Rgba::hex(0x3ddc84)).family();
        assert_eq!(other.hover.css(), Rgba::hex(0x3ddc84).lighten(0.18).css());
    }

    #[test]
    fn lightening_saturates_and_rounds_like_accent_ts() {
        assert_eq!(Rgba::hex(0xffffff).lighten(0.18).css(), "#ffffff");
        assert_eq!(Rgba::hex(0x000000).lighten(0.18).css(), "#2e2e2e");
    }

    #[test]
    fn theme_assembly_and_waifu_lookup() {
        let t = WaifuTheme::new(ThemeMode::Oled, &AccentChoice::Solid(Accent::DEFAULT_BASE));
        assert_eq!(t.spacing.of(3.0), 12.0);
        assert_eq!(t.selection().css(), "#ff2d7833");
        assert_eq!(t.radii.md, 6.0);
        assert_eq!(waifu_by_id(WaifuId::Airi).name, "Airi");
        assert_eq!(WAIFU_OPTIONS.len(), 2);
    }
}
