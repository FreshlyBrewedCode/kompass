//! The traffic model: how much motor traffic a way carries, 0..=1, and how much of it a way beside
//! a road gets (`docs/profile.md`, "Traffic"). `quiet` penalises it.
//!
//! The one definition. The pipeline needs the same level for the roads beside every way (the
//! `road_near_traffic` column of `edges.parquet`), so [`table_json`] writes these numbers with
//! worked examples to `pipeline/src/kompass_pipeline/traffic.json` (`bun run gen:engine`); a test of
//! the CLI fails when that file is stale, and the pipeline's tests check its formula against the
//! examples.

use serde_json::{Value, json};

use crate::attrs::{Highway, MotorAccess};

/// The class factor by `highway` code (0: no motor traffic of its own).
pub const CLASS: [f32; 22] = [
    0.0,  // other
    1.0,  // trunk
    1.0,  // trunk_link
    0.9,  // primary
    0.9,  // primary_link
    0.7,  // secondary
    0.7,  // secondary_link
    0.45, // tertiary
    0.45, // tertiary_link
    0.25, // unclassified
    0.12, // residential
    0.03, // living_street
    0.05, // service
    0.2,  // road
    0.02, // track
    0.0,  // path
    0.0,  // cycleway
    0.0,  // footway
    0.0,  // bridleway
    0.0,  // steps
    0.0,  // pedestrian
    0.0,  // ferry
];

/// The speed factor rises linearly from `SPEED_FLOOR` at `SPEED_FROM_KMH` to 1 at `SPEED_TO_KMH`.
pub const SPEED_FLOOR: f32 = 0.4;
pub const SPEED_FROM_KMH: f32 = 30.0;
pub const SPEED_TO_KMH: f32 = 100.0;
/// The graph keeps speed limits in steps of this (rounded, at least one step, saturating at 155).
pub const SPEED_STEP_KMH: u8 = 5;
/// Lanes: ×`LANES_3` for 3, ×`LANES_4` for 4 or more (unknown counts as 2).
pub const LANES_3: f32 = 1.15;
pub const LANES_4: f32 = 1.3;

/// The motor-access factor by `motor_access` code: closed to cars or agricultural only, or
/// destination / private traffic only.
pub const MOTOR: [f32; 7] = [
    1.0, // unknown
    0.1, // no
    0.1, // agri_forestry
    0.4, // destination
    0.4, // private
    1.0, // permissive
    1.0, // yes
];

/// Cycling infrastructure on the road itself, by `cycleway_kind` code: how much of the road's
/// traffic a rider on it gets (a separate path is a way of its own: see [`ALONGSIDE`]).
pub const SEPARATION: [f32; 6] = [
    1.0,  // none
    0.9,  // shared_lane
    0.75, // lane
    0.35, // track
    1.0,  // separate_path (tagged on a road: no separation from it)
    0.4,  // bicycle_road
];

/// How much of the traffic of the roads within 20 m a way beside them gets, in full when all of
/// it is near them: a little less than a cycle track tagged on the road (`SEPARATION` 0.35), since
/// the 20 m band also holds paths behind a verge or a hedge. A path in the band can never be louder
/// than riding the same road's cycle track, and a road's own band (which holds the road itself)
/// never raises its own level.
pub const ALONGSIDE: f32 = 0.3;

/// The speed limit the model assumes where none is tagged, by `highway` code: (outside, built-up).
#[must_use]
pub fn guess_kmh(hw: u8) -> (f32, f32) {
    match hw {
        1..=8 => (100.0, 50.0),
        9 | 13 => (70.0, 50.0),
        10 => (40.0, 40.0),
        11 => (10.0, 10.0),
        12 => (25.0, 25.0),
        14 => (30.0, 30.0),
        _ => (0.0, 0.0),
    }
}

