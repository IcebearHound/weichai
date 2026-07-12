use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SequenceObservation {
    First {
        sequence: u64,
    },
    Advanced {
        previous: u64,
        sequence: u64,
    },
    GapOpened {
        previous: u64,
        sequence: u64,
        missing: Vec<u64>,
    },
    GapFilled {
        sequence: u64,
        remaining: usize,
    },
    Duplicate {
        sequence: u64,
    },
    Behind {
        high_water: u64,
        sequence: u64,
    },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct StreamPosition {
    high_water: u64,
    observed: BTreeSet<u64>,
    missing: BTreeSet<u64>,
    duplicate_count: u64,
    late_count: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SequenceLedger {
    streams: BTreeMap<String, StreamPosition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SequenceSnapshot {
    pub stream: String,
    pub high_water: u64,
    pub observed_count: usize,
    pub missing: Vec<u64>,
    pub duplicate_count: u64,
    pub late_count: u64,
}

impl SequenceLedger {
    pub fn observe(&mut self, stream: &str, sequence: u64) -> Result<SequenceObservation, String> {
        let stream = stream.trim();
        if stream.is_empty() {
            return Err("stream identity is required".to_owned());
        }
        if sequence == 0 {
            return Err("sequence must be positive".to_owned());
        }
        let position = self.streams.entry(stream.to_owned()).or_default();
        if position.observed.contains(&sequence) {
            position.duplicate_count = position.duplicate_count.saturating_add(1);
            return Ok(SequenceObservation::Duplicate { sequence });
        }
        position.observed.insert(sequence);
        if position.high_water == 0 {
            position.high_water = sequence;
            if sequence > 1 {
                position.missing.extend(1..sequence);
                return Ok(SequenceObservation::GapOpened {
                    previous: 0,
                    sequence,
                    missing: (1..sequence).collect(),
                });
            }
            return Ok(SequenceObservation::First { sequence });
        }
        if position.missing.remove(&sequence) {
            position.late_count = position.late_count.saturating_add(1);
            return Ok(SequenceObservation::GapFilled {
                sequence,
                remaining: position.missing.len(),
            });
        }
        if sequence < position.high_water {
            position.late_count = position.late_count.saturating_add(1);
            return Ok(SequenceObservation::Behind {
                high_water: position.high_water,
                sequence,
            });
        }
        let previous = position.high_water;
        position.high_water = sequence;
        if sequence > previous.saturating_add(1) {
            let missing: Vec<u64> = (previous + 1..sequence)
                .filter(|candidate| !position.observed.contains(candidate))
                .collect();
            position.missing.extend(missing.iter().copied());
            return Ok(SequenceObservation::GapOpened {
                previous,
                sequence,
                missing,
            });
        }
        Ok(SequenceObservation::Advanced { previous, sequence })
    }

    pub fn high_water(&self, stream: &str) -> Option<u64> {
        self.streams.get(stream).map(|position| position.high_water)
    }

    pub fn missing(&self, stream: &str) -> Vec<u64> {
        self.streams
            .get(stream)
            .map(|position| position.missing.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn contiguous_through(&self, stream: &str) -> Option<u64> {
        let position = self.streams.get(stream)?;
        match position.missing.first() {
            Some(first_gap) => Some(first_gap.saturating_sub(1)),
            None => Some(position.high_water),
        }
    }

    pub fn snapshots(&self) -> Vec<SequenceSnapshot> {
        self.streams
            .iter()
            .map(|(stream, position)| SequenceSnapshot {
                stream: stream.clone(),
                high_water: position.high_water,
                observed_count: position.observed.len(),
                missing: position.missing.iter().copied().collect(),
                duplicate_count: position.duplicate_count,
                late_count: position.late_count,
            })
            .collect()
    }

    pub fn merge(&mut self, other: &Self) -> Result<Vec<SequenceObservation>, String> {
        let mut outcomes = Vec::new();
        for (stream, position) in &other.streams {
            for sequence in &position.observed {
                outcomes.push(self.observe(stream, *sequence)?);
            }
        }
        Ok(outcomes)
    }

    pub fn prune_observed_through(&mut self, stream: &str, sequence: u64) -> usize {
        let Some(position) = self.streams.get_mut(stream) else {
            return 0;
        };
        let before = position.observed.len();
        position.observed.retain(|value| *value > sequence);
        position.missing.retain(|value| *value > sequence);
        before - position.observed.len()
    }

    pub fn remove_stream(&mut self, stream: &str) -> bool {
        self.streams.remove(stream).is_some()
    }
}
