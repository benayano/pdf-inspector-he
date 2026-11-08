//! Tuning knobs for the layout heuristics that most often need it on
//! right-to-left documents and on tables drawn by browsers.
//!
//! Every knob is either `auto` (the built-in behaviour, measured from the
//! document where the heuristic can) or a fixed number. Each one can be set
//! per call, per process, or by environment variable, so a person — or an
//! LLM driving the library as a tool — can try values on a document whose
//! output is wrong and keep the one that reads right. See [`KNOBS`] for the
//! list, with units and what each one changes.
//!
//! Precedence, per knob: [`with_tuning`] scope (this thread) →
//! [`set_process_tuning`] (all threads; what the Python and Node bindings'
//! `set_tuning` set) → the `PDF_INSPECTOR_TUNING` environment variable
//! (`knob=value,knob=value`; `PDF_INSPECTOR_NUMBER_GAP_EM` is still read
//! for `number_gap`) → `auto`.
//!
//! The text form, accepted everywhere: `number_gap=0.25,rule_join_gap=auto`.

use std::cell::Cell;
use std::fmt;
use std::sync::{Mutex, OnceLock};

/// Default number gap, in em. Below a regular space (≈0.28 em) and well
/// above the gap a kerned decimal point or thousands separator opens.
pub const DEFAULT_NUMBER_GAP_EM: f32 = 0.2;

/// Legacy environment variable for `number_gap` alone.
pub const NUMBER_GAP_ENV: &str = "PDF_INSPECTOR_NUMBER_GAP_EM";

/// Environment variable with any knobs, `knob=value,knob=value`.
pub const TUNING_ENV: &str = "PDF_INSPECTOR_TUNING";

/// A knob's setting: the built-in (`auto`) or a fixed value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Knob {
    Auto,
    Fixed(f32),
}

impl Knob {
    /// Parse `auto` or a non-negative finite number.
    pub fn parse(value: &str) -> Option<Knob> {
        let value = value.trim();
        if value.eq_ignore_ascii_case("auto") {
            return Some(Knob::Auto);
        }
        value
            .parse::<f32>()
            .ok()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(Knob::Fixed)
    }

    /// The fixed value, or `auto()` when automatic.
    pub fn or_auto(self, auto: impl FnOnce() -> f32) -> f32 {
        match self {
            Knob::Fixed(v) => v,
            Knob::Auto => auto(),
        }
    }
}

impl fmt::Display for Knob {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Knob::Auto => f.write_str("auto"),
            Knob::Fixed(v) => write!(f, "{v}"),
        }
    }
}

/// One tunable heuristic, described for people and for tool schemas.
#[derive(Debug, Clone, Copy)]
pub struct KnobInfo {
    pub name: &'static str,
    pub unit: &'static str,
    /// What `auto` does.
    pub auto: &'static str,
    /// What the knob changes, and which way to turn it.
    pub effect: &'static str,
}

/// Every knob, in [`Tuning`] field order.
pub const KNOBS: [KnobInfo; 7] = [
    KnobInfo {
        name: "number_gap",
        unit: "em",
        auto: "0.2, or the line's own word-gap floor on lines shown one glyph per item",
        effect: "Gap from which two numbers meeting on a right-to-left line are two numbers \
                 (\"1.2 3\") rather than one (\"31.2\"). Lower splits more; raise it if a \
                 decimal point set apart splits a number.",
    },
    KnobInfo {
        name: "word_gap_cap",
        unit: "em",
        auto: "1.0",
        effect: "Gaps wider than this stay out of the per-line word-space estimate (they are \
                 column or cell gaps). Raise it if words of widely spaced text are glued; \
                 lower it if table rows glue their words.",
    },
    KnobInfo {
        name: "rule_thickness",
        unit: "pt (user space)",
        auto: "3.0",
        effect: "A filled strip at most this thick and 4x as long is read as a drawn rule \
                 (table borders painted as shapes). Raise it for thick borders; 0 turns the \
                 reading off.",
    },
    KnobInfo {
        name: "rule_join_gap",
        unit: "pt",
        auto: "2.0",
        effect: "Collinear pieces of a column rule this close are joined into one rule \
                 (grids drawn cell by cell). Raise it if a bordered table is not found.",
    },
    KnobInfo {
        name: "short_rule_ratio",
        unit: "fraction of the longest column rule",
        auto: "0.3",
        effect: "Column rules shorter than this share of the longest are left out of the \
                 grid (they belong to another box, e.g. totals under the items). Lower it if \
                 a real column is lost; raise it if phantom empty columns appear.",
    },
    KnobInfo {
        name: "stacked_line_gap",
        unit: "em",
        auto: "0.5",
        effect: "Baselines on one grouped line this far apart are separate stacked lines \
                 (a two-line header cell beside one-line cells). Lower it if two lines \
                 interleave their letters; raise it if superscripts split off.",
    },
    KnobInfo {
        name: "latin_digit_split",
        unit: "switch (0 or 1)",
        auto: "1 only on a right-to-left line that no Unicode-bidi reading reproduces \
               (laid out word by word, as Priority / Winnovative invoices are), else 0",
        effect: "Whether a number shown a word gap before a Latin word on a right-to-left \
                 line is a token of its own (1: `HIGH TECH 1.5\" 3000`) or the end of the \
                 Latin phrase (0: `3000 \"1.5 HIGH TECH`). Set 1 if numbers jump in front of \
                 Latin product names; 0 if a Latin phrase loses its trailing number.",
    },
];