/// The speed factor at a speed limit, km/h.
#[must_use]
pub fn speed_factor(kmh: f32) -> f32 {
    SPEED_FLOOR
        + (1.0 - SPEED_FLOOR) * ((kmh - SPEED_FROM_KMH) / (SPEED_TO_KMH - SPEED_FROM_KMH)).clamp(0.0, 1.0)
}

/// The lanes factor (`lanes` 0 unknown).
#[must_use]
pub fn lanes_factor(lanes: u8) -> f32 {
    match lanes {
        0..=2 => 1.0,
        3 => LANES_3,
        _ => LANES_4,
    }
}

/// The traffic a road carries before separation and the cap: class × speed × lanes × motor access.
/// `kmh` is the speed limit as the graph keeps it (0 unknown: guessed by class and `built`).
#[must_use]
pub fn road_raw(hw: u8, kmh: u8, lanes: u8, motor: u8, built: bool) -> f32 {
    let class = CLASS.get(usize::from(hw)).copied().unwrap_or(0.0);
    if class == 0.0 {
        return 0.0;
    }
    let kmh = if kmh != 0 {
        f32::from(kmh)
    } else {
        let (open, town) = guess_kmh(hw);
        if built { town } else { open }
    };
    let motor = MOTOR.get(usize::from(motor)).copied().unwrap_or(1.0);
    class * speed_factor(kmh) * lanes_factor(lanes) * motor
}

/// The traffic level of a road for the ways beside it, 0..=1 (no separation: that is the rider's
/// on the road): what the pipeline rasterises for `road_near_traffic`.
#[must_use]
pub fn road_level(hw: u8, kmh: u8, lanes: u8, motor: u8, built: bool) -> f32 {
    road_raw(hw, kmh, lanes, motor, built).min(1.0)
}

/// The traffic level of riding a way, 0..=1: its own traffic, less the separation of a cycle
/// track, lane or bicycle road on it.
#[must_use]
pub fn own_level(hw: u8, kmh: u8, lanes: u8, motor: u8, built: bool, cycleway: u8) -> f32 {
    let sep = SEPARATION.get(usize::from(cycleway)).copied().unwrap_or(1.0);
    (road_raw(hw, kmh, lanes, motor, built) * sep).min(1.0)
}

/// The traffic a way gets from the roads beside it: their level (`road_near_traffic`, over the part
/// within 20 m) × the share of the way within 20 m of them × [`ALONGSIDE`].
#[must_use]
pub fn alongside(near_traffic: f32, near_share: f32) -> f32 {
    (near_traffic * near_share * ALONGSIDE).clamp(0.0, 1.0)
}

/// A speed limit in km/h as the graph keeps it: rounded to 5 km/h steps, at least one, at most 155.
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to 1..=31"
)]
pub fn graph_kmh(kmh: f32) -> u8 {
    ((kmh / f32::from(SPEED_STEP_KMH)).round().clamp(1.0, 31.0) as u8) * SPEED_STEP_KMH
}

