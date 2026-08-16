use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::codec::JournalCodec;
use crate::domain::{Durability, SegmentDescriptor, SegmentState};
use crate::segment::SegmentFile;

/// 恢复扫描器:启动/维护时扫描日志目录,识别、修复或隔离段文件。
///
/// 职责:识别 `segment-{id}-g{N}.bjseg` 文件并处理同名多代、
/// 隔离陈旧临时文件与无法识别的文件、打开每个段并检查其完整性。
pub struct RecoveryScanner {
    pub codec: JournalCodec,
    pub durability: Durability,
    pub maximum_segment_bytes: u64,
    /// 临时文件在此年龄内被视为“进行中”而保留。
    pub temporary_file_grace: Duration,
    /// 可接受的段代际范围(超代文件视为无法识别)。
    pub accept_generation: std::ops::RangeInclusive<u32>,
}

impl RecoveryScanner {
    /// 扫描目录并返回(段描述列表, 诊断信息)。
    ///
    /// `repair=true` 时会对陈旧临时文件与未知文件执行隔离(移入 quarantine 子目录),
    /// 并尝试修复可读但尾部损坏的段;`repair=false` 仅报告。
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
            // 跳过已知子目录(quarantine/indexes),其余目录仅告警。
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
            // 压缩/写入中的临时文件:留待后续按年龄处理。
            if name.ends_with(".compacting")
                || name.ends_with(".writing")
                || name.ends_with(".previous")
                || name.ends_with(".repairing")
            {
                temporary_paths.push(path);
                continue;
            }
            // 非 `segment-*.bjseg` 命名:无法识别。
            if !name.ends_with(".bjseg") || !name.starts_with("segment-") {
                unrecognized_paths.push(path);
                continue;
            }
            // 从文件名解析段 id 与代际:segment-{id}-g{generation}.bjseg。
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
            // 同 id 多代并存:保留代际最新者,旧者转无法识别。
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
        // 临时文件处理:宽限期内保留;过期后 repair 模式隔离,否则仅报告。
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
                // 目标名冲突时追加后缀,避免覆盖。
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
        // 无法识别文件:repair 模式下全部移入 quarantine。
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
        // 逐个打开段并做完整性检查。
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
                    // 打不开的段在 repair 模式下隔离,避免反复报错。
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
        // 按序列起点排序,便于后续检查段间衔接。
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
            // 有记录却从序列 0 开始的段必然是坏的,标记隔离。
            if descriptor.first_sequence == 0 && descriptor.live_records > 0 {
                descriptor.state = SegmentState::Quarantined;
                diagnostics.push(format!(
                    "segment {} has records but starts at sequence zero",
                    descriptor.segment_id
                ));
            }
            // 段间序列衔接检查:间隙或重叠都记录。
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
            // 账户级序列重叠检查。
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
        // 多个 Active 段(异常情况):只保留 id 最大者,其余降级为 Sealed。
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
