use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

use crate::accumulator::BatchWriter;
use crate::codec::JournalCodec;
use crate::domain::{AppendReceipt, Durability, JournalRecord, SegmentDescriptor, SegmentState};

/// 段文件:日志引擎的持久化单元。
///
/// 文件布局:64 字节固定头(魔数/版本/段 id/代际/创建时间/容量/持久化级别/校验和)
/// + 若干追加的“信封”:24 字节信封头(长度/批次校验和/起始序列)+ 编码批次体。
/// 追加时只允许 Active 状态;写满后自动封存(Sealed)。
pub struct SegmentFile {
    /// 段描述(含状态),跨线程共享。
    descriptor: Mutex<SegmentDescriptor>,
    codec: JournalCodec,
    durability: Durability,
    maximum_segment_bytes: u64,
}

impl BatchWriter for SegmentFile {
    fn persist(&self, records: &[JournalRecord]) -> Result<(), String> {
        self.append(records).map(|_| ())
    }
}

impl SegmentFile {
    /// 打开(或新建)段文件。新文件写入 64 字节头并同步;
    /// 已有文件则校验头(魔数、版本、id、代际、容量、校验和)。
    pub fn open(
        path: impl AsRef<Path>,
        segment_id: u64,
        generation: u32,
        codec: JournalCodec,
        durability: Durability,
        maximum_segment_bytes: u64,
    ) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if segment_id == 0 {
            return Err("segment id zero is reserved for unassigned data".to_owned());
        }
        if maximum_segment_bytes < 4_096 {
            return Err("maximum segment size must allow at least one filesystem page".to_owned());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("create segment directory {}: {error}", parent.display())
            })?;
        }
        let existed = path.exists();
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("open segment {}: {error}", path.display()))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("inspect segment {}: {error}", path.display()))?;
        let now = SystemTime::now();
        if metadata.len() == 0 {
            // 新文件:构造 64 字节头。
            let mut header = Vec::with_capacity(64);
            header.extend_from_slice(b"BJSG");
            header.extend_from_slice(&2u16.to_le_bytes());
            header.extend_from_slice(&64u16.to_le_bytes());
            header.extend_from_slice(&segment_id.to_le_bytes());
            header.extend_from_slice(&generation.to_le_bytes());
            let created_millis = now
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64;
            header.extend_from_slice(&created_millis.to_le_bytes());
            header.extend_from_slice(&maximum_segment_bytes.to_le_bytes());
            header.push(match durability {
                Durability::Buffered => 0,
                Durability::DataSync => 1,
                Durability::FullSync => 2,
            });
            header.extend_from_slice(&[0u8; 19]);
            let mut checksum = 0x243f6a8885a308d3u64;
            for byte in &header {
                checksum ^= *byte as u64;
                checksum = checksum.rotate_left(11).wrapping_mul(0x9e3779b185ebca87);
            }
            header.extend_from_slice(&checksum.to_le_bytes());
            if header.len() != 64 {
                return Err(format!(
                    "internal segment header length is {}, expected 64",
                    header.len()
                ));
            }
            file.write_all(&header)
                .map_err(|error| format!("write segment header {}: {error}", path.display()))?;
            // 按持久化级别同步头部。
            if durability == Durability::FullSync {
                file.sync_all()
                    .map_err(|error| format!("sync segment header {}: {error}", path.display()))?;
            } else if durability == Durability::DataSync {
                file.sync_data()
                    .map_err(|error| format!("sync segment data {}: {error}", path.display()))?;
            }
        } else {
            // 已有文件:校验头完整性。
            if metadata.len() < 64 {
                return Err(format!(
                    "existing segment {} is only {} bytes",
                    path.display(),
                    metadata.len()
                ));
            }
            let mut header = [0u8; 64];
            file.seek(SeekFrom::Start(0))
                .and_then(|_| file.read_exact(&mut header))
                .map_err(|error| format!("read segment header {}: {error}", path.display()))?;
            if &header[0..4] != b"BJSG" {
                return Err(format!("segment {} has invalid magic", path.display()));
            }
            let version = u16::from_le_bytes([header[4], header[5]]);
            let header_length = u16::from_le_bytes([header[6], header[7]]);
            if version != 2 || header_length != 64 {
                return Err(format!(
                    "segment {} header uses version {version} and length {header_length}",
                    path.display()
                ));
            }
            let stored_id = u64::from_le_bytes([
                header[8], header[9], header[10], header[11], header[12], header[13], header[14],
                header[15],
            ]);
            let stored_generation =
                u32::from_le_bytes([header[16], header[17], header[18], header[19]]);
            if stored_id != segment_id {
                return Err(format!(
                    "segment file {} belongs to id {stored_id}, not requested id {segment_id}",
                    path.display()
                ));
            }
            if stored_generation != generation {
                return Err(format!(
                    "segment file {} generation is {stored_generation}, not {generation}",
                    path.display()
                ));
            }
            let stored_maximum = u64::from_le_bytes([
                header[28], header[29], header[30], header[31], header[32], header[33], header[34],
                header[35],
            ]);
            if stored_maximum != maximum_segment_bytes {
                return Err(format!(
                    "segment {} was created with maximum {stored_maximum}, requested {maximum_segment_bytes}",
                    path.display()
                ));
            }
            let mut stored_checksum = [0u8; 8];
            stored_checksum.copy_from_slice(&header[56..64]);
            let stored_checksum = u64::from_le_bytes(stored_checksum);
            let mut actual_checksum = 0x243f6a8885a308d3u64;
            for byte in &header[..56] {
                actual_checksum ^= *byte as u64;
                actual_checksum = actual_checksum
                    .rotate_left(11)
                    .wrapping_mul(0x9e3779b185ebca87);
            }
            if stored_checksum != actual_checksum {
                return Err(format!(
                    "segment {} header checksum mismatch",
                    path.display()
                ));
            }
        }
        let physical_bytes = file
            .metadata()
            .map_err(|error| format!("refresh segment metadata {}: {error}", path.display()))?
            .len();
        let descriptor = SegmentDescriptor {
            segment_id,
            path: path.clone(),
            state: SegmentState::Active,
            generation,
            first_sequence: 0,
            last_sequence: 0,
            first_timestamp_ms: 0,
            last_timestamp_ms: 0,
            // 逻辑字节 = 物理字节 - 头(64 字节),此时还没有记录。
            logical_bytes: physical_bytes.saturating_sub(64),
            physical_bytes,
            live_records: 0,
            tombstone_records: 0,
            duplicate_records: 0,
            checksum_failures: 0,
            reader_leases: 0,
            replica_acks: BTreeSet::new(),
            account_ranges: BTreeMap::new(),
            created_at: if existed {
                metadata.created().unwrap_or(now)
            } else {
                now
            },
            sealed_at: None,
            legal_hold: false,
        };
        Ok(Self {
            descriptor: Mutex::new(descriptor),
            codec,
            durability,
            maximum_segment_bytes,
        })
    }

    /// 追加一批记录:编码 → 预估空间 → 写信封(头+体)→ 按持久化级别同步 → 更新描述。
    ///
    /// 追加前若预估会超容量,先把段标记为 Sealed 并返回错误,让上层轮换新段。
    pub fn append(&self, records: &[JournalRecord]) -> Result<AppendReceipt, String> {
        if records.is_empty() {
            return Err("cannot append an empty journal batch".to_owned());
        }
        let encoded = self.codec.encode_batch(records)?;
        let envelope_bytes = encoded
            .len()
            .checked_add(24)
            .ok_or_else(|| "encoded envelope length overflow".to_owned())?;
        let envelope_bytes_u64 = u64::try_from(envelope_bytes)
            .map_err(|_| "encoded envelope does not fit in a u64".to_owned())?;
        let mut descriptor = self
            .descriptor
            .lock()
            .map_err(|_| "segment descriptor lock is poisoned".to_owned())?;
        if descriptor.state != SegmentState::Active {
            return Err(format!(
                "segment {} is {:?} and cannot accept appends",
                descriptor.segment_id, descriptor.state
            ));
        }
        let projected = descriptor
            .physical_bytes
            .checked_add(envelope_bytes_u64)
            .ok_or_else(|| "segment length overflow".to_owned())?;
        // 超容量:封存本段,交由上层轮换。
        if projected > self.maximum_segment_bytes {
            descriptor.state = SegmentState::Sealed;
            descriptor.sealed_at = Some(SystemTime::now());
            return Err(format!(
                "segment {} would grow from {} to {projected}, beyond maximum {}",
                descriptor.segment_id, descriptor.physical_bytes, self.maximum_segment_bytes
            ));
        }
        // 批次级校验和(信封头携带,恢复时据此发现损坏批次)。
        let mut batch_checksum = 0xd6e8feb86659fd93u64;
        for byte in &encoded {
            batch_checksum ^= *byte as u64;
            batch_checksum = batch_checksum
                .rotate_left(13)
                .wrapping_mul(0xa0761d6478bd642f);
            batch_checksum ^= batch_checksum >> 31;
        }
        // 序列分配:从 1 开始单调递增,绝不回退。
        let first_sequence = descriptor.last_sequence.saturating_add(1).max(1);
        let record_count_u64 = u64::try_from(records.len())
            .map_err(|_| "record count does not fit in a u64".to_owned())?;
        let last_sequence = first_sequence
            .checked_add(record_count_u64.saturating_sub(1))
            .ok_or_else(|| "journal sequence exhausted".to_owned())?;
        let byte_offset = descriptor.physical_bytes;
        let mut file = OpenOptions::new()
            .append(true)
            .read(true)
            .open(&descriptor.path)
            .map_err(|error| {
                format!(
                    "open segment {} for append: {error}",
                    descriptor.path.display()
                )
            })?;
        // 信封头:体长 + 批次校验和 + 起始序列。
        let mut envelope_header = Vec::with_capacity(24);
        envelope_header.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
        envelope_header.extend_from_slice(&batch_checksum.to_le_bytes());
        envelope_header.extend_from_slice(&first_sequence.to_le_bytes());
        file.write_all(&envelope_header)
            .and_then(|_| file.write_all(&encoded))
            .map_err(|error| format!("append segment {}: {error}", descriptor.path.display()))?;
        // 按持久化级别同步。
        match self.durability {
            Durability::Buffered => {
                file.flush().map_err(|error| {
                    format!("flush segment {}: {error}", descriptor.path.display())
                })?;
            }
            Durability::DataSync => {
                file.sync_data().map_err(|error| {
                    format!("data-sync segment {}: {error}", descriptor.path.display())
                })?;
            }
            Durability::FullSync => {
                file.sync_all().map_err(|error| {
                    format!("full-sync segment {}: {error}", descriptor.path.display())
                })?;
            }
        }
        let committed_at = SystemTime::now();
        // 更新描述:序列范围、字节、记录统计、时间戳范围、账户范围。
        if descriptor.first_sequence == 0 {
            descriptor.first_sequence = first_sequence;
        }
        descriptor.last_sequence = last_sequence;
        descriptor.physical_bytes = projected;
        descriptor.logical_bytes = descriptor
            .logical_bytes
            .saturating_add(encoded.len() as u64);
        descriptor.live_records = descriptor.live_records.saturating_add(records.len());
        let minimum_timestamp = records
            .iter()
            .map(|record| record.occurred_at)
            .min()
            .unwrap_or(0);
        let maximum_timestamp = records
            .iter()
            .map(|record| record.occurred_at)
            .max()
            .unwrap_or(0);
        if descriptor.first_timestamp_ms == 0 {
            descriptor.first_timestamp_ms = minimum_timestamp;
        } else {
            descriptor.first_timestamp_ms = descriptor.first_timestamp_ms.min(minimum_timestamp);
        }
        descriptor.last_timestamp_ms = descriptor.last_timestamp_ms.max(maximum_timestamp);
        for (offset, record) in records.iter().enumerate() {
            if record.payload.starts_with("tombstone") {
                descriptor.tombstone_records = descriptor.tombstone_records.saturating_add(1);
            }
            let sequence = first_sequence.saturating_add(offset as u64);
            descriptor
                .account_ranges
                .entry(record.account.clone())
                .and_modify(|range| {
                    range.0 = range.0.min(sequence);
                    range.1 = range.1.max(sequence);
                })
                .or_insert((sequence, sequence));
        }
        // 接近容量(余量不足 4 KiB)时提前封存。
        if projected.saturating_add(4_096) > self.maximum_segment_bytes {
            descriptor.state = SegmentState::Sealed;
            descriptor.sealed_at = Some(committed_at);
        }
        Ok(AppendReceipt {
            segment_id: descriptor.segment_id,
            first_sequence,
            last_sequence,
            byte_offset,
            byte_length: envelope_bytes_u64,
            record_count: records.len(),
            durability: self.durability,
            committed_at,
            checksum: batch_checksum,
        })
    }

    /// 扫描整个段文件,重建描述并报告损坏;可选截断损坏尾部(修复)。
    ///
    /// 逐信封读取:先验信封校验和,再解码批次;校验失败即停止向后扫描
    /// (之后的字节不可信)。扫描结果写回描述,损坏尾部按策略截断或隔离。
    pub fn inspect_and_repair(
        &self,
        truncate_corrupt_tail: bool,
    ) -> Result<(SegmentDescriptor, Vec<String>), String> {
        let mut descriptor = self
            .descriptor
            .lock()
            .map_err(|_| "segment descriptor lock is poisoned".to_owned())?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(truncate_corrupt_tail)
            .open(&descriptor.path)
            .map_err(|error| {
                format!(
                    "open segment {} for inspection: {error}",
                    descriptor.path.display()
                )
            })?;
        let physical_length = file
            .metadata()
            .map_err(|error| {
                format!(
                    "inspect segment {} metadata: {error}",
                    descriptor.path.display()
                )
            })?
            .len();
        if physical_length < 64 {
            descriptor.state = SegmentState::Quarantined;
            return Err(format!(
                "segment {} lost its complete header",
                descriptor.path.display()
            ));
        }
        file.seek(SeekFrom::Start(64))
            .map_err(|error| format!("seek segment {}: {error}", descriptor.path.display()))?;
        let mut diagnostics = Vec::new();
        let mut cursor = 64u64;
        let mut last_good_cursor = cursor;
        let mut first_sequence = 0u64;
        let mut last_sequence = 0u64;
        let mut minimum_timestamp = i64::MAX;
        let mut maximum_timestamp = i64::MIN;
        let mut logical_bytes = 0u64;
        let mut live_records = 0usize;
        let mut tombstone_records = 0usize;
        let mut duplicate_records = 0usize;
        let mut checksum_failures = 0usize;
        let mut account_ranges: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        let mut seen_identities = BTreeSet::new();
        let mut expected_sequence = 1u64;
        while cursor < physical_length {
            let remaining = physical_length - cursor;
            // 尾部不足一个信封头(24 字节):必然是中断的写入。
            if remaining < 24 {
                diagnostics.push(format!(
                    "{} trailing bytes cannot contain an envelope header",
                    remaining
                ));
                break;
            }
            let mut envelope = [0u8; 24];
            if let Err(error) = file.read_exact(&mut envelope) {
                diagnostics.push(format!("cannot read envelope at {cursor}: {error}"));
                break;
            }
            let body_length = u64::from_le_bytes([
                envelope[0],
                envelope[1],
                envelope[2],
                envelope[3],
                envelope[4],
                envelope[5],
                envelope[6],
                envelope[7],
            ]);
            let declared_checksum = u64::from_le_bytes([
                envelope[8],
                envelope[9],
                envelope[10],
                envelope[11],
                envelope[12],
                envelope[13],
                envelope[14],
                envelope[15],
            ]);
            let envelope_sequence = u64::from_le_bytes([
                envelope[16],
                envelope[17],
                envelope[18],
                envelope[19],
                envelope[20],
                envelope[21],
                envelope[22],
                envelope[23],
            ]);
            if body_length == 0 {
                diagnostics.push(format!("zero-length envelope at byte {cursor}"));
                break;
            }
            if body_length > self.maximum_segment_bytes {
                diagnostics.push(format!(
                    "envelope at byte {cursor} declares impossible length {body_length}"
                ));
                break;
            }
            let envelope_end = match cursor
                .checked_add(24)
                .and_then(|value| value.checked_add(body_length))
            {
                Some(value) => value,
                None => {
                    diagnostics.push(format!("envelope length overflows at byte {cursor}"));
                    break;
                }
            };
            if envelope_end > physical_length {
                diagnostics.push(format!(
                    "envelope at byte {cursor} ends at {envelope_end}, file ends at {physical_length}"
                ));
                break;
            }
            let allocation = match usize::try_from(body_length) {
                Ok(value) => value,
                Err(_) => {
                    diagnostics.push(format!(
                        "envelope at byte {cursor} cannot be allocated on this platform"
                    ));
                    break;
                }
            };
            let mut body = vec![0u8; allocation];
            if let Err(error) = file.read_exact(&mut body) {
                diagnostics.push(format!("cannot read envelope body at {cursor}: {error}"));
                break;
            }
            // 信封校验和:不匹配即视为批次损坏,停止向后扫描。
            let mut actual_checksum = 0xd6e8feb86659fd93u64;
            for byte in &body {
                actual_checksum ^= *byte as u64;
                actual_checksum = actual_checksum
                    .rotate_left(13)
                    .wrapping_mul(0xa0761d6478bd642f);
                actual_checksum ^= actual_checksum >> 31;
            }
            if actual_checksum != declared_checksum {
                checksum_failures = checksum_failures.saturating_add(1);
                diagnostics.push(format!("envelope checksum mismatch at byte {cursor}"));
                break;
            }
            let (decoded, decode_diagnostics) = self.codec.decode_stream(&body);
            if !decode_diagnostics.is_empty() {
                for diagnostic in decode_diagnostics {
                    diagnostics.push(format!("envelope {cursor}: {diagnostic}"));
                }
            }
            if decoded.is_empty() {
                diagnostics.push(format!("envelope at byte {cursor} decoded no records"));
                break;
            }
            // 序列必须与期望严格衔接;回退说明数据错乱。
            if envelope_sequence != expected_sequence {
                diagnostics.push(format!(
                    "sequence discontinuity at byte {cursor}: expected {expected_sequence}, found {envelope_sequence}"
                ));
                if envelope_sequence < expected_sequence {
                    break;
                }
            }
            if first_sequence == 0 {
                first_sequence = envelope_sequence;
            }
            // 汇总本批记录统计。
            for (offset, record) in decoded.iter().enumerate() {
                let sequence = envelope_sequence.saturating_add(offset as u64);
                last_sequence = last_sequence.max(sequence);
                minimum_timestamp = minimum_timestamp.min(record.occurred_at);
                maximum_timestamp = maximum_timestamp.max(record.occurred_at);
                if record.payload.starts_with("tombstone") {
                    tombstone_records = tombstone_records.saturating_add(1);
                }
                if !seen_identities.insert(record.identity.clone()) {
                    duplicate_records = duplicate_records.saturating_add(1);
                } else {
                    live_records = live_records.saturating_add(1);
                }
                account_ranges
                    .entry(record.account.clone())
                    .and_modify(|range| {
                        range.0 = range.0.min(sequence);
                        range.1 = range.1.max(sequence);
                    })
                    .or_insert((sequence, sequence));
            }
            expected_sequence = envelope_sequence.saturating_add(decoded.len() as u64);
            logical_bytes = logical_bytes.saturating_add(body_length);
            cursor = envelope_end;
            last_good_cursor = cursor;
        }
        // 处理损坏尾部:截断或隔离。
        if last_good_cursor < physical_length {
            let corrupt_bytes = physical_length - last_good_cursor;
            if truncate_corrupt_tail {
                file.set_len(last_good_cursor).map_err(|error| {
                    format!("truncate segment {}: {error}", descriptor.path.display())
                })?;
                if self.durability == Durability::FullSync {
                    file.sync_all().map_err(|error| {
                        format!(
                            "sync repaired segment {}: {error}",
                            descriptor.path.display()
                        )
                    })?;
                } else {
                    file.sync_data().map_err(|error| {
                        format!("sync repaired data {}: {error}", descriptor.path.display())
                    })?;
                }
                diagnostics.push(format!("truncated {corrupt_bytes} corrupt trailing bytes"));
            } else {
                descriptor.state = SegmentState::Quarantined;
                diagnostics.push(format!(
                    "left {corrupt_bytes} corrupt trailing bytes in place"
                ));
            }
        }
        // 把扫描结果写回描述。
        descriptor.first_sequence = first_sequence;
        descriptor.last_sequence = last_sequence;
        descriptor.first_timestamp_ms = if minimum_timestamp == i64::MAX {
            0
        } else {
            minimum_timestamp
        };
        descriptor.last_timestamp_ms = if maximum_timestamp == i64::MIN {
            0
        } else {
            maximum_timestamp
        };
        descriptor.logical_bytes = logical_bytes;
        descriptor.physical_bytes = if truncate_corrupt_tail {
            last_good_cursor
        } else {
            physical_length
        };
        descriptor.live_records = live_records;
        descriptor.tombstone_records = tombstone_records;
        descriptor.duplicate_records = duplicate_records;
        descriptor.checksum_failures = checksum_failures;
        descriptor.account_ranges = account_ranges;
        // 根据剩余容量重估状态(仅当未隔离时)。
        if descriptor.state != SegmentState::Quarantined {
            if descriptor.physical_bytes.saturating_add(4_096) >= self.maximum_segment_bytes {
                descriptor.state = SegmentState::Sealed;
                if descriptor.sealed_at.is_none() {
                    descriptor.sealed_at = Some(SystemTime::now());
                }
            } else {
                descriptor.state = SegmentState::Active;
            }
        }
        Ok((descriptor.clone(), diagnostics))
    }
}
