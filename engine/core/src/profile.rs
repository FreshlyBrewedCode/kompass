//! Profiles and the cost function: cost = length × (product of positive factors, clamped to the
//! profile's `[min_factor, max_factor]`) + climb + barriers. Hard constraints and one-way give an
//! infinite cost. The clamp is what makes `min_factor × straight-line distance` a valid A* bound.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_lossless,
    clippy::many_single_char_names,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::chunks_exact_to_as_chunks,
    clippy::too_many_lines,
    reason = "spike #4: graph ids and counts fit in u32 by construction (≤ 2^32 nodes / arcs); quantisation casts are deliberate"
)]

use crate::graph::{Graph, bits};

/// Highway class codes (the pipeline's `HIGHWAY` table).
pub mod hw {
    pub const TRUNK: u8 = 1;
    pub const TERTIARY_LINK: u8 = 8;
    pub const UNCLASSIFIED: u8 = 9;
    pub const RESIDENTIAL: u8 = 10;
    pub const ROAD: u8 = 13;
    pub const TRACK: u8 = 14;
    pub const PATH: u8 = 15;
    pub const CYCLEWAY: u8 = 16;
    pub const FOOTWAY: u8 = 17;
    pub const BRIDLEWAY: u8 = 18;
    pub const COUNT: usize = 22;
}

const INF: f32 = f32::INFINITY;

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub name: String,
    /// Factor per highway class; infinite = forbidden.
    pub highway: [f32; hw::COUNT],
    /// Factor per surface class (index 0 unused: unknown surfaces are inferred first).
    pub surface: [f32; 7],
    /// Extra factor when `smoothness` is bad or worse.
    pub smoothness_bad: f32,
    /// Factor per `bike_access` code; infinite = forbidden.
    pub bike_access: [f32; 11],
    /// Weight of the traffic proxy on motor roads without a separate cycle track: the factor is
    /// `1 + traffic × class weight × speed weight`.
    pub traffic: f32,
    /// Factor per `cycleway_kind`.
    pub cycleway: [f32; 6],
    /// Factor on a signed bicycle route.
    pub route: f32,
    /// Factors at a 100 % share (interpolated linearly with the share).
    pub forest: f32,
    pub forest_edge: f32,
    pub water: f32,
    pub builtup: f32,
    pub road_near: f32,
    /// Cost metres per metre of ascent.
    pub climb: f32,
    /// Factor for stretches steeper than `steep_pct` (uphill in the riding direction).
    pub steep_pct: u8,
    pub steep: f32,
    /// Highest allowed `sac_scale` / `mtb_scale` code (0 = unknown is always allowed).
    pub max_sac: u8,
    pub max_mtb: u8,
    /// Cost metres per barrier (gate, bollard, …).
    pub barrier: f32,
    /// Clamp of the factor product. `min_factor` is the A* lower bound per metre.
    pub min_factor: f32,
    pub max_factor: f32,
}

impl Profile {
    /// Gravel first: forest tracks and compacted gravel are bonuses, main roads are expensive.
    #[must_use]
    pub fn gravel_explorer() -> Profile {
        Profile {
            name: "gravel-explorer".into(),
            #[rustfmt::skip]
            highway: [
                1.5, INF, INF, 4.0, 4.0, 2.2, 2.2, 1.5, 1.5, 1.15, 1.2,
                1.2, 1.15, 1.3, 0.9, 1.0, 1.05, 1.4, 1.1, INF, 1.6, INF,
            ],
            surface: [1.0, 1.1, 1.15, 0.85, 0.9, 1.15, 1.3],
            smoothness_bad: 1.3,
            bike_access: [1.0, 1.0, 0.95, 1.0, 1.1, 1.3, 1.5, 1.6, 1.1, INF, INF],
            traffic: 2.0,
            cycleway: [1.0, 1.0, 0.95, 0.9, 1.0, 0.9],
            route: 0.95,
            forest: 0.75,
            forest_edge: 0.9,
            water: 0.9,
            builtup: 1.25,
            road_near: 1.15,
            climb: 4.0,
            steep_pct: 18,
            steep: 1.5,
            max_sac: 2,
            max_mtb: 3,
            barrier: 30.0,
            min_factor: 0.5,
            max_factor: 20.0,
        }
    }

