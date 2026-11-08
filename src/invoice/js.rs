//! JavaScript semantics the invoice layer was written in, kept exactly.
//!
//! The layer was first written in JavaScript (`he/invoice.mjs`) and its
//! output on the corpus is the oracle (`he/fixtures/golden/`). Where JS and
//! Rust differ in ways that change a result — rounding halves, number
//! parsing, number printing, the order an inconsistent comparator leaves —
//! these helpers do what JS does.

/// `Math.round`: halves go up (towards +∞), `-2.5` → `-2`.
pub(crate) fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `Math.round(v * 100) / 100`.
pub(crate) fn round2(v: f64) -> f64 {
    js_round(v * 100.0) / 100.0
}

/// `Number(text)`: the empty string is 0, anything that is not a number is NaN.
pub(crate) fn js_number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'-' => (-1.0, &t[1..]),
        b'+' => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = |prefix: &str, radix: u32| {
        body.strip_prefix(prefix)
            .or_else(|| body.strip_prefix(&prefix.to_uppercase()))
            .filter(|_| sign > 0.0 && !t.starts_with('+'))
            .and_then(|digits| u64::from_str_radix(digits, radix).ok())
            .map(|v| v as f64)
    };
    if let Some(v) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return v;
    }
    let bytes = body.as_bytes();
    let mut i = 0;
    let mut digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == start {
            return f64::NAN;
        }
        i = j;
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map(|v| sign * v).unwrap_or(f64::NAN)
}

/// `String(number)`: shortest round-trip digits, `-0` as `0`, exponents
/// outside [1e-6, 1e21) as JS writes them.
pub(crate) fn num_str(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    if !(1e-6..1e21).contains(&a) {
        // Rust's `{:e}` is "1.5e21" / "1e-7"; JS writes "1.5e+21" / "1e-7".
        let s = format!("{v:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    format!("{v}")
}

/// `Array.prototype.sort(cmp)` as V8 runs it on short arrays: one natural
/// run (a strictly descending one reversed), then binary insertion. Stable.
/// It gives the same order as any stable sort when `cmp` is consistent, and
/// V8's order when it is not (header blocks compare by "same band" first).
pub(crate) fn js_sort_by<T, F: FnMut(&T, &T) -> f64>(v: &mut Vec<T>, mut cmp: F) {
    let n = v.len();
    if n < 2 {
        return;
    }
    let mut run = 2;
    let descending = cmp(&v[1], &v[0]) < 0.0;
    for idx in 2..n {
        let order = cmp(&v[idx], &v[idx - 1]);
        if (descending && order >= 0.0) || (!descending && order < 0.0) {
            break;
        }
        run += 1;
    }
    if descending {
        v[..run].reverse();
    }
    for start in run..n {
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if cmp(&v[start], &v[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        let pivot = v.remove(start);
        v.insert(left, pivot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_and_numbers_follow_js() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(round2(1.005), 1.0); // 100.49999999999999 in floating point, as in JS
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert!(js_number("12a").is_nan());
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert!(js_number("inf").is_nan());
        assert_eq!(num_str(3.0), "3");
        assert_eq!(num_str(-0.0), "0");
        assert_eq!(num_str(60.8), "60.8");
        assert_eq!(num_str(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(num_str(1.5e21), "1.5e+21");
    }

    #[test]
    fn sort_is_stable_and_runs_like_v8() {
        let mut v = vec![(3, 'a'), (1, 'b'), (3, 'c'), (2, 'd')];
        js_sort_by(&mut v, |a, b| (a.0 - b.0) as f64);
        assert_eq!(v, vec![(1, 'b'), (2, 'd'), (3, 'a'), (3, 'c')]);
        let mut d = vec![5, 4, 3, 1, 2];
        js_sort_by(&mut d, |a, b| (*a - *b) as f64);
        assert_eq!(d, vec![1, 2, 3, 4, 5]);
    }
}
