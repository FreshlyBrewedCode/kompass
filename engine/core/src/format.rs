//! The `KMPG` container every graph file uses (`docs/graph-format.md`): a 16-byte header, a section
//! table, then the sections, each one column of one primitive type, 8-byte aligned, little endian.
//! Read with safe slice copies only.

use std::fmt;

/// The four bytes every graph file starts with.
pub const MAGIC: [u8; 4] = *b"KMPG";

/// The graph format version. Bumped for every change a reader has to know about (layout, packing,
/// enum codes).
pub const FORMAT_VERSION: u16 = 3;

/// What a container holds (header bytes 6..8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum FileKind {
    /// The region: counts, bounds, build id, the tile table.
    Index = 1,
    /// One tile's nodes and edges.
    Graph = 2,
    /// One tile's edge geometry and OSM way references.
    Geometry = 3,
}

impl FileKind {
    fn from_u16(v: u16) -> Option<FileKind> {
        match v {
            1 => Some(FileKind::Index),
            2 => Some(FileKind::Graph),
            3 => Some(FileKind::Geometry),
            _ => None,
        }
    }
}

/// A file that is not a valid graph file (or does not belong to the graph being loaded).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError(pub String);

impl FormatError {
    pub fn new(msg: impl Into<String>) -> FormatError {
        FormatError(msg.into())
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "graph format: {}", self.0)
    }
}

impl std::error::Error for FormatError {}

/// A section name: 8 ASCII bytes, padded with `_`.
pub type Name = [u8; 8];

/// A primitive that a section holds, little endian.
pub trait Le: Copy + Default {
    const SIZE: usize;
    fn put(self, out: &mut Vec<u8>);
    fn get(bytes: &[u8]) -> Self;
}

macro_rules! le {
    ($($t:ty),+) => {$(
        impl Le for $t {
            const SIZE: usize = std::mem::size_of::<$t>();
            #[inline]
            fn put(self, out: &mut Vec<u8>) {
                out.extend_from_slice(&self.to_le_bytes());
            }
            #[inline]
            fn get(bytes: &[u8]) -> Self {
                let mut b = [0u8; std::mem::size_of::<$t>()];
                b.copy_from_slice(bytes);
                <$t>::from_le_bytes(b)
            }
        }
    )+};
}

le!(u8, u16, u32, u64, i32);

const HEADER: usize = 16;
const ENTRY: usize = 24;

/// Writes a container.
#[derive(Debug)]
pub struct Writer {
    kind: FileKind,
    sections: Vec<(Name, Vec<u8>)>,
}

impl Writer {
    #[must_use]
    pub fn new(kind: FileKind) -> Writer {
        Writer {
            kind,
            sections: Vec::new(),
        }
    }

    /// Adds a section of raw bytes.
    pub fn bytes(&mut self, name: Name, data: &[u8]) {
        self.sections.push((name, data.to_vec()));
    }

    /// Adds a section holding `values`, little endian.
    pub fn put<T: Le>(&mut self, name: Name, values: &[T]) {
        let mut data = Vec::with_capacity(values.len() * T::SIZE);
        for &v in values {
            v.put(&mut data);
        }
        self.sections.push((name, data));
    }

    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a file has far fewer than 2^32 sections"
    )]
    pub fn finish(self) -> Vec<u8> {
        let table_end = HEADER + self.sections.len() * ENTRY;
        let total = self
            .sections
            .iter()
            .fold(table_end.next_multiple_of(8), |at, (_, d)| {
                (at + d.len()).next_multiple_of(8)
            });
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&(self.kind as u16).to_le_bytes());
        out.extend_from_slice(&(self.sections.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut offset = table_end.next_multiple_of(8);
        for (name, data) in &self.sections {
            out.extend_from_slice(name);
            out.extend_from_slice(&(offset as u64).to_le_bytes());
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            offset = (offset + data.len()).next_multiple_of(8);
        }
        for (_, data) in &self.sections {
            out.resize(out.len().next_multiple_of(8), 0);
            out.extend_from_slice(data);
        }
        out.resize(out.len().next_multiple_of(8), 0);
        out
    }
}

/// Reads a container (borrowing its bytes; sections are copied out on request).
#[derive(Debug)]
pub struct Reader<'a> {
    bytes: &'a [u8],
    table: Vec<(Name, usize, usize)>,
}

fn name_str(name: Name) -> String {
    String::from_utf8_lossy(&name).trim_end_matches('_').to_owned()
}