    /// Smooth surfaces and little traffic: unpaved is expensive, separate cycle paths are cheap.
    #[must_use]
    pub fn paved_quiet() -> Profile {
        Profile {
            name: "paved-quiet".into(),
            #[rustfmt::skip]
            highway: [
                1.5, INF, INF, 3.0, 3.0, 1.8, 1.8, 1.3, 1.3, 1.0, 1.05,
                1.1, 1.2, 1.3, 1.1, 1.2, 0.9, 1.5, 2.0, INF, 1.5, INF,
            ],
            surface: [1.0, 1.0, 1.4, 1.6, 2.5, 4.0, 2.0],
            smoothness_bad: 1.5,
            bike_access: [1.0, 1.0, 0.9, 1.0, 1.1, 1.0, 1.5, 2.0, 1.2, INF, INF],
            traffic: 3.0,
            cycleway: [1.0, 0.95, 0.9, 0.85, 0.85, 0.85],
            route: 0.9,
            forest: 0.95,
            forest_edge: 1.0,
            water: 0.95,
            builtup: 1.1,
            road_near: 1.05,
            climb: 6.0,
            steep_pct: 12,
            steep: 2.0,
            max_sac: 1,
            max_mtb: 2,
            barrier: 20.0,
            min_factor: 0.7,
            max_factor: 20.0,
        }
    }

    /// Cost of traversing edge `e` along (`dir = 0`) or against (`dir = 1`) its geometry.
    #[inline]
    #[must_use]
    pub fn arc_cost(&self, g: &Graph, e: usize, dir: u32) -> f32 {
        let f = self.edge_factor(g, e);
        if f.is_infinite() {
            return INF;
        }
        self.directed(g, e, dir, f)
    }

    #[inline]
    fn directed(&self, g: &Graph, e: usize, dir: u32, factor: f32) -> f32 {
        let oneway = g.surf[e] & (bits::ONEWAY_FWD | bits::ONEWAY_BWD);
        let (blocked, ascent_dm, grade) = if dir == 0 {
            (oneway == bits::ONEWAY_BWD, g.ascent_fwd_dm[e], g.grade_fwd[e])
        } else {
            (oneway == bits::ONEWAY_FWD, g.ascent_bwd_dm[e], g.grade_bwd[e])
        };
        if blocked {
            return INF;
        }
        let steep = if grade > self.steep_pct { self.steep } else { 1.0 };
        let f = (factor * steep).clamp(self.min_factor, self.max_factor);
        let barriers = f32::from(g.diff[e] >> 6);
        g.length_m(e) * f + self.climb * f32::from(ascent_dm) * 0.1 + self.barrier * barriers
    }

    /// The direction-independent factor product of edge `e` (infinite if forbidden).
    #[inline]
    #[must_use]
    pub fn edge_factor(&self, g: &Graph, e: usize) -> f32 {
        let class = g.highway[e];
        let surf = g.surf[e];
        let access = g.access[e];
        let diff = g.diff[e];
        let sac = (diff >> 3) & 7;
        let mtb = diff & 7;
        let mut f = self.highway[usize::from(class)] * self.bike_access[usize::from(access & 15)];
        if f.is_infinite() || sac > self.max_sac || mtb > self.max_mtb {
            return INF;
        }
        let ctx = g.ctx[e];
        let builtup = share(ctx >> 12);
        let surface_class = match surf & 7 {
            0 => infer_surface(class, (surf >> 3) & 7, builtup),
            s => s,
        };
        f *= self.surface[usize::from(surface_class)];
        if (g.smooth[e] & 15) >= 4 {
            f *= self.smoothness_bad;
        }
        let road = g.road[e];
        let cycleway = road & 7;
        f *= self.cycleway[usize::from(cycleway)];
        if (road >> 3) & 7 != 0 {
            f *= self.route;
        }
        if (hw::TRUNK..=hw::ROAD).contains(&class) && cycleway < 3 {
            f *= 1.0 + self.traffic * traffic_weight(class, g.speed[e], builtup);
        }
        f *= lerp(self.forest, share(ctx));
        f *= lerp(self.forest_edge, share(ctx >> 4));
        f *= lerp(self.water, share(ctx >> 8));
        f *= lerp(self.builtup, builtup);
        f *= lerp(self.road_near, share(u16::from(g.ctx2[e])));
        f
    }