/// A set of knob settings; `None` means "not set at this level".
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Tuning {
    pub number_gap: Option<Knob>,
    pub word_gap_cap: Option<Knob>,
    pub rule_thickness: Option<Knob>,
    pub rule_join_gap: Option<Knob>,
    pub short_rule_ratio: Option<Knob>,
    pub stacked_line_gap: Option<Knob>,
    pub latin_digit_split: Option<Knob>,
}

impl Tuning {
    fn slots(&mut self) -> [&mut Option<Knob>; 7] {
        [
            &mut self.number_gap,
            &mut self.word_gap_cap,
            &mut self.rule_thickness,
            &mut self.rule_join_gap,
            &mut self.short_rule_ratio,
            &mut self.stacked_line_gap,
            &mut self.latin_digit_split,
        ]
    }

    fn values(&self) -> [Option<Knob>; 7] {
        [
            self.number_gap,
            self.word_gap_cap,
            self.rule_thickness,
            self.rule_join_gap,
            self.short_rule_ratio,
            self.stacked_line_gap,
            self.latin_digit_split,
        ]
    }

    /// Parse `knob=value,knob=value` (also `;` or whitespace separated).
    /// An empty string is an empty tuning.
    pub fn parse(text: &str) -> Result<Tuning, String> {
        let mut tuning = Tuning::default();
        for part in text
            .split([',', ';', ' ', '\n'])
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            let (name, value) = part
                .split_once('=')
                .ok_or_else(|| format!("expected knob=value, got `{part}`"))?;
            let name = name.trim();
            let index = KNOBS.iter().position(|k| k.name == name).ok_or_else(|| {
                format!(
                    "unknown knob `{name}` (known: {})",
                    KNOBS.iter().map(|k| k.name).collect::<Vec<_>>().join(", ")
                )
            })?;
            let knob = Knob::parse(value)
                .ok_or_else(|| format!("`{name}` takes auto or a non-negative number"))?;
            *tuning.slots()[index] = Some(knob);
        }
        Ok(tuning)
    }

    /// Each knob from `self`, else from `fallback`.
    pub fn or(self, fallback: Tuning) -> Tuning {
        let mut out = self;
        let fb = fallback.values();
        for (slot, value) in out.slots().into_iter().zip(fb) {
            if slot.is_none() {
                *slot = value;
            }
        }
        out
    }
}

impl fmt::Display for Tuning {
    /// The set knobs as `knob=value,…` (the form [`Tuning::parse`] reads).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let parts: Vec<String> = KNOBS
            .iter()
            .zip(self.values())
            .filter_map(|(info, value)| value.map(|v| format!("{}={v}", info.name)))
            .collect();
        f.write_str(&parts.join(","))
    }
}

thread_local! {
    static SCOPED: Cell<Tuning> = const {
        Cell::new(Tuning {
            number_gap: None,
            word_gap_cap: None,
            rule_thickness: None,
            rule_join_gap: None,
            short_rule_ratio: None,
            stacked_line_gap: None,
            latin_digit_split: None,
        })
    };
}

