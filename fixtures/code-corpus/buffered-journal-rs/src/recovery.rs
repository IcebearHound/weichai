use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::codec::JournalCodec;
use crate::domain::{Durability, SegmentDescriptor, SegmentState};
use crate::segment::SegmentFile;

pub struct RecoveryScanner {
    pub codec: JournalCodec,
    pub durability: Durability,
    pub maximum_segment_bytes: u64,
    pub temporary_file_grace: Duration,
    pub accept_generation: std::ops::RangeInclusive<u32>,
}

impl RecoveryScanner {
    pub fn scan(
        &self,
        directory: &Path,
        repair: bool,
    ) -> Result<(Vec<SegmentDescriptor>, Vec<String>), String> {
        if self.maximum_segment_bytes < 4_096 {
            return Err("recovery maximum segment size is below one page".to_owned());
        }
        if !directory.exists() {
            if repair {
                std::fs::create_dir_all(directory).map_err(|error| {
                    format!("create recovery directory {}: {error}", directory.display())
                })?;
                return Ok((
                    Vec::new(),
                    vec!["created missing journal directory".to_owned()],
                ));
            }
            return Err(format!(
                "journal directory {} does not exist",
                directory.display()
            ));
        }
        if !directory.is_dir() {
            return Err(format!(
                "journal path {} is not a directory",
                directory.display()
            ));
        }
        let mut diagnostics = Vec::new();
        let mut segment_paths = BTreeMap::new();
        let mut temporary_paths = Vec::new();
        let mut unrecognized_paths = Vec::new();
        let entries = std::fs::read_dir(directory)
            .map_err(|error| format!("read journal directory {}: {error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("read journal directory entry: {error}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("inspect {}: {error}", path.display()))?;
            if file_type.is_dir() {
                if entry.file_name() != "quarantine" && entry.file_name() != "indexes" {
                    diagnostics.push(format!("ignored subdirectory {}", path.display()));
                }
                continue;
            }
            if !file_type.is_file() {
                diagnostics.push(format!("ignored non-file entry {}", path.display()));
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".compacting")
                || name.ends_with(".writing")
                || name.ends_with(".previous")
                || name.ends_with(".repairing")
            {
                temporary_paths.push(path);
                continue;
            }
            if !name.ends_with(".bjseg") || !name.starts_with("segment-") {
                unrecognized_paths.push(path);
                continue;
            }
            let stem = name.trim_end_matches(".bjseg");
            let rest = stem.trim_start_matches("segment-");
            let Some((id_text, generation_text)) = rest.rsplit_once("-g") else {
                diagnostics.push(format!("segment filename {name} lacks generation suffix"));
                unrecognized_paths.push(path);
                continue;
            };
            let segment_id = match id_text.parse::<u64>() {
                Ok(value) if value > 0 => value,
                Ok(_) => {
                    diagnostics.push(format!("segment filename {name} uses reserved id zero"));
                    unrecognized_paths.push(path);
                    continue;
                }
                Err(error) => {
                    diagnostics.push(format!("segment filename {name} has invalid id: {error}"));
                    unrecognized_paths.push(path);
                    continue;
                }
            };
            let generation = match generation_text.parse::<u32>() {
                Ok(value) => value,
                Err(error) => {
                    diagnostics.push(format!(
                        "segment filename {name} has invalid generation: {error}"
                    ));
                    unrecognized_paths.push(path);
                    continue;
                }
            };
            if !self.accept_generation.contains(&generation) {
                diagnostics.push(format!(
                    "segment {segment_id} generation {generation} is outside accepted range {:?}",
                    self.accept_generation
                ));
                unrecognized_paths.push(path);
                continue;
            }
            if let Some(previous) = segment_paths.insert(segment_id, (generation, path.clone())) {
                let keep_new = generation > previous.0;
                if keep_new {
                    diagnostics.push(format!(
                        "segment {segment_id} has generations {} and {generation}; selected newer",
                        previous.0
                    ));
                    unrecognized_paths.push(previous.1);
                } else {
                    diagnostics.push(format!(
                        "segment {segment_id} generation {generation} is not newer than {}",
                        previous.0
                    ));
                    segment_paths.insert(segment_id, previous);
                    unrecognized_paths.push(path);
                }
            }
        }
        let now = SystemTime::now();
        for path in temporary_paths {
            let age = path
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| now.duration_since(modified).ok())
                .unwrap_or(Duration::ZERO);
            if age < self.temporary_file_grace {
                diagnostics.push(format!(
                    "left recent temporary {} aged {:?}",
                    path.display(),
                    age
                ));
                continue;
            }
            if repair {
                let quarantine = directory.join("quarantine");
                std::fs::create_dir_all(&quarantine).map_err(|error| {
                    format!(
                        "create quarantine directory {}: {error}",
                        quarantine.display()
                    )
                })?;
                let filename = path
                    .file_name()
                    .ok_or_else(|| format!("temporary path {} has no filename", path.display()))?;
                let mut destination = quarantine.join(filename);
                let mut suffix = 0u32;
                while destination.exists() {
                    suffix = suffix.saturating_add(1);
                    destination =
                        quarantine.join(format!("{}.orphan-{suffix}", filename.to_string_lossy()));
                }
                std::fs::rename(&path, &destination).map_err(|error| {
                    format!(
                        "quarantine stale temporary {} as {}: {error}",
                        path.display(),
                        destination.display()
                    )
                })?;
                diagnostics.push(format!("quarantined stale temporary {}", path.display()));
            } else {
                diagnostics.push(format!(
                    "stale temporary {} requires recovery",
                    path.display()
                ));
            }
        }
        if repair && !unrecognized_paths.is_empty() {
            let quarantine = directory.join("quarantine");
            std::fs::create_dir_all(&quarantine).map_err(|error| {
                format!(
                    "create quarantine directory {}: {error}",
                    quarantine.display()
                )
            })?;
            for path in unrecognized_paths {
                let Some(filename) = path.file_name() else {
                    diagnostics.push(format!("cannot quarantine unnamed path {}", path.display()));
                    continue;
                };
                let mut destination = quarantine.join(filename);
                let mut suffix = 0u32;
                while destination.exists() {
                    suffix = suffix.saturating_add(1);
                    destination =
                        quarantine.join(format!("{}.unknown-{suffix}", filename.to_string_lossy()));
                }
                match std::fs::rename(&path, &destination) {
                    Ok(()) => {
                        diagnostics.push(format!("quarantined unrecognized {}", path.display()))
                    }
                    Err(error) => diagnostics
                        .push(format!("could not quarantine {}: {error}", path.display())),
                }
            }
        } else {
            for path in unrecognized_paths {
                diagnostics.push(format!("unrecognized journal file {}", path.display()));
            }
        }
        let mut descriptors = Vec::new();
        for (segment_id, (generation, path)) in segment_paths {
            let segment = match SegmentFile::open(
                &path,
                segment_id,
                generation,
                self.codec.clone(),
                self.durability,
                self.maximum_segment_bytes,
            ) {
                Ok(segment) => segment,
                Err(error) => {
                    diagnostics.push(format!("could not open segment {segment_id}: {error}"));
                    if repair {
                        let quarantine = directory.join("quarantine");
                        std::fs::create_dir_all(&quarantine).map_err(|directory_error| {
                            format!(
                                "create quarantine directory {}: {directory_error}",
                                quarantine.display()
                            )
                        })?;
                        let filename = path
                            .file_name()
                            .ok_or_else(|| format!("segment {} has no filename", path.display()))?;
                        let destination = quarantine.join(format!(
                            "{}.open-failed-{segment_id}",
                            filename.to_string_lossy()
                        ));
                        if let Err(move_error) = std::fs::rename(&path, &destination) {
                            diagnostics.push(format!(
                                "could not quarantine unreadable {}: {move_error}",
                                path.display()
                            ));
                        }
                    }
                    continue;
                }
            };
            match segment.inspect_and_repair(repair) {
                Ok((descriptor, segment_diagnostics)) => {
                    for diagnostic in segment_diagnostics {
                        diagnostics.push(format!("segment {segment_id}: {diagnostic}"));
                    }
                    descriptors.push(descriptor);
                }
                Err(error) => {
                    diagnostics.push(format!("segment {segment_id} inspection failed: {error}"))
                }
            }
        }
        descriptors.sort_by_key(|descriptor| {
            (
                descriptor.first_sequence,
                descriptor.generation,
                descriptor.segment_id,
            )
        });
        let mut prior_last: Option<u64> = None;
        let mut active_segments = Vec::new();
        let mut account_last_sequences: BTreeMap<String, u64> = BTreeMap::new();
        let mut known_segment_ids = BTreeSet::new();
        for descriptor in &mut descriptors {
            known_segment_ids.insert(descriptor.segment_id);
            if descriptor.state == SegmentState::Active {
                active_segments.push(descriptor.segment_id);
            }
            if descriptor.first_sequence == 0 && descriptor.live_records > 0 {
                descriptor.state = SegmentState::Quarantined;
                diagnostics.push(format!(
                    "segment {} has records but starts at sequence zero",
                    descriptor.segment_id
                ));
            }
            if let Some(previous) = prior_last {
                if descriptor.first_sequence > previous.saturating_add(1) {
                    diagnostics.push(format!(
                        "journal sequence gap {}..{} before segment {}",
                        previous.saturating_add(1),
                        descriptor.first_sequence.saturating_sub(1),
                        descriptor.segment_id
                    ));
                } else if descriptor.first_sequence <= previous && descriptor.first_sequence != 0 {
                    diagnostics.push(format!(
                        "segment {} overlaps prior sequence through {previous}",
                        descriptor.segment_id
                    ));
                }
            }
            prior_last = Some(prior_last.unwrap_or(0).max(descriptor.last_sequence));
            for (account, range) in &descriptor.account_ranges {
                if let Some(previous) = account_last_sequences.get(account) {
                    if range.0 <= *previous {
                        diagnostics.push(format!(
                            "account {account} overlaps sequence {previous} in segment {}",
                            descriptor.segment_id
                        ));
                    }
                }
                account_last_sequences
                    .entry(account.clone())
                    .and_modify(|value| *value = (*value).max(range.1))
                    .or_insert(range.1);
            }
        }
        if active_segments.len() > 1 {
            active_segments.sort_unstable();
            let retained = *active_segments.last().unwrap_or(&0);
            diagnostics.push(format!(
                "multiple active segments {:?}; retained highest id {retained}",
                active_segments
            ));
            for descriptor in &mut descriptors {
                if descriptor.state == SegmentState::Active && descriptor.segment_id != retained {
                    descriptor.state = SegmentState::Sealed;
                    descriptor.sealed_at = Some(now);
                }
            }
        }
        if known_segment_ids.len() != descriptors.len() {
            return Err("recovery produced duplicate segment identifiers".to_owned());
        }
        Ok((descriptors, diagnostics))
    }
}
