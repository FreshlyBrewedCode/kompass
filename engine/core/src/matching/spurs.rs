//! Piece merging and the spur clean-up that follows Viterbi.

use super::Piece;
use crate::graph::{EdgeId, Graph};

/// Removes short turn-backs from `pieces[range]` (in place, the rest shifts down): two consecutive
/// pieces on the same edge in opposite directions that meet, where the shorter covers less than
/// `max_m`, become one piece from the first's start to the second's end (or nothing), merged with
/// its neighbours. Catches GPS jitter while standing and detours into a short side edge and back.
/// Returns how many pieces were removed.
pub(super) fn remove_spurs(
    g: &Graph,
    pieces: &mut Vec<Piece>,
    range: std::ops::Range<usize>,
    max_m: f64,
) -> usize {
    let mut out: Vec<Piece> = Vec::with_capacity(range.len());
    for &pc in &pieces[range.clone()] {
        let mut cur = Some(pc);
        while let Some(b) = cur.take() {
            let Some(a) = out.last().copied() else {
                out.push(b);
                break;
            };
            if a.edge == b.edge && (a.end - b.start).abs() < 1e-4 {
                let len = f64::from(g.length_m(a.edge));
                if a.reverse != b.reverse && f64::from(a.share().min(b.share())) * len < max_m {
                    out.pop();
                    if (b.end - a.start).abs() > 1e-6 {
                        cur = Some(Piece {
                            edge: a.edge,
                            reverse: b.end < a.start,
                            start: a.start,
                            end: b.end,
                            first_point: a.first_point,
                            last_point: b.last_point,
                        });
                    }
                    continue;
                }
                if a.reverse == b.reverse {
                    let last = out.last_mut().expect("a is there");
                    last.end = b.end;
                    last.last_point = b.last_point;
                    break;
                }
            }
            out.push(b);
        }
    }
    let removed = range.len() - out.len();
    pieces.splice(range, out);
    removed
}

/// Appends a piece, merging it into the last one when it continues it.
pub(super) fn push(pieces: &mut Vec<Piece>, edge: EdgeId, start: f32, end: f32, pa: u32, pb: u32) {
    if (end - start).abs() < 1e-6 {
        return;
    }
    let reverse = end < start;
    if let Some(last) = pieces.last_mut()
        && last.edge == edge
        && last.reverse == reverse
        && (last.end - start).abs() < 1e-4
    {
        last.end = end;
        last.last_point = pb;
        return;
    }
    pieces.push(Piece {
        edge,
        reverse,
        start,
        end,
        first_point: pa,
        last_point: pb,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::grid;

    #[test]
    fn spurs_and_jitter_are_removed() {
        let built = grid(5, 5, 100.0).build();
        let g = &built.graph;
        let (e0, e1, side) = (built.edge(0), built.edge(1), built.edge(20 + 4));
        let pc = |edge, start: f32, end: f32| Piece {
            edge,
            reverse: end < start,
            start,
            end,
            first_point: 0,
            last_point: 1,
        };
        // along e0, 10 m into a side edge and back, back 5 m on e0 and on again, then e1
        let mut pieces = vec![
            pc(e0, 0.0, 1.0),
            pc(side, 0.0, 0.1),
            pc(side, 0.1, 0.0),
            pc(e1, 0.0, 0.5),
            pc(e1, 0.5, 0.45),
            pc(e1, 0.45, 1.0),
        ];
        let removed = remove_spurs(g, &mut pieces, 0..6, 30.0);
        assert_eq!(removed, 4);
        assert_eq!(pieces, vec![pc(e0, 0.0, 1.0), pc(e1, 0.0, 1.0)]);
        // a real turn-back (60 m) stays
        let mut pieces = vec![pc(e0, 0.0, 0.6), pc(e0, 0.6, 0.0)];
        assert_eq!(remove_spurs(g, &mut pieces, 0..2, 30.0), 0);
    }

    #[test]
    fn pushed_pieces_merge_when_they_continue() {
        let mut v = Vec::new();
        push(&mut v, 3, 0.0, 0.4, 1, 2);
        push(&mut v, 3, 0.4, 1.0, 2, 3);
        push(&mut v, 3, 1.0, 1.0, 3, 3); // empty: ignored
        push(&mut v, 3, 1.0, 0.5, 3, 4); // turns back: a new piece
        assert_eq!(v.len(), 2);
        assert!((v[0].end - 1.0).abs() < 1e-6 && v[0].last_point == 3);
        assert!(v[1].reverse);
    }
}
