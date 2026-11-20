//! Edge geometry, kept apart from the graph (the search does not need it): per edge one record of
//! varints, the number of interior points, each interior point as a zigzag delta in 1e-6 degrees
//! from the previous one (starting at the `from` node), then the OSM way: zigzag `way_id`,
//! `way_pos_from`, zigzag `way_pos_to − way_pos_from`. The end nodes come from the graph. The way
//! comes last so that walking the points (snapping, drawing) never decodes it.

/// The OSM way an edge comes from and its nodes' positions in it (corrections are stored this way,
/// so they survive rebuilds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WayRef {
    pub way_id: i64,
    pub pos_from: u16,
    pub pos_to: u16,
}

/// No record for this edge (its geometry tile is not loaded).
pub(crate) const NONE: u32 = u32::MAX;

#[inline]
#[allow(clippy::cast_sign_loss, reason = "zigzag maps signed to unsigned by design")]
fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

#[inline]
#[allow(
    clippy::cast_possible_wrap,
    reason = "zigzag maps unsigned back to signed by design"
)]
fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

#[allow(clippy::cast_possible_truncation, reason = "low seven bits per byte")]
fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// Reads a varint; a truncated one ends at the end of `b` (never panics).
#[inline]
fn get_varint(b: &[u8], at: &mut usize) -> u64 {
    let mut v = 0u64;
    let mut shift = 0;
    while let Some(&byte) = b.get(*at) {
        *at += 1;
        if shift < 64 {
            v |= u64::from(byte & 0x7f) << shift;
        }
        if byte < 0x80 {
            break;
        }
        shift += 7;
    }
    v
}

/// 1e-7 → 1e-6 degrees, rounded half up.
#[inline]
fn e6(v: i32) -> i32 {
    (v + 5).div_euclid(10)
}

/// Appends one edge's record.
pub fn encode(out: &mut Vec<u8>, from: (i32, i32), way: WayRef, interior: &[(i32, i32)]) {
    put_varint(out, interior.len() as u64);
    let (mut px, mut py) = (e6(from.0), e6(from.1));
    for &(x, y) in interior {
        let (x, y) = (e6(x), e6(y));
        put_varint(out, zigzag(i64::from(x) - i64::from(px)));
        put_varint(out, zigzag(i64::from(y) - i64::from(py)));
        (px, py) = (x, y);
    }
    put_varint(out, zigzag(way.way_id));
    put_varint(out, u64::from(way.pos_from));
    put_varint(out, zigzag(i64::from(way.pos_to) - i64::from(way.pos_from)));
}

/// The way reference at the end of a record, and the record's length.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "positions are u16 in the source data"
)]
fn decode_way(b: &[u8]) -> (WayRef, usize) {
    let mut at = 0;
    let n = get_varint(b, &mut at);
    for _ in 0..n.saturating_mul(2).min(b.len() as u64) {
        get_varint(b, &mut at);
    }
    let way_id = unzigzag(get_varint(b, &mut at));
    let pos_from = get_varint(b, &mut at) as u16;
    let pos_to = (i64::from(pos_from) + unzigzag(get_varint(b, &mut at))) as u16;
    (
        WayRef {
            way_id,
            pos_from,
            pos_to,
        },
        at,
    )
}

/// The byte length of the record at the start of `rec`.
pub(crate) fn record_len(rec: &[u8]) -> usize {
    decode_way(rec).1
}

/// The records of every edge with loaded geometry: one byte stream, an offset per edge. Equal when
/// every edge has the same record (whatever order the tiles were loaded in).
#[derive(Debug, Clone, Default)]
pub struct Geometry {
    pub(crate) offsets: Vec<u32>,
    pub(crate) bytes: Vec<u8>,
}

impl PartialEq for Geometry {
    fn eq(&self, other: &Geometry) -> bool {
        fn rec(g: &Geometry, e: usize) -> Option<&[u8]> {
            g.record(e).map(|r| &r[..record_len(r)])
        }
        self.offsets.len() == other.offsets.len()
            && (0..self.offsets.len()).all(|e| rec(self, e) == rec(other, e))
    }
}

impl Eq for Geometry {}