    /// Compiles the cost of every arc (`costs[e << 1 | dir]`).
    pub fn compile_into(&self, g: &Graph, costs: &mut Vec<f32>) {
        costs.clear();
        costs.reserve(g.edge_count() * 2);
        for e in 0..g.edge_count() {
            let f = self.edge_factor(g, e);
            if f.is_infinite() {
                costs.extend([INF, INF]);
            } else {
                costs.extend([self.directed(g, e, 0, f), self.directed(g, e, 1, f)]);
            }
        }
    }

    #[must_use]
    pub fn compile(&self, g: &Graph) -> Vec<f32> {
        let mut costs = Vec::new();
        self.compile_into(g, &mut costs);
        costs
    }
}

/// A share stored in sixteenths (low 4 bits) as 0..=1.
#[inline]
fn share(nibble: u16) -> f32 {
    f32::from(nibble & 15) * (1.0 / 15.0)
}

#[inline]
fn lerp(at_full: f32, share: f32) -> f32 {
    1.0 + (at_full - 1.0) * share
}

/// The likely surface class of an edge without a surface tag.
#[must_use]
pub fn infer_surface(class: u8, tracktype: u8, builtup: f32) -> u8 {
    match class {
        hw::TRACK => match tracktype {
            1 => 1,
            2 => 3,
            4 | 5 => 5,
            _ => 4,
        },
        hw::PATH | hw::FOOTWAY | hw::BRIDLEWAY => {
            if builtup > 0.5 {
                1
            } else {
                5
            }
        }
        _ => 1,
    }
}

/// 0..=1: how much traffic a motor road likely carries (class × speed; unknown speeds default
/// by class and built-up context).
#[must_use]
pub fn traffic_weight(class: u8, speed: u8, builtup: f32) -> f32 {
    let class_w = match class {
        1..=4 => 1.0,
        5 | 6 => 0.8,
        7 | 8 => 0.5,
        hw::UNCLASSIFIED => 0.3,
        hw::RESIDENTIAL | hw::ROAD => 0.1,
        _ => 0.05,
    };
    let kmh = match speed & 31 {
        0 if class <= hw::TERTIARY_LINK => {
            if builtup > 0.5 {
                50.0
            } else {
                100.0
            }
        }
        0 => {
            if builtup > 0.5 {
                30.0
            } else {
                70.0
            }
        }
        s => f32::from(s) * 5.0,
    };
    let lanes = speed >> 5;
    let lanes_w = if lanes >= 4 { 1.5 } else { 1.0 };
    (class_w * ((kmh - 30.0) / 70.0).clamp(0.0, 1.0) * lanes_w).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::grid;

    #[test]
    fn costs_respect_the_clamp_and_one_way() {
        let g = grid();
        for p in [Profile::gravel_explorer(), Profile::paved_quiet()] {
            let costs = p.compile(&g);
            for e in 0..g.edge_count() {
                for d in 0..2 {
                    let c = costs[e * 2 + d];
                    assert_eq!(c.to_bits(), p.arc_cost(&g, e, d as u32).to_bits());
                    if c.is_finite() {
                        assert!(c >= g.length_m(e) * p.min_factor);
                    }
                }
            }
            // the top row is one-way along its geometry (edges 10 and 11)
            assert!(costs[10 * 2].is_finite() && costs[10 * 2 + 1].is_infinite());
        }
    }

    #[test]
    fn the_profiles_disagree_about_gravel() {
        let g = grid();
        let gravel = Profile::gravel_explorer().compile(&g)[0];
        let paved = Profile::paved_quiet().compile(&g)[0];
        assert!(gravel < paved);
    }

    #[test]
    fn hard_constraints_forbid() {
        let mut g = grid();
        g.access[0] = 10; // bicycle=no
        g.highway[1] = 19; // steps
        let costs = Profile::gravel_explorer().compile(&g);
        assert!(costs[0].is_infinite() && costs[1].is_infinite() && costs[2].is_infinite());
    }
}
