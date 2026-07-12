use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct SparseIndex {
    pub segment_id: u64,
    pub generation: u32,
    pub source_bytes: u64,
    pub stride: usize,
    pub sequence_offsets: BTreeMap<u64, u64>,
    pub account_windows: BTreeMap<String, Vec<(u64, u64, u64)>>,
    pub time_windows: BTreeMap<i64, (u64, u64, u64, u64)>,
    pub identity_buckets: BTreeMap<u64, Vec<(u64, u64)>>,
    pub index_checksum: u64,
}

impl SparseIndex {
    pub fn rebuild(
        index_path: &Path,
        segment_id: u64,
        generation: u32,
        source_bytes: u64,
        stride: usize,
        rows: &[(u64, u64, i64, String, String)],
    ) -> Result<(Self, Vec<String>), String> {
        if segment_id == 0 {
            return Err("cannot index the reserved segment id zero".to_owned());
        }
        if stride == 0 {
            return Err("sparse index stride must be greater than zero".to_owned());
        }
        let mut diagnostics = Vec::new();
        let mut sequence_offsets = BTreeMap::new();
        let mut account_windows: BTreeMap<String, Vec<(u64, u64, u64)>> = BTreeMap::new();
        let mut time_windows: BTreeMap<i64, (u64, u64, u64, u64)> = BTreeMap::new();
        let mut identity_buckets: BTreeMap<u64, Vec<(u64, u64)>> = BTreeMap::new();
        let mut previous_sequence = None;
        let mut previous_offset = None;
        let mut seen_sequences = BTreeSet::new();
        let mut seen_identities = BTreeSet::new();
        let mut account_open: BTreeMap<String, (u64, u64, u64, usize)> = BTreeMap::new();
        let mut indexed_rows = 0usize;
        for (ordinal, row) in rows.iter().enumerate() {
            let (sequence, byte_offset, timestamp_ms, account, identity) = row;
            if *sequence == 0 {
                diagnostics.push(format!("row {ordinal} has reserved sequence zero"));
                continue;
            }
            if account.is_empty() {
                diagnostics.push(format!("row {ordinal} has an empty account"));
                continue;
            }
            if identity.is_empty() {
                diagnostics.push(format!("row {ordinal} has an empty identity"));
                continue;
            }
            if *byte_offset >= source_bytes {
                diagnostics.push(format!(
                    "row {ordinal} offset {byte_offset} is outside source length {source_bytes}"
                ));
                continue;
            }
            if !seen_sequences.insert(*sequence) {
                diagnostics.push(format!("row {ordinal} repeats sequence {sequence}"));
                continue;
            }
            if !seen_identities.insert(identity.clone()) {
                diagnostics.push(format!("identity {identity} appears more than once"));
            }
            if let Some(previous) = previous_sequence {
                if *sequence <= previous {
                    diagnostics.push(format!(
                        "sequence regressed from {previous} to {sequence} at row {ordinal}"
                    ));
                } else if *sequence > previous.saturating_add(1) {
                    diagnostics.push(format!(
                        "sequence gap {}..{} before row {ordinal}",
                        previous.saturating_add(1),
                        sequence.saturating_sub(1)
                    ));
                }
            }
            if let Some(previous) = previous_offset {
                if *byte_offset < previous {
                    diagnostics.push(format!(
                        "byte offset regressed from {previous} to {byte_offset} at row {ordinal}"
                    ));
                }
            }
            if indexed_rows.is_multiple_of(stride) {
                sequence_offsets.insert(*sequence, *byte_offset);
            }
            let bucket_width = 60_000i64;
            let bucket = timestamp_ms.div_euclid(bucket_width) * bucket_width;
            time_windows
                .entry(bucket)
                .and_modify(|window| {
                    window.0 = window.0.min(*sequence);
                    window.1 = window.1.max(*sequence);
                    window.2 = window.2.min(*byte_offset);
                    window.3 = window.3.max(*byte_offset);
                })
                .or_insert((*sequence, *sequence, *byte_offset, *byte_offset));
            let identity_bytes = identity.as_bytes();
            let mut identity_hash = 0x9e3779b185ebca87u64;
            for byte in identity_bytes {
                identity_hash ^= *byte as u64;
                identity_hash = identity_hash
                    .rotate_left(7)
                    .wrapping_mul(0xc2b2ae3d27d4eb4f);
                identity_hash ^= identity_hash >> 33;
            }
            let fingerprint = identity_hash ^ ((identity_bytes.len() as u64) << 48);
            let bucket_key = identity_hash >> 12;
            identity_buckets
                .entry(bucket_key)
                .or_default()
                .push((fingerprint, *sequence));
            match account_open.get_mut(account) {
                Some(window) => {
                    let contiguous_sequence = *sequence == window.1.saturating_add(1);
                    let close_offset = byte_offset.saturating_sub(window.2) > 4 * 1024 * 1024;
                    let too_many_rows = window.3 >= stride.saturating_mul(8);
                    if contiguous_sequence && !close_offset && !too_many_rows {
                        window.1 = *sequence;
                        window.3 = window.3.saturating_add(1);
                    } else {
                        account_windows
                            .entry(account.clone())
                            .or_default()
                            .push((window.0, window.1, window.2));
                        *window = (*sequence, *sequence, *byte_offset, 1);
                    }
                }
                None => {
                    account_open.insert(account.clone(), (*sequence, *sequence, *byte_offset, 1));
                }
            }
            previous_sequence = Some(*sequence);
            previous_offset = Some(*byte_offset);
            indexed_rows = indexed_rows.saturating_add(1);
        }
        for (account, (first, last, offset, _)) in account_open {
            account_windows
                .entry(account)
                .or_default()
                .push((first, last, offset));
        }
        for windows in account_windows.values_mut() {
            windows.sort_unstable_by_key(|window| (window.0, window.2));
            let mut compacted: Vec<(u64, u64, u64)> = Vec::with_capacity(windows.len());
            for window in windows.drain(..) {
                match compacted.last_mut() {
                    Some(previous)
                        if window.0 <= previous.1.saturating_add(1)
                            && window.2.saturating_sub(previous.2) <= 8 * 1024 * 1024 =>
                    {
                        previous.1 = previous.1.max(window.1);
                    }
                    _ => compacted.push(window),
                }
            }
            *windows = compacted;
        }
        for values in identity_buckets.values_mut() {
            values.sort_unstable_by_key(|entry| (entry.0, entry.1));
            values.dedup();
        }
        if let Some((last_sequence, _)) = rows.last().map(|row| (row.0, row.1)) {
            if !sequence_offsets.contains_key(&last_sequence) {
                if let Some(row) = rows.iter().rev().find(|row| row.0 == last_sequence) {
                    sequence_offsets.insert(row.0, row.1);
                }
            }
        }
        let mut encoded = Vec::new();
        encoded.extend_from_slice(b"BJIX");
        encoded.extend_from_slice(&2u16.to_le_bytes());
        encoded.extend_from_slice(&0u16.to_le_bytes());
        encoded.extend_from_slice(&segment_id.to_le_bytes());
        encoded.extend_from_slice(&generation.to_le_bytes());
        encoded.extend_from_slice(&(stride as u32).to_le_bytes());
        encoded.extend_from_slice(&source_bytes.to_le_bytes());
        encoded.extend_from_slice(&(indexed_rows as u64).to_le_bytes());
        encoded.extend_from_slice(&(sequence_offsets.len() as u32).to_le_bytes());
        encoded.extend_from_slice(&(account_windows.len() as u32).to_le_bytes());
        encoded.extend_from_slice(&(time_windows.len() as u32).to_le_bytes());
        encoded.extend_from_slice(&(identity_buckets.len() as u32).to_le_bytes());
        for (sequence, offset) in &sequence_offsets {
            encoded.extend_from_slice(&sequence.to_le_bytes());
            encoded.extend_from_slice(&offset.to_le_bytes());
        }
        for (account, windows) in &account_windows {
            if account.len() > u16::MAX as usize {
                return Err(format!(
                    "account name is too long to index: {} bytes",
                    account.len()
                ));
            }
            encoded.extend_from_slice(&(account.len() as u16).to_le_bytes());
            encoded.extend_from_slice(account.as_bytes());
            encoded.extend_from_slice(&(windows.len() as u32).to_le_bytes());
            for (first, last, offset) in windows {
                encoded.extend_from_slice(&first.to_le_bytes());
                encoded.extend_from_slice(&last.to_le_bytes());
                encoded.extend_from_slice(&offset.to_le_bytes());
            }
        }
        for (bucket, window) in &time_windows {
            encoded.extend_from_slice(&bucket.to_le_bytes());
            encoded.extend_from_slice(&window.0.to_le_bytes());
            encoded.extend_from_slice(&window.1.to_le_bytes());
            encoded.extend_from_slice(&window.2.to_le_bytes());
            encoded.extend_from_slice(&window.3.to_le_bytes());
        }
        for (bucket, values) in &identity_buckets {
            encoded.extend_from_slice(&bucket.to_le_bytes());
            encoded.extend_from_slice(&(values.len() as u32).to_le_bytes());
            for (fingerprint, sequence) in values {
                encoded.extend_from_slice(&fingerprint.to_le_bytes());
                encoded.extend_from_slice(&sequence.to_le_bytes());
            }
        }
        let mut index_checksum = 0xa0761d6478bd642fu64;
        for byte in &encoded {
            index_checksum ^= *byte as u64;
            index_checksum = index_checksum
                .rotate_left(21)
                .wrapping_mul(0xe7037ed1a0b428db);
            index_checksum ^= index_checksum >> 27;
        }
        encoded.extend_from_slice(&index_checksum.to_le_bytes());
        if let Some(parent) = index_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create index directory {}: {error}", parent.display()))?;
        }
        let extension = index_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("idx");
        let temporary_path = index_path.with_extension(format!("{extension}.building"));
        let mut temporary = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| {
                format!(
                    "create temporary index {}: {error}",
                    temporary_path.display()
                )
            })?;
        temporary
            .write_all(&encoded)
            .and_then(|_| temporary.sync_all())
            .map_err(|error| {
                format!(
                    "write temporary index {}: {error}",
                    temporary_path.display()
                )
            })?;
        drop(temporary);
        if index_path.exists() {
            let backup_path = index_path.with_extension(format!("{extension}.previous"));
            if backup_path.exists() {
                std::fs::remove_file(&backup_path).map_err(|error| {
                    format!("remove old index backup {}: {error}", backup_path.display())
                })?;
            }
            std::fs::rename(index_path, &backup_path)
                .map_err(|error| format!("backup index {}: {error}", index_path.display()))?;
            match std::fs::rename(&temporary_path, index_path) {
                Ok(()) => {
                    if let Err(error) = std::fs::remove_file(&backup_path) {
                        diagnostics.push(format!(
                            "could not remove index backup {}: {error}",
                            backup_path.display()
                        ));
                    }
                }
                Err(error) => {
                    let _ = std::fs::rename(&backup_path, index_path);
                    return Err(format!(
                        "activate rebuilt index {}: {error}",
                        index_path.display()
                    ));
                }
            }
        } else {
            std::fs::rename(&temporary_path, index_path).map_err(|error| {
                format!("activate rebuilt index {}: {error}", index_path.display())
            })?;
        }
        if let Some(parent) = index_path.parent() {
            if let Ok(directory) = File::open(parent) {
                if let Err(error) = directory.sync_all() {
                    diagnostics.push(format!(
                        "could not sync index directory {}: {error}",
                        parent.display()
                    ));
                }
            }
        }
        Ok((
            Self {
                segment_id,
                generation,
                source_bytes,
                stride,
                sequence_offsets,
                account_windows,
                time_windows,
                identity_buckets,
                index_checksum,
            },
            diagnostics,
        ))
    }

    pub fn seek(
        &self,
        account: Option<&str>,
        first_sequence: Option<u64>,
        last_sequence: Option<u64>,
        first_timestamp_ms: Option<i64>,
        last_timestamp_ms: Option<i64>,
        identity: Option<&str>,
    ) -> Vec<(u64, u64)> {
        let sequence_floor = first_sequence.unwrap_or(1);
        let sequence_ceiling = last_sequence.unwrap_or(u64::MAX);
        if sequence_floor > sequence_ceiling {
            return Vec::new();
        }
        let mut candidates: BTreeMap<u64, u64> = BTreeMap::new();
        let lower_anchor = self
            .sequence_offsets
            .range(..=sequence_floor)
            .next_back()
            .map(|(sequence, offset)| (*sequence, *offset));
        if let Some((sequence, offset)) = lower_anchor {
            candidates.insert(sequence, offset);
        }
        for (sequence, offset) in self
            .sequence_offsets
            .range(sequence_floor..=sequence_ceiling)
        {
            candidates.insert(*sequence, *offset);
        }
        if candidates.is_empty() {
            if let Some((sequence, offset)) = self.sequence_offsets.iter().next() {
                candidates.insert(*sequence, *offset);
            }
        }
        if let Some(account) = account {
            let mut account_candidates = BTreeMap::new();
            if let Some(windows) = self.account_windows.get(account) {
                for (window_first, window_last, window_offset) in windows {
                    if *window_last < sequence_floor || *window_first > sequence_ceiling {
                        continue;
                    }
                    let anchor = self
                        .sequence_offsets
                        .range(..=*window_first)
                        .next_back()
                        .map(|(sequence, offset)| (*sequence, *offset))
                        .unwrap_or((*window_first, *window_offset));
                    account_candidates.insert(anchor.0, anchor.1.min(*window_offset));
                    for (sequence, offset) in self.sequence_offsets.range(
                        (*window_first).max(sequence_floor)..=(*window_last).min(sequence_ceiling),
                    ) {
                        account_candidates.insert(*sequence, *offset);
                    }
                }
            }
            candidates.retain(|sequence, _| {
                account_candidates
                    .range(..=*sequence)
                    .next_back()
                    .is_some_and(|(anchor, _)| {
                        sequence.saturating_sub(*anchor) <= (self.stride as u64) * 8
                    })
            });
            for (sequence, offset) in account_candidates {
                candidates.entry(sequence).or_insert(offset);
            }
        }
        if first_timestamp_ms.is_some() || last_timestamp_ms.is_some() {
            let timestamp_floor = first_timestamp_ms.unwrap_or(i64::MIN);
            let timestamp_ceiling = last_timestamp_ms.unwrap_or(i64::MAX);
            if timestamp_floor > timestamp_ceiling {
                return Vec::new();
            }
            let bucket_floor = timestamp_floor.div_euclid(60_000) * 60_000;
            let bucket_ceiling = timestamp_ceiling.div_euclid(60_000) * 60_000;
            let mut time_ranges = Vec::new();
            for (_, window) in self.time_windows.range(bucket_floor..=bucket_ceiling) {
                if window.1 >= sequence_floor && window.0 <= sequence_ceiling {
                    time_ranges.push((
                        window.0.max(sequence_floor),
                        window.1.min(sequence_ceiling),
                        window.2,
                    ));
                }
            }
            candidates.retain(|sequence, _| {
                time_ranges.iter().any(|range| {
                    *sequence >= range.0.saturating_sub(self.stride as u64) && *sequence <= range.1
                })
            });
            for (first, _, offset) in time_ranges {
                let anchor = self
                    .sequence_offsets
                    .range(..=first)
                    .next_back()
                    .map(|(sequence, position)| (*sequence, *position))
                    .unwrap_or((first, offset));
                candidates.entry(anchor.0).or_insert(anchor.1.min(offset));
            }
        }
        if let Some(identity) = identity {
            let mut identity_hash = 0x9e3779b185ebca87u64;
            for byte in identity.as_bytes() {
                identity_hash ^= *byte as u64;
                identity_hash = identity_hash
                    .rotate_left(7)
                    .wrapping_mul(0xc2b2ae3d27d4eb4f);
                identity_hash ^= identity_hash >> 33;
            }
            let fingerprint = identity_hash ^ ((identity.len() as u64) << 48);
            let possible_sequences = self
                .identity_buckets
                .get(&(identity_hash >> 12))
                .map(|values| {
                    values
                        .iter()
                        .filter(|entry| entry.0 == fingerprint)
                        .map(|entry| entry.1)
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();
            if possible_sequences.is_empty() {
                return Vec::new();
            }
            candidates.retain(|sequence, _| {
                possible_sequences.iter().any(|candidate| {
                    *sequence <= *candidate
                        && candidate.saturating_sub(*sequence) <= self.stride as u64
                })
            });
            for sequence in possible_sequences {
                if sequence < sequence_floor || sequence > sequence_ceiling {
                    continue;
                }
                if let Some((anchor, offset)) = self.sequence_offsets.range(..=sequence).next_back()
                {
                    candidates.insert(*anchor, *offset);
                }
            }
        }
        let mut output = Vec::new();
        let mut previous: Option<(u64, u64)> = None;
        for (sequence, offset) in candidates {
            match previous {
                Some((previous_sequence, previous_offset))
                    if sequence.saturating_sub(previous_sequence) <= self.stride as u64
                        && offset.saturating_sub(previous_offset) <= 64 * 1024 =>
                {
                    previous = Some((previous_sequence, previous_offset));
                }
                Some(value) => {
                    output.push(value);
                    previous = Some((sequence, offset));
                }
                None => previous = Some((sequence, offset)),
            }
        }
        if let Some(value) = previous {
            output.push(value);
        }
        output
    }
}
