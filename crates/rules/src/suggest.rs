//! "Did you mean" suggestions.

/// The closest candidate to `name`: an exact case-insensitive match, or else the
/// candidate with the smallest edit distance, if that distance is small.
pub fn did_you_mean<'a>(
    name: &str,
    candidates: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    let lower = name.to_ascii_lowercase();
    let max = (name.len() / 3).max(1);
    let mut best: Option<(usize, &str)> = None;
    for c in candidates {
        let d = if c.eq_ignore_ascii_case(name) {
            0
        } else {
            edit_distance(&lower, &c.to_ascii_lowercase())
        };
        if d <= max && best.is_none_or(|(bd, bc)| (d, c) < (bd, bc)) {
            best = Some((d, c));
        }
    }
    best.map(|(_, c)| c)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_close_names() {
        let names = ["CLK100MHZ", "led[0]", "led[1]", "btnC"];
        assert_eq!(did_you_mean("clk100mhz", names), Some("CLK100MHZ"));
        assert_eq!(did_you_mean("CLK100MZ", names), Some("CLK100MHZ"));
        assert_eq!(did_you_mean("btnc", names), Some("btnC"));
        assert_eq!(did_you_mean("uart_tx", names), None);
    }

    #[test]
    fn edit_distance_basics() {
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("same", "same"), 0);
    }
}