impl Geometry {
    pub(crate) fn with_edges(edges: usize) -> Geometry {
        Geometry {
            offsets: vec![NONE; edges],
            bytes: Vec::new(),
        }
    }

    #[inline]
    pub(crate) fn record(&self, e: usize) -> Option<&[u8]> {
        let off = *self.offsets.get(e)?;
        (off != NONE).then(|| &self.bytes[off as usize..])
    }

    pub(crate) fn way(&self, e: usize) -> Option<WayRef> {
        let b = self.record(e)?;
        Some(decode_way(b).0)
    }

    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.offsets.capacity() * 4 + self.bytes.capacity()
    }
}

/// The points of an edge from `from` to `to` in 1e-7 degrees (interior points at 1e-6 precision):
/// both end nodes, plus the interior points when the geometry is loaded. Allocation-free.
#[derive(Debug, Clone)]
pub struct EdgePoints<'a> {
    bytes: &'a [u8],
    at: usize,
    remaining: u32,
    cur: (i32, i32),
    from: (i32, i32),
    to: (i32, i32),
    state: u8,
}

impl<'a> EdgePoints<'a> {
    pub(crate) fn new(from: (i32, i32), to: (i32, i32), record: Option<&'a [u8]>) -> EdgePoints<'a> {
        let mut at = 0;
        let (bytes, remaining) = match record {
            Some(b) => (b, u32::try_from(get_varint(b, &mut at)).unwrap_or(0)),
            None => (&[][..], 0),
        };
        EdgePoints {
            bytes,
            at,
            remaining,
            cur: (e6(from.0), e6(from.1)),
            from,
            to,
            state: 0,
        }
    }
}

impl Iterator for EdgePoints<'_> {
    type Item = (i32, i32);

    #[inline]
    #[allow(
        clippy::cast_possible_truncation,
        reason = "deltas of valid coordinates fit in i32"
    )]
    fn next(&mut self) -> Option<(i32, i32)> {
        match self.state {
            0 => {
                self.state = 1;
                Some(self.from)
            }
            1 if self.remaining > 0 => {
                self.remaining -= 1;
                let dx = unzigzag(get_varint(self.bytes, &mut self.at));
                let dy = unzigzag(get_varint(self.bytes, &mut self.at));
                self.cur = (
                    (i64::from(self.cur.0) + dx) as i32,
                    (i64::from(self.cur.1) + dy) as i32,
                );
                Some((self.cur.0.saturating_mul(10), self.cur.1.saturating_mul(10)))
            }
            1 => {
                self.state = 2;
                Some(self.to)
            }
            _ => None,
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = match self.state {
            0 => self.remaining as usize + 2,
            1 => self.remaining as usize + 1,
            _ => 0,
        };
        (n, Some(n))
    }
}

impl ExactSizeIterator for EdgePoints<'_> {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_and_zigzag() {
        for v in [0i64, 1, -1, 63, -64, 1 << 40, -(1 << 40), i64::MAX, i64::MIN] {
            assert_eq!(unzigzag(zigzag(v)), v);
            let mut out = Vec::new();
            put_varint(&mut out, zigzag(v));
            assert_eq!(get_varint(&out, &mut 0), zigzag(v));
        }
        // truncated input does not panic
        assert_eq!(get_varint(&[0x80, 0x80], &mut 0), 0);
    }

    #[test]
    fn records_roundtrip() {
        let mut bytes = Vec::new();
        let way = WayRef {
            way_id: 123_456_789_012,
            pos_from: 7,
            pos_to: 3,
        };
        let interior = [(15, -25), (-1_000_004, 2_000_006)];
        encode(&mut bytes, (4, -4), way, &interior);
        assert_eq!(decode_way(&bytes), (way, bytes.len()));
        let pts: Vec<_> = EdgePoints::new((4, -4), (99, 99), Some(&bytes)).collect();
        assert_eq!(pts, vec![(4, -4), (20, -20), (-1_000_000, 2_000_010), (99, 99)]);
        let straight: Vec<_> = EdgePoints::new((4, -4), (99, 99), None).collect();
        assert_eq!(straight, vec![(4, -4), (99, 99)]);
        assert_eq!(EdgePoints::new((0, 0), (1, 1), Some(&bytes)).len(), 4);
    }
}
