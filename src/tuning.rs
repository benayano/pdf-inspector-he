//! Tuning knobs for reading right-to-left lines back into logical order.
//!
//! The one knob today is the number gap: the gap, in em, from which two
//! numeric fragments that meet on a right-to-left line are taken to be two
//! numbers with a word space between them rather than the halves of one
//! number. A space in common sans-serif fonts is about 0.28 em, so a fixed
//! floor above that (the old 0.3) glues the numbers of an invoice line such
//! as `1.2 3` into `31.2`. No single value suits every producer, so the
//! value can be set per call, per process (environment variable), or derived
//! from the line's own gaps ([`NumberGap::Auto`]).
//!
//! Precedence: [`with_number_gap`] scope (this thread) →
//! [`set_process_number_gap`] (all threads; what the Python and Node
//! bindings' `set_number_gap` set) → `PDF_INSPECTOR_NUMBER_GAP_EM`
//! environment variable (`auto` or a number) → [`DEFAULT_NUMBER_GAP_EM`].

use std::cell::Cell;
use std::sync::{Mutex, OnceLock};

/// Default number gap, in em. Below a regular space (≈0.28 em) and well
/// above the gap a kerned decimal point or thousands separator opens.
pub const DEFAULT_NUMBER_GAP_EM: f32 = 0.2;

/// Environment variable read once per process: `auto` or a gap in em.
pub const NUMBER_GAP_ENV: &str = "PDF_INSPECTOR_NUMBER_GAP_EM";

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

impl NumberGap {
    /// Parse `auto` or a non-negative finite number of em.
    pub fn parse(value: &str) -> Option<NumberGap> {
        let value = value.trim();
        if value.eq_ignore_ascii_case("auto") {
            return Some(NumberGap::Auto);
        }
        value
            .parse::<f32>()
            .ok()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(NumberGap::Fixed)
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

thread_local! {
    static SCOPED: Cell<Option<NumberGap>> = const { Cell::new(None) };
}

fn from_env() -> Option<NumberGap> {
    static ENV: OnceLock<Option<NumberGap>> = OnceLock::new();
    *ENV.get_or_init(|| {
        std::env::var(NUMBER_GAP_ENV)
            .ok()
            .and_then(|v| NumberGap::parse(&v))
    })
}

static PROCESS: Mutex<Option<NumberGap>> = Mutex::new(None);

/// Set (or with `None` clear) the number gap for every thread of the
/// process. A [`with_number_gap`] scope still takes precedence.
pub fn set_process_number_gap(gap: Option<NumberGap>) {
    *PROCESS.lock().unwrap_or_else(|e| e.into_inner()) = gap;
}

fn from_process() -> Option<NumberGap> {
    *PROCESS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The number gap in effect on this thread.
pub fn current_number_gap() -> NumberGap {
    SCOPED
        .with(Cell::get)
        .or_else(from_process)
        .or_else(from_env)
        .unwrap_or_default()
}

/// Run `f` with `gap` as the number gap on this thread; the previous value
/// is restored afterwards, also when `f` panics.
pub fn with_number_gap<R>(gap: NumberGap, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<NumberGap>);
    impl Drop for Restore {
        fn drop(&mut self) {
            SCOPED.with(|s| s.set(self.0));
        }
    }
    let _restore = Restore(SCOPED.with(|s| s.replace(Some(gap))));
    f()
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
    fn scope_overrides_and_restores() {
        let outer = current_number_gap();
        with_number_gap(NumberGap::Fixed(0.5), || {
            assert_eq!(current_number_gap(), NumberGap::Fixed(0.5));
            with_number_gap(NumberGap::Auto, || {
                assert_eq!(current_number_gap(), NumberGap::Auto);
            });
            assert_eq!(current_number_gap(), NumberGap::Fixed(0.5));
        });
        assert_eq!(current_number_gap(), outer);
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