static PROCESS: Mutex<Tuning> = Mutex::new(Tuning {
    number_gap: None,
    word_gap_cap: None,
    rule_thickness: None,
    rule_join_gap: None,
    short_rule_ratio: None,
    stacked_line_gap: None,
    latin_digit_split: None,
});

fn from_env() -> Tuning {
    static ENV: OnceLock<Tuning> = OnceLock::new();
    *ENV.get_or_init(|| {
        let mut tuning = std::env::var(TUNING_ENV)
            .ok()
            .and_then(|v| Tuning::parse(&v).ok())
            .unwrap_or_default();
        if tuning.number_gap.is_none() {
            tuning.number_gap = std::env::var(NUMBER_GAP_ENV)
                .ok()
                .and_then(|v| Knob::parse(&v));
        }
        tuning
    })
}

/// Set the process-wide tuning (all threads). Knobs left `None` fall
/// through to the environment and then to `auto`. A [`with_tuning`] scope
/// still takes precedence.
pub fn set_process_tuning(tuning: Tuning) {
    *PROCESS.lock().unwrap_or_else(|e| e.into_inner()) = tuning;
}

/// The process-wide tuning as set by [`set_process_tuning`].
pub fn process_tuning() -> Tuning {
    *PROCESS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The settings in effect on this thread; knobs set nowhere are `None`
/// (that is, `auto`).
pub fn current_tuning() -> Tuning {
    SCOPED.with(Cell::get).or(process_tuning()).or(from_env())
}

/// Run `f` with the knobs set in `tuning` overriding the outer settings on
/// this thread; restored afterwards, also when `f` panics.
pub fn with_tuning<R>(tuning: Tuning, f: impl FnOnce() -> R) -> R {
    struct Restore(Tuning);
    impl Drop for Restore {
        fn drop(&mut self) {
            SCOPED.with(|s| s.set(self.0));
        }
    }
    let outer = SCOPED.with(Cell::get);
    let _restore = Restore(outer);
    SCOPED.with(|s| s.set(tuning.or(outer)));
    f()
}

/// A knob's value in effect, `auto` when set nowhere.
pub(crate) fn knob(select: impl Fn(&Tuning) -> Option<Knob>) -> Knob {
    select(&current_tuning()).unwrap_or(Knob::Auto)
}

// ── number_gap (the first knob; kept as its own API) ──────────────────────

/// How the gap between two numeric fragments of a right-to-left line is
/// judged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NumberGap {
    /// A fixed floor in em of the item's font size.
    Fixed(f32),
    /// The line's own word-gap floor when its gaps split into letter gaps
    /// and word gaps (a line shown one glyph per item); otherwise
    /// [`DEFAULT_NUMBER_GAP_EM`].
    Auto,
}

impl Default for NumberGap {
    fn default() -> Self {
        NumberGap::Fixed(DEFAULT_NUMBER_GAP_EM)
    }
}

impl From<NumberGap> for Knob {
    fn from(gap: NumberGap) -> Knob {
        match gap {
            NumberGap::Fixed(v) => Knob::Fixed(v),
            NumberGap::Auto => Knob::Auto,
        }
    }
}

impl NumberGap {
    /// Parse `auto` or a non-negative finite number of em.
    pub fn parse(value: &str) -> Option<NumberGap> {
        Knob::parse(value).map(|k| match k {
            Knob::Auto => NumberGap::Auto,
            Knob::Fixed(v) => NumberGap::Fixed(v),
        })
    }

    /// The floor in em for a line whose own word-gap floor is `line_floor`.
    pub(crate) fn floor_em(self, line_floor: Option<f32>) -> f32 {
        match self {
            NumberGap::Fixed(v) => v,
            NumberGap::Auto => match line_floor {
                Some(f) if f.is_finite() && f > 0.0 => f,
                _ => DEFAULT_NUMBER_GAP_EM,
            },
        }
    }
}

