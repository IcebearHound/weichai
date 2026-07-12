use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use crate::domain::{CompactionAction, CompactionPlan, SegmentDescriptor, SegmentState};

pub struct CompactionPlanner {
    pub target_segment_bytes: u64,
    pub maximum_input_segments: usize,
    pub minimum_reclaim_bytes: u64,
    pub tombstone_ratio_per_mille: u16,
    pub fragmentation_ratio_per_mille: u16,
    pub required_replica_acks: usize,
    pub minimum_sealed_age: Duration,
    pub maximum_generation: u32,
}

impl CompactionPlanner {
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
            let estimated_record_bytes = if total_records == 0 {
                0
            } else {
                total_logical / total_records as u64
            };
            let estimated_reclaimed = total_physical
                .saturating_sub(total_logical)
                .saturating_add(estimated_record_bytes.saturating_mul(reclaimable_records as u64));
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
        plans.sort_by(|left, right| {
            right
                .urgency
                .cmp(&left.urgency)
                .then_with(|| left.earliest_sequence.cmp(&right.earliest_sequence))
                .then_with(|| left.plan_id.cmp(&right.plan_id))
        });
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
