use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

/// 稀疏索引:为段文件建立按序列、账户、时间、identity 的锚点索引。
///
/// 只保留“步长”间隔的序列偏移(稀疏),配合账户/时间/身份窗口提供近似定位,
/// 用于把顺序扫描缩小到小范围,而不是全量读段。
#[derive(Clone, Debug)]
pub struct SparseIndex {
    pub segment_id: u64,
    pub generation: u32,
    pub source_bytes: u64,
    /// 每隔多少行记录一个序列 → 偏移锚点。
    pub stride: usize,
    /// 序列号 → 字节偏移(稀疏锚点)。
    pub sequence_offsets: BTreeMap<u64, u64>,
    /// 账户 → 连续序列窗口列表(首序列, 末序列, 起始偏移)。
    pub account_windows: BTreeMap<String, Vec<(u64, u64, u64)>>,
    /// 时间桶(60 秒粒度)→ (最小序列, 最大序列, 最小偏移, 最大偏移)。
    pub time_windows: BTreeMap<i64, (u64, u64, u64, u64)>,
    /// 身份哈希桶(高 52 位)→ 指纹与序列列表。
    pub identity_buckets: BTreeMap<u64, Vec<(u64, u64)>>,
    pub index_checksum: u64,
}

impl SparseIndex {
    /// 从扫描得到的行(序列, 偏移, 时间戳, 账户, 身份)重建索引,并原子写入磁盘。
    ///
    /// 返回(索引, 诊断);诊断包含重复序列/回退/越界等数据质量问题。
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
        // 账户的“进行中”窗口:(首序列, 末序列, 首偏移, 行数)。
        let mut account_open: BTreeMap<String, (u64, u64, u64, usize)> = BTreeMap::new();
        let mut indexed_rows = 0usize;
        for (ordinal, row) in rows.iter().enumerate() {
            let (sequence, byte_offset, timestamp_ms, account, identity) = row;
            // 行级校验:非法行记诊断并跳过。
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
            // 序列连续性检查(回退/跳号)与偏移单调性检查。
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
            // 每隔 stride 行记录一个序列锚点。
            if indexed_rows.is_multiple_of(stride) {
                sequence_offsets.insert(*sequence, *byte_offset);
            }
            // 时间窗口:按 60 秒桶聚合序列与偏移范围。
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
            // 身份指纹:哈希与长度混入,再按高 52 位分桶。
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
            // 账户窗口:连续序列、偏移跨度与行数都受限时扩展当前窗口,否则封口开新窗。
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
        // 收尾:封口所有进行中的账户窗口。
        for (account, (first, last, offset, _)) in account_open {
            account_windows
                .entry(account)
                .or_default()
                .push((first, last, offset));
        }
        // 窗口压缩:相邻且偏移跨度 ≤8 MiB 的窗口合并。
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
        // 身份桶去重排序,便于二分查找。
        for values in identity_buckets.values_mut() {
            values.sort_unstable_by_key(|entry| (entry.0, entry.1));
            values.dedup();
        }
        // 保证最后一条记录的锚点存在,便于定位段尾。
        if let Some((last_sequence, _)) = rows.last().map(|row| (row.0, row.1)) {
            if !sequence_offsets.contains_key(&last_sequence) {
                if let Some(row) = rows.iter().rev().find(|row| row.0 == last_sequence) {
                    sequence_offsets.insert(row.0, row.1);
                }
            }
        }
        // 序列化为二进制:魔数 + 版本 + 段信息 + 各索引表 + 整体校验和。
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
        // 原子写入:临时文件 → fsync → 旧索引备份 → 改名激活。
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
            // 激活失败时回滚备份。
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
        // 同步索引目录,确保改名在掉电后可见。
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

    /// 查找满足过滤条件的读取起点(序列, 偏移)列表。
    ///
    /// 过滤条件可组合:账户、序列范围、时间戳范围、identity。返回的锚点是
    /// 读取的近似起点,调用方需从锚点起顺序扫描并自行精确过滤。
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
        // 候选锚点:floor 之前最近锚点 + 范围内所有锚点。
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
        // 账户过滤:只保留落在该账户窗口附近的锚点。
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
            // 锚点距账户窗口起点超过 8×stride 则丢弃(账户可能整体换段)。
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
        // 时间过滤:只保留落在时间桶范围附近的锚点。
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
        // identity 过滤:桶内精确匹配指纹,得到可能的序列集合。
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
        // 把密集的候选锚点压缩为离散输出:相邻锚点距离 ≤ stride 且偏移差 ≤64 KiB 的只取其一。
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
