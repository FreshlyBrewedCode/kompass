//! A minimal GPX reader for the CLI: every `<trkpt lat lon>` with its `<time>` (the browser has its
//! own, `web/src/rides/gpx.ts`). No XML library: a scan for the tags it needs.

use kompass_core::LngLat;

#[derive(Debug, Clone, Default)]
pub struct Track {
    pub points: Vec<LngLat>,
    /// Milliseconds since the Unix epoch, per point (`None` where a point has no time).
    pub times: Vec<Option<f64>>,
}

fn attr(tag: &str, name: &str) -> Option<f64> {
    let mut rest = tag;
    while let Some(i) = rest.find(name) {
        let before = rest[..i].chars().next_back();
        let after = &rest[i + name.len()..];
        if before.is_none_or(char::is_whitespace) && after.trim_start().starts_with('=') {
            let v = after.trim_start()[1..].trim_start();
            let q = v.chars().next()?;
            let v = &v[1..];
            return v[..v.find(q)?].trim().parse().ok();
        }
        rest = after;
    }
    None
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]` into milliseconds since the epoch.
#[must_use]
#[allow(
    clippy::many_single_char_names,
    reason = "the date fields: y, mo, d, h, mi, se"
)]
pub fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut rest = &s[19..];
    let mut frac = 0.0;
    if let Some(r) = rest.strip_prefix('.') {
        let n = r.find(|c: char| !c.is_ascii_digit()).unwrap_or(r.len());
        frac = format!("0.{}", &r[..n]).parse().ok()?;
        rest = &r[n..];
    }
    let offset_min = match rest.chars().next() {
        None | Some('Z' | 'z') => 0,
        Some(c @ ('+' | '-')) => {
            let oh: i64 = rest.get(1..3)?.parse().ok()?;
            let om: i64 = rest.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
            let m = oh * 60 + om;
            if c == '-' { -m } else { m }
        }
        _ => return None,
    };
    // days from civil (Howard Hinnant)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    #[allow(clippy::cast_precision_loss, reason = "epoch milliseconds fit f64 exactly")]
    Some(secs as f64 * 1000.0 + frac * 1000.0)
}

/// Reads every track point of a GPX document.
#[must_use]
pub fn parse(text: &str) -> Track {
    let mut t = Track::default();
    let mut rest = text;
    while let Some(i) = rest.find("<trkpt") {
        rest = &rest[i + 6..];
        let Some(close) = rest.find('>') else { break };
        let tag = &rest[..close];
        let (Some(lat), Some(lon)) = (attr(tag, "lat"), attr(tag, "lon")) else {
            continue;
        };
        let body_end = if tag.ends_with('/') {
            0
        } else {
            rest.find("</trkpt").unwrap_or(rest.len())
        };
        let body = &rest[close..body_end.max(close)];
        let time = body
            .find("<time>")
            .and_then(|a| body[a + 6..].find("</time>").map(|b| &body[a + 6..a + 6 + b]))
            .and_then(parse_time);
        t.points.push(LngLat { lng: lon, lat });
        t.times.push(time);
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_points_and_times() {
        let doc = r#"<gpx><trk><trkseg>
            <trkpt lat="0.1" lon="0.2"><ele>3</ele><time>2020-01-01T00:00:01Z</time></trkpt>
            <trkpt lon='0.3' lat='0.4'/>
            <trkpt lat="0.5" lon="0.6"><time>2020-01-01T01:00:01.500+01:00</time></trkpt>
        </trkseg></trk></gpx>"#;
        let t = parse(doc);
        assert_eq!(t.points.len(), 3);
        assert!((t.points[1].lng - 0.3).abs() < 1e-12 && (t.points[1].lat - 0.4).abs() < 1e-12);
        assert_eq!(t.times[0], Some(1_577_836_801_000.0));
        assert_eq!(t.times[1], None);
        assert_eq!(t.times[2], Some(1_577_836_801_500.0));
    }
}