/// The number gap in effect on this thread. Unlike the other knobs, an
/// unset `number_gap` is the fixed default 0.2, not `Auto`.
pub fn current_number_gap() -> NumberGap {
    match current_tuning().number_gap {
        Some(Knob::Auto) => NumberGap::Auto,
        Some(Knob::Fixed(v)) => NumberGap::Fixed(v),
        None => NumberGap::default(),
    }
}

/// Run `f` with `gap` as the number gap on this thread.
pub fn with_number_gap<R>(gap: NumberGap, f: impl FnOnce() -> R) -> R {
    with_tuning(
        Tuning {
            number_gap: Some(gap.into()),
            ..Tuning::default()
        },
        f,
    )
}

/// Set (or with `None` clear) the process-wide number gap, leaving the
/// other process-wide knobs as they are.
pub fn set_process_number_gap(gap: Option<NumberGap>) {
    let mut tuning = process_tuning();
    tuning.number_gap = gap.map(Into::into);
    set_process_tuning(tuning);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_auto_and_numbers() {
        assert_eq!(NumberGap::parse("auto"), Some(NumberGap::Auto));
        assert_eq!(NumberGap::parse(" AUTO "), Some(NumberGap::Auto));
        assert_eq!(NumberGap::parse("0.15"), Some(NumberGap::Fixed(0.15)));
        assert_eq!(NumberGap::parse("-1"), None);
        assert_eq!(NumberGap::parse("x"), None);
    }

    #[test]
    fn tuning_text_round_trips() {
        let t = Tuning::parse("number_gap=0.25, rule_join_gap=auto;short_rule_ratio=0.1").unwrap();
        assert_eq!(t.number_gap, Some(Knob::Fixed(0.25)));
        assert_eq!(t.rule_join_gap, Some(Knob::Auto));
        assert_eq!(t.short_rule_ratio, Some(Knob::Fixed(0.1)));
        assert_eq!(t.word_gap_cap, None);
        assert_eq!(Tuning::parse(&t.to_string()).unwrap(), t);
        assert!(Tuning::parse("nope=1")
            .unwrap_err()
            .contains("unknown knob"));
        assert!(Tuning::parse("number_gap=-2").is_err());
        assert!(Tuning::parse("number_gap").is_err());
        assert_eq!(Tuning::parse("").unwrap(), Tuning::default());
    }

    #[test]
    fn knob_list_matches_fields() {
        let all = KNOBS
            .iter()
            .map(|k| format!("{}=1", k.name))
            .collect::<Vec<_>>()
            .join(",");
        let t = Tuning::parse(&all).unwrap();
        assert!(t.values().iter().all(|v| *v == Some(Knob::Fixed(1.0))));
    }

    #[test]
    fn scopes_layer_per_knob_and_restore() {
        let outer_scope = SCOPED.with(Cell::get);
        let a = Tuning::parse("number_gap=0.5,rule_thickness=4").unwrap();
        with_tuning(a, || {
            assert_eq!(current_number_gap(), NumberGap::Fixed(0.5));
            let b = Tuning::parse("number_gap=auto").unwrap();
            with_tuning(b, || {
                assert_eq!(current_number_gap(), NumberGap::Auto);
                // Set in the outer scope only: still in effect.
                assert_eq!(knob(|t| t.rule_thickness), Knob::Fixed(4.0));
            });
            assert_eq!(current_number_gap(), NumberGap::Fixed(0.5));
        });
        assert_eq!(SCOPED.with(Cell::get), outer_scope);
    }

    #[test]
    fn scope_beats_process_setting() {
        with_number_gap(NumberGap::Fixed(0.7), || {
            set_process_number_gap(Some(NumberGap::Auto));
            assert_eq!(current_number_gap(), NumberGap::Fixed(0.7));
            set_process_number_gap(None);
        });
    }

    #[test]
    fn auto_uses_line_floor_when_it_has_one() {
        assert_eq!(NumberGap::Auto.floor_em(Some(0.14)), 0.14);
        assert_eq!(
            NumberGap::Auto.floor_em(Some(f32::INFINITY)),
            DEFAULT_NUMBER_GAP_EM
        );
        assert_eq!(NumberGap::Auto.floor_em(None), DEFAULT_NUMBER_GAP_EM);
        assert_eq!(NumberGap::Fixed(0.3).floor_em(Some(0.14)), 0.3);
    }
}