impl<'a> Reader<'a> {
    /// Checks the header (magic, version, kind) and the section table.
    pub fn new(bytes: &'a [u8], kind: FileKind) -> Result<Reader<'a>, FormatError> {
        if bytes.len() < HEADER || bytes[0..4] != MAGIC {
            return Err(FormatError::new("not a graph file (bad magic)"));
        }
        let version = u16::get(&bytes[4..6]);
        if version != FORMAT_VERSION {
            return Err(FormatError(format!(
                "format version {version} is not supported (this engine reads {FORMAT_VERSION})"
            )));
        }
        let got = FileKind::from_u16(u16::get(&bytes[6..8]));
        if got != Some(kind) {
            return Err(FormatError(format!("expected a {kind:?} file, got {got:?}")));
        }
        let count = u32::get(&bytes[8..12]) as usize;
        let mut table = Vec::with_capacity(count.min(1024));
        for i in 0..count {
            let at = HEADER + i * ENTRY;
            let entry = bytes
                .get(at..at + ENTRY)
                .ok_or_else(|| FormatError::new("truncated section table"))?;
            let mut name = [0u8; 8];
            name.copy_from_slice(&entry[0..8]);
            let off = usize::try_from(u64::get(&entry[8..16])).unwrap_or(usize::MAX);
            let len = usize::try_from(u64::get(&entry[16..24])).unwrap_or(usize::MAX);
            if off.checked_add(len).is_none_or(|end| end > bytes.len()) {
                return Err(FormatError(format!("section {} out of bounds", name_str(name))));
            }
            table.push((name, off, len));
        }
        Ok(Reader { bytes, table })
    }

    /// A section's raw bytes.
    pub fn bytes(&self, name: Name) -> Result<&'a [u8], FormatError> {
        self.table
            .iter()
            .find(|(n, _, _)| *n == name)
            .map(|&(_, off, len)| &self.bytes[off..off + len])
            .ok_or_else(|| FormatError(format!("missing section {}", name_str(name))))
    }

    /// A section as a vector of `T`.
    pub fn vec<T: Le>(&self, name: Name) -> Result<Vec<T>, FormatError> {
        let b = self.bytes(name)?;
        if b.len() % T::SIZE != 0 {
            return Err(FormatError(format!(
                "section {} has a partial value",
                name_str(name)
            )));
        }
        Ok(b.chunks_exact(T::SIZE).map(T::get).collect())
    }

    /// Copies a section into `out`, which must have exactly its length.
    pub fn read_into<T: Le>(&self, name: Name, out: &mut [T]) -> Result<(), FormatError> {
        let b = self.bytes(name)?;
        if b.len() != out.len() * T::SIZE {
            return Err(FormatError(format!(
                "section {} holds {} bytes, expected {}",
                name_str(name),
                b.len(),
                out.len() * T::SIZE
            )));
        }
        for (o, c) in out.iter_mut().zip(b.chunks_exact(T::SIZE)) {
            *o = T::get(c);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_roundtrips() {
        let mut w = Writer::new(FileKind::Graph);
        w.put(*b"a_______", &[1u16, 2, 3]);
        w.bytes(*b"b_______", b"hello");
        w.put(*b"c_______", &[-5i32, 7]);
        let bytes = w.finish();
        assert_eq!(bytes.len() % 8, 0);
        let r = Reader::new(&bytes, FileKind::Graph).unwrap();
        assert_eq!(r.vec::<u16>(*b"a_______").unwrap(), vec![1, 2, 3]);
        assert_eq!(r.bytes(*b"b_______").unwrap(), b"hello");
        let mut c = [0i32; 2];
        r.read_into(*b"c_______", &mut c).unwrap();
        assert_eq!(c, [-5, 7]);
        assert!(r.read_into(*b"c_______", &mut [0i32; 3]).is_err());
        assert!(
            r.bytes(*b"zz______")
                .unwrap_err()
                .0
                .contains("missing section zz")
        );
    }

    #[test]
    fn rejects_foreign_or_broken_files() {
        let bytes = Writer::new(FileKind::Index).finish();
        assert!(Reader::new(&bytes, FileKind::Index).is_ok());
        assert!(
            Reader::new(&bytes, FileKind::Graph)
                .unwrap_err()
                .0
                .contains("expected a Graph")
        );
        assert!(Reader::new(b"PK\x03\x04 not a graph", FileKind::Index).is_err());
        let mut newer = bytes.clone();
        newer[4] = 99;
        assert!(
            Reader::new(&newer, FileKind::Index)
                .unwrap_err()
                .0
                .contains("version 99")
        );
        // a section pointing past the end
        let mut w = Writer::new(FileKind::Graph);
        w.bytes(*b"a_______", &[1, 2, 3]);
        let mut bad = w.finish();
        bad.truncate(HEADER + ENTRY);
        assert!(
            Reader::new(&bad, FileKind::Graph)
                .unwrap_err()
                .0
                .contains("out of bounds")
        );
    }
}
