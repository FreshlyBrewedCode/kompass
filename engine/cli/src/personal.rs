//! `--personal <explored.json>` for the measuring commands (`replay`, `sensitivity`): the personal
//! layer from an explored map as `kompass match --explored` writes it (`{ "graphBuild", "edges": {
//! "<id>": { "count", "lastRidden" } } }`), for the build it was matched on. The file holds the
//! rider's real history: keep it in gitignored or temporary directories.

use kompass_core::{EdgeId, Planner};

use crate::Failure;

/// Sets the planner's personal layer from an explored map (today as the reference day).
#[allow(clippy::cast_possible_truncation, reason = "days and counts fit")]
pub(crate) fn load(planner: &mut Planner, file: &str) -> Result<(), Failure> {
    let text = std::fs::read_to_string(file)?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| Failure::Run(format!("{file}: {e}")))?;
    let build = &planner.graph().info().build_id;
    if let Some(b) = v.get("graphBuild").and_then(serde_json::Value::as_str)
        && b != build
    {
        return Err(Failure::Run(format!(
            "{file}: matched on build {b}, the graph is {build}"
        )));
    }
    let today = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
        / 86_400) as u32;
    let edges = planner.graph().edge_count();
    let mut layer = kompass_core::PersonalLayer::empty(edges, today);
    for (k, x) in v
        .get("edges")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
    {
        let e: EdgeId = k
            .parse()
            .map_err(|_| Failure::Run(format!("{file}: edge id {k}")))?;
        let n = x.get("count").and_then(serde_json::Value::as_u64).unwrap_or(0);
        let day = x
            .get("lastRidden")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            / 86_400_000;
        if (e as usize) < edges {
            layer.rides[e as usize] = n.min(u64::from(u16::MAX)) as u16;
            layer.last_ridden[e as usize] = day as u32;
        }
    }
    planner
        .set_personal(Some(layer))
        .map_err(|e| Failure::Run(e.message))
}
