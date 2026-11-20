//! The Hilbert curve on the web-mercator tile grid, exactly as the pipeline computes `hilbert_z16`
//! (`finalize.hilbert_d`, classic xy2d): the key of a z16 tile shifted right by `2 · (16 − z)` is the
//! key of its zoom-z parent, so the graph tiles are runs of the sorted edges.

/// The zoom the pipeline's `hilbert_z16` key is computed at.
pub const KEY_ZOOM: u8 = 16;

fn rot(n: u32, x: &mut u32, y: &mut u32, rx: u32, ry: u32) {
    if ry == 0 {
        if rx == 1 {
            *x = n - 1 - *x;
            *y = n - 1 - *y;
        }
        std::mem::swap(x, y);
    }
}

/// Hilbert index of tile (x, y) on the 2^order grid.
#[must_use]
pub fn xy_to_d(order: u8, mut x: u32, mut y: u32) -> u64 {
    let n = 1u32 << order;
    let mut d = 0u64;
    let mut s = n / 2;
    while s > 0 {
        let rx = u32::from(x & s > 0);
        let ry = u32::from(y & s > 0);
        d += u64::from(s) * u64::from(s) * u64::from((3 * rx) ^ ry);
        rot(n, &mut x, &mut y, rx, ry);
        s /= 2;
    }
    d
}

/// The tile (x, y) of a Hilbert index on the 2^order grid.
#[must_use]
#[allow(clippy::cast_possible_truncation, reason = "the masked bits fit")]
pub fn d_to_xy(order: u8, d: u64) -> (u32, u32) {
    let n = 1u32 << order;
    let (mut x, mut y) = (0u32, 0u32);
    let mut t = d;
    let mut s = 1u32;
    while s < n {
        let rx = (1 & (t / 2)) as u32;
        let ry = (1 & (t ^ u64::from(rx))) as u32;
        rot(s, &mut x, &mut y, rx, ry);
        x += s * rx;
        y += s * ry;
        t /= 4;
        s *= 2;
    }
    (x, y)
}

/// The web-mercator tile of a coordinate at `zoom` (clamped to the grid, like the pipeline).
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to the tile grid before the cast"
)]
pub fn tile_of(lng: f64, lat: f64, zoom: u8) -> (u32, u32) {
    let n = f64::from(1u32 << zoom);
    let x = ((lng + 180.0) / 360.0 * n).floor();
    let lr = lat.to_radians();
    let y = ((1.0 - (lr.tan() + 1.0 / lr.cos()).ln() / std::f64::consts::PI) / 2.0 * n).floor();
    (x.clamp(0.0, n - 1.0) as u32, y.clamp(0.0, n - 1.0) as u32)
}

/// The tile at `zoom` (≤ 16) that a `hilbert_z16` key lies in.
#[must_use]
pub fn tile_of_key(key: u32, zoom: u8) -> (u32, u32) {
    d_to_xy(zoom, u64::from(key) >> (2 * u32::from(KEY_ZOOM - zoom)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_one_is_a_u() {
        let d: Vec<u64> = [(0, 0), (0, 1), (1, 1), (1, 0)]
            .iter()
            .map(|&(x, y)| xy_to_d(1, x, y))
            .collect();
        assert_eq!(d, vec![0, 1, 2, 3]);
    }

    #[test]
    fn roundtrips_and_prefixes() {
        for (x, y) in [(0, 0), (12345, 54321), (65535, 0), (32768, 32768), (40000, 27000)] {
            let d = xy_to_d(16, x, y);
            assert_eq!(d_to_xy(16, d), (x, y));
            for zoom in [8u8, 10, 11, 12, 14] {
                let shift = 16 - zoom;
                assert_eq!(d >> (2 * shift), xy_to_d(zoom, x >> shift, y >> shift), "z{zoom}");
                #[allow(clippy::cast_possible_truncation, reason = "a z16 key fits in u32")]
                let key = d as u32;
                assert_eq!(tile_of_key(key, zoom), (x >> shift, y >> shift));
            }
        }
    }

    #[test]
    fn tiles_of_known_points() {
        // the pipeline's test values (`test_z16_tile_of_known_points`)
        assert_eq!(tile_of(0.0, 0.0, 16), (32768, 32768));
        assert_eq!(tile_of(-180.0, 0.0, 16), (0, 32768));
        assert_eq!(tile_of(179.999, 0.0, 16), (65535, 32768));
        assert_eq!(tile_of(0.0, 0.0, 0), (0, 0));
    }
}
