use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use crate::domain::{CompactionAction, CompactionPlan, SegmentDescriptor, SegmentState};

/// 压缩规划器:决定哪些已封存段需要合并/重写/隔离,以及何时执行。
///
/// 策略:优先隔离损坏/隔离段;对健康段按序列与代际分组,
/// 依据死记录占比(tombstone+duplicate)、碎片率与可回收字节数判定动作,
/// 并生成 0-99 的紧急度用于排序(被阻塞的规划紧急度恒为 1)。
pub struct CompactionPlanner {
    pub target_segment_bytes: u64,
    /// 一次压缩最多合并的输入段数。
    pub maximum_input_segments: usize,
    pub minimum_reclaim_bytes: u64,
    /// 死记录千分比阈值。
    pub tombstone_ratio_per_mille: u16,
    /// 碎片千分比阈值。
    pub fragmentation_ratio_per_mille: u16,
    /// 压缩前必须满足的副本确认数。
    pub required_replica_acks: usize,
    /// 段封存后至少等待多久才能参与压缩。
    pub minimum_sealed_age: Duration,
    /// 目标段的代际上限(防止无限叠加)。
    pub maximum_generation: u32,
}

impl CompactionPlanner {
    /// 依据当前段列表与时间生成压缩规划。
    ///
    /// 输入会先做一致性校验(重复段 id、重复路径、倒置序列等),
    /// 任何异常段都直接进入隔离规划,不参与分组压缩。
    pub fn plan(
        &self,
        segments: &[SegmentDescriptor],
        now: SystemTime,
    ) -> Result<Vec<CompactionPlan>, String> {
        if self.target_segment_bytes < 4_096 {
            return Err("compaction target must be at least one filesystem page".to_owned());
        }
        if self.maximum_input_segments < 2 {
            return Err("compaction requires at least two possible input segments".to_owned());
        }
        if self.tombstone_ratio_per_mille > 1_000 {
            return Err("tombstone compaction ratio must be between 0 and 1000".to_owned());
        }
        if self.fragmentation_ratio_per_mille > 1_000 {
            return Err("fragmentation compaction ratio must be between 0 and 1000".to_owned());
        }
        let mut identities = BTreeSet::new();
        let mut paths = BTreeSet::new();
        let mut diagnostics_by_segment: BTreeMap<u64, Vec<String>> = BTreeMap::new();
        for descriptor in segments {
            if descriptor.segment_id == 0 {
                return Err("compaction input contains reserved segment id zero".to_owned());
            }
            if !identities.insert(descriptor.segment_id) {
                return Err(format!(
                    "compaction input repeats segment {}",
                    descriptor.segment_id
                ));
            }
            if !paths.insert(descriptor.path.clone()) {
                return Err(format!(
                    "multiple segment descriptors use path {}",
                    descriptor.path.display()
                ));
            }
            // 汇总非致命异常(倒置序列、逻辑字节超过物理字节、代际超限)。
            if descriptor.first_sequence > descriptor.last_sequence && descriptor.last_sequence != 0
            {
                diagnostics_by_segment
                    .entry(descriptor.segment_id)
                    .or_default()
                    .push(format!(
                        "sequence range {}..{} is inverted",
                        descriptor.first_sequence, descriptor.last_sequence
                    ));
            }
            if descriptor.logical_bytes > descriptor.physical_bytes {
                diagnostics_by_segment
                    .entry(descriptor.segment_id)
                    .or_default()
                    .push(format!(
                        "logical bytes {} exceed physical bytes {}",
                        descriptor.logical_bytes, descriptor.physical_bytes
                    ));
            }
            if descriptor.generation > self.maximum_generation {
                diagnostics_by_segment
                    .entry(descriptor.segment_id)
                    .or_default()
                    .push(format!(
                        "generation {} exceeds configured maximum {}",
                        descriptor.generation, self.maximum_generation
                    ));
            }
        }
        let mut plans = Vec::new();
        // 第一遍:隔离损坏段。
        for descriptor in segments {
            if descriptor.state == SegmentState::Quarantined
                || descriptor.checksum_failures > 0
                || diagnostics_by_segment.contains_key(&descriptor.segment_id)
            {
                let mut reasons = diagnostics_by_segment
                    .remove(&descriptor.segment_id)
                    .unwrap_or_default();
                if descriptor.state == SegmentState::Quarantined {
                    reasons.push("segment is already quarantined".to_owned());
                }
                if descriptor.checksum_failures > 0 {
                    reasons.push(format!(
                        "segment has {} checksum failures",
                        descriptor.checksum_failures
                    ));
                }
                // 从段 id 派生稳定的规划 id。
                let mut hash = 0x517cc1b727220a95u64;
                for byte in descriptor.segment_id.to_le_bytes() {
                    hash ^= byte as u64;
                    hash = hash.rotate_left(5).wrapping_mul(0x9e3779b185ebca87);
                }
                plans.push(CompactionPlan {
                    plan_id: format!("quarantine-{}-{hash:016x}", descriptor.segment_id),
                    inputs: vec![descriptor.segment_id],
                    action: CompactionAction::Quarantine,
                    destination_generation: descriptor.generation,
                    estimated_read_bytes: 0,
                    estimated_write_bytes: 0,
                    estimated_reclaimed_bytes: 0,
                    earliest_sequence: descriptor.first_sequence,
                    latest_sequence: descriptor.last_sequence,
                    accounts: descriptor.account_ranges.keys().cloned().collect(),
                    reasons,
                    blocked_by: Vec::new(),
                    urgency: 100,
                });
            }
        }
        // 第二遍:对健康段做分组压缩。按序列起点排序后贪心扩展组。
        let mut eligible = segments
            .iter()
            .filter(|descriptor| {
                matches!(
                    descriptor.state,
                    SegmentState::Sealed | SegmentState::Superseded
                ) && descriptor.checksum_failures == 0
                    && !plans
                        .iter()
                        .any(|plan| plan.inputs.contains(&descriptor.segment_id))
            })
            .collect::<Vec<_>>();
        eligible.sort_by_key(|descriptor| {
            (
                descriptor.first_sequence,
                descriptor.last_sequence,
                descriptor.generation,
                descriptor.segment_id,
            )
        });
        let mut cursor = 0usize;
        while cursor < eligible.len() {
            let first = eligible[cursor];
            let mut group = vec![first];
            let mut combined_bytes = first.physical_bytes;
            let mut combined_accounts = first
                .account_ranges
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>();
            let mut latest_sequence = first.last_sequence;
            let first_generation = first.generation;
            let mut next = cursor + 1;
            // 扩展条件:序列近邻(≤4096)或账户重叠、代际兼容(差≤1)、合并后不超目标尺寸的 1.5 倍;
            // 序列重叠时强制合并以解决重叠。
            while next < eligible.len() && group.len() < self.maximum_input_segments {
                let candidate = eligible[next];
                let sequence_gap = candidate.first_sequence.saturating_sub(latest_sequence);
                let account_overlap = candidate
                    .account_ranges
                    .keys()
                    .any(|account| combined_accounts.contains(account));
                let near_sequence = sequence_gap <= 4_096;
                let compatible_generation = candidate.generation.abs_diff(first_generation) <= 1;
                let projected_bytes = combined_bytes.saturating_add(candidate.physical_bytes);
                let fits_target =
                    projected_bytes <= self.target_segment_bytes.saturating_mul(3) / 2;
                let must_resolve_overlap = candidate.first_sequence <= latest_sequence;
                if must_resolve_overlap
                    || (compatible_generation && fits_target && (near_sequence || account_overlap))
                {
                    group.push(candidate);
                    combined_bytes = projected_bytes;
                    latest_sequence = latest_sequence.max(candidate.last_sequence);
                    combined_accounts.extend(candidate.account_ranges.keys().cloned());
                    next += 1;
                } else {
                    break;
                }
            }
            // 组级统计:死记录占比与碎片率决定动作。
            let total_live = group
                .iter()
                .map(|descriptor| descriptor.live_records)
                .sum::<usize>();
            let total_tombstones = group
                .iter()
                .map(|descriptor| descriptor.tombstone_records)
                .sum::<usize>();
            let total_duplicates = group
                .iter()
                .map(|descriptor| descriptor.duplicate_records)
                .sum::<usize>();
            let total_logical = group
                .iter()
                .map(|descriptor| descriptor.logical_bytes)
                .sum::<u64>();
            let total_physical = group
                .iter()
                .map(|descriptor| descriptor.physical_bytes)
                .sum::<u64>();
            let total_records = total_live
                .saturating_add(total_tombstones)
                .saturating_add(total_duplicates)
                .max(1);
            let tombstone_per_mille = total_tombstones
                .saturating_add(total_duplicates)
                .saturating_mul(1_000)
                / total_records;
            let fragmentation_per_mille = total_physical
                .saturating_sub(total_logical)
                .saturating_mul(1_000)
                .checked_div(total_physical)
                .unwrap_or(0);
            let reclaimable_records = total_tombstones.saturating_add(total_duplicates);
            // 按存活记录估算单条平均大小,进而估算可回收字节。
            let estimated_record_bytes = if total_records == 0 {
                0
            } else {
                total_logical / total_records as u64
            };
            let estimated_reclaimed = total_physical
                .saturating_sub(total_logical)
                .saturating_add(estimated_record_bytes.saturating_mul(reclaimable_records as u64));
            // 收集阻塞因素:活跃读者、法律保留、副本确认不足、封存时间不足。
            let mut blocked_by = Vec::new();
            let mut reasons = Vec::new();
            for descriptor in &group {
                if descriptor.reader_leases > 0 {
                    blocked_by.push(format!(
                        "segment {} has {} active readers",
                        descriptor.segment_id, descriptor.reader_leases
                    ));
                }
                if descriptor.legal_hold {
                    blocked_by.push(format!(
                        "segment {} is under legal hold",
                        descriptor.segment_id
                    ));
                }
                if descriptor.replica_acks.len() < self.required_replica_acks {
                    blocked_by.push(format!(
                        "segment {} has {} of {} required replica acknowledgements",
                        descriptor.segment_id,
                        descriptor.replica_acks.len(),
                        self.required_replica_acks
                    ));
                }
                let age = descriptor
                    .sealed_at
                    .and_then(|sealed| now.duration_since(sealed).ok())
                    .unwrap_or(Duration::ZERO);
                if age < self.minimum_sealed_age {
                    blocked_by.push(format!(
                        "segment {} has been sealed for {:?}, less than {:?}",
                        descriptor.segment_id, age, self.minimum_sealed_age
                    ));
                }
            }
            if group.len() > 1 {
                reasons.push(format!(
                    "{} adjacent segments can share one destination",
                    group.len()
                ));
            }
            if tombstone_per_mille >= self.tombstone_ratio_per_mille as usize {
                reasons.push(format!(
                    "dead-record ratio is {tombstone_per_mille} per mille, threshold {}",
                    self.tombstone_ratio_per_mille
                ));
            }
            if fragmentation_per_mille >= self.fragmentation_ratio_per_mille as u64 {
                reasons.push(format!(
                    "storage fragmentation is {fragmentation_per_mille} per mille, threshold {}",
                    self.fragmentation_ratio_per_mille
                ));
            }
            if estimated_reclaimed >= self.minimum_reclaim_bytes {
                reasons.push(format!(
                    "estimated reclaim {estimated_reclaimed} bytes meets minimum {}",
                    self.minimum_reclaim_bytes
                ));
            }
            // 动作决策:有阻塞 → Keep;多段 → Merge;否则按指标重写单段。
            let action = if !blocked_by.is_empty() {
                CompactionAction::Keep
            } else if group.len() > 1 {
                CompactionAction::Merge
            } else if tombstone_per_mille >= self.tombstone_ratio_per_mille as usize
                || fragmentation_per_mille >= self.fragmentation_ratio_per_mille as u64
                || estimated_reclaimed >= self.minimum_reclaim_bytes
            {
                CompactionAction::Rewrite
            } else {
                CompactionAction::Keep
            };
            if action != CompactionAction::Keep || !blocked_by.is_empty() {
                let destination_generation = group
                    .iter()
                    .map(|descriptor| descriptor.generation)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(self.maximum_generation);
                // 写入量估算:逻辑字节减去可回收记录对应的字节。
                let estimated_write = total_logical.saturating_sub(
                    estimated_record_bytes.saturating_mul(reclaimable_records as u64),
                );
                let earliest_sequence = group
                    .iter()
                    .map(|descriptor| descriptor.first_sequence)
                    .min()
                    .unwrap_or(0);
                let latest_sequence = group
                    .iter()
                    .map(|descriptor| descriptor.last_sequence)
                    .max()
                    .unwrap_or(0);
                let inputs = group
                    .iter()
                    .map(|descriptor| descriptor.segment_id)
                    .collect::<Vec<_>>();
                let mut hash = 0x94d049bb133111ebu64;
                for input in &inputs {
                    hash ^= *input;
                    hash = hash.rotate_left(17).wrapping_mul(0x9e3779b185ebca87);
                }
                hash ^= destination_generation as u64;
                // 紧急度 = 回收占比(0-70)+ 死记录占比(0-30),无阻塞时封顶 99。
                let reclaim_urgency = estimated_reclaimed
                    .saturating_mul(70)
                    .checked_div(total_physical)
                    .unwrap_or(0);
                let dead_urgency = (tombstone_per_mille as u64).saturating_mul(30) / 1_000;
                let urgency = if blocked_by.is_empty() {
                    reclaim_urgency.saturating_add(dead_urgency).min(99) as u8
                } else {
                    1
                };
                plans.push(CompactionPlan {
                    plan_id: format!("compact-{}-{hash:016x}", inputs[0]),
                    inputs,
                    action,
                    destination_generation,
                    estimated_read_bytes: total_physical,
                    estimated_write_bytes: estimated_write,
                    estimated_reclaimed_bytes: estimated_reclaimed,
                    earliest_sequence,
                    latest_sequence,
                    accounts: combined_accounts,
                    reasons,
                    blocked_by,
                    urgency,
                });
            }
            cursor = if group.len() > 1 { next } else { cursor + 1 };
        }
        // 按紧急度降序、起始序列升序排序,保证执行顺序稳定且最重要的事先做。
        plans.sort_by(|left, right| {
            right
                .urgency
                .cmp(&left.urgency)
                .then_with(|| left.earliest_sequence.cmp(&right.earliest_sequence))
                .then_with(|| left.plan_id.cmp(&right.plan_id))
        });
        // 可执行规划(非 Keep)的输入段必须互不重叠。
        let mut claimed = BTreeSet::new();
        for plan in &plans {
            if plan.action == CompactionAction::Keep {
                continue;
            }
            for input in &plan.inputs {
                if !claimed.insert(*input) {
                    return Err(format!(
                        "segment {input} appears in more than one executable compaction plan"
                    ));
                }
            }
        }
        Ok(plans)
    }
}