/// The model as data for the pipeline (`traffic.json`): every factor by label, and examples of
/// [`road_level`] to check a reimplementation against.
#[must_use]
pub fn table_json() -> String {
    // f32 constants as their short decimal (0.9, not 0.8999999761581421)
    let num = |x: f32| json!((f64::from(x) * 1e6).round() / 1e6);
    let hw_label = |c: u8| Highway::from_code(c).map_or("?", Highway::label);
    let motor_label = |c: u8| MotorAccess::from_code(c).map_or("?", MotorAccess::label);
    #[allow(clippy::cast_possible_truncation, reason = "22 codes")]
    let roads: Vec<u8> = (0..CLASS.len() as u8)
        .filter(|&c| CLASS[usize::from(c)] > 0.0)
        .collect();
    let class: serde_json::Map<String, Value> = roads
        .iter()
        .map(|&c| (hw_label(c).to_owned(), num(CLASS[usize::from(c)])))
        .collect();
    let guess: serde_json::Map<String, Value> = roads
        .iter()
        .map(|&c| {
            let (open, town) = guess_kmh(c);
            (
                hw_label(c).to_owned(),
                json!({ "outside": num(open), "built_up": num(town) }),
            )
        })
        .collect();
    #[allow(clippy::cast_possible_truncation, reason = "7 codes")]
    let motor: serde_json::Map<String, Value> = (0..MOTOR.len() as u8)
        .map(|c| (motor_label(c).to_owned(), num(MOTOR[usize::from(c)])))
        .collect();
    // examples: every road class at a spread of speeds, lanes, access and built-up
    let speeds: [Option<u8>; 6] = [None, Some(30), Some(48), Some(70), Some(100), Some(130)];
    let lanes: [Option<u8>; 4] = [None, Some(2), Some(3), Some(5)];
    let mut examples = Vec::new();
    let mut k = 0usize;
    for &hw in &roads {
        for (i, &kmh) in speeds.iter().enumerate() {
            for built in [false, true] {
                let ln = lanes[(k + i) % lanes.len()];
                #[allow(clippy::cast_possible_truncation, reason = "7 codes")]
                let mo = (k % MOTOR.len()) as u8;
                k += 1;
                let level = road_level(
                    hw,
                    kmh.map_or(0, |v| graph_kmh(f32::from(v))),
                    ln.unwrap_or(0),
                    mo,
                    built,
                );
                examples.push(json!({
                    "highway": hw_label(hw),
                    "maxspeed_kmh": kmh,
                    "lanes": ln,
                    "motor_access": motor_label(mo),
                    "built_up": built,
                    "level": num(level),
                }));
            }
        }
    }
    let v = json!({
        "about": "Generated by `bun run gen:engine` from engine/core/src/traffic.rs (the one definition); do not edit. \
                  level = min(1, class × speed × lanes × motor access); speed = floor + (1 − floor) × clamp((kmh − from) / (to − from), 0, 1), \
                  kmh rounded to steps (at least one step, at most 31), unknown kmh guessed by class and built-up; \
                  lanes: 3 → lanes_3, 4 or more → lanes_4, else 1.",
        "class": class,
        "guess_kmh": guess,
        "speed": {
            "floor": num(SPEED_FLOOR),
            "from_kmh": num(SPEED_FROM_KMH),
            "to_kmh": num(SPEED_TO_KMH),
            "step_kmh": SPEED_STEP_KMH,
        },
        "lanes_3": num(LANES_3),
        "lanes_4": num(LANES_4),
        "motor": motor,
        "alongside": num(ALONGSIDE),
        "examples": examples,
    });
    let mut out = serde_json::to_string_pretty(&v).expect("a table serialises");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_levels_order_as_the_profile_doc_says() {
        // a primary outside towns at an unknown limit: 0.9 × 1 (100 km/h)
        assert!((road_level(3, 0, 0, 0, false) - 0.9).abs() < 1e-6);
        // in town 50 km/h
        let town = road_level(3, 0, 0, 0, true);
        assert!((town - 0.9 * (0.4 + 0.6 * 20.0 / 70.0)).abs() < 1e-6);
        // the cap
        assert!((road_level(1, 130, 4, 0, false) - 1.0).abs() < 1e-6);
        // riding the road with a cycle track vs a path fully beside it
        let primary = road_level(3, 100, 2, 0, false);
        let track = own_level(3, 100, 2, 0, false, 3);
        let path = alongside(primary, 1.0);
        assert!(path < track && track < primary, "{path} {track} {primary}");
        // paths have no traffic of their own
        assert!(own_level(15, 0, 0, 0, false, 0) == 0.0 && own_level(16, 0, 0, 0, false, 4) == 0.0);
    }

    #[test]
    fn graph_kmh_is_the_packing_of_the_speed_column() {
        assert_eq!(graph_kmh(48.0), 50);
        assert_eq!(graph_kmh(1.0), 5);
        assert_eq!(graph_kmh(250.0), 155);
    }
}
