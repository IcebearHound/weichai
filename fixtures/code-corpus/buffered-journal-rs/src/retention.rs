use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use crate::domain::{RetentionDecision, SegmentDescriptor, SegmentState};

/// 保留策略:决定哪些段可删除、哪些必须保留(或暂缓删除)。
///
/// 判定优先级:隔离 → 法律保留 → 活跃读者 → 副本未确认 → Active 段 →
/// 最新 N 段保护 → 最近序列跨度保护 → 超出检查点保护 → 最小封存时长 →
/// 最大年龄删除 / 被取代段删除。磁盘压力超过阈值时会额外挑选可删段。
pub struct RetentionPolicy {
    /// 无论如何都至少保留的段数(取最新者)。
    pub minimum_segments: usize,
    /// 总字节预算;超出时触发压力删除。
    pub maximum_total_bytes: u64,
    /// 最小封存时长(过早的段不删)。
    pub minimum_age: Duration,
    /// 最大段年龄(超过即删除)。
    pub maximum_age: Duration,
    /// 必须完成副本确认的副本集合。
    pub required_replicas: BTreeSet<String>,
    /// 距离最新序列的保护跨度(最新序列 - 该值以下可删)。
    pub preserve_sequence_span: u64,
    /// 单轮压力删除的最大段数。
    pub pressure_delete_batch: usize,
}

impl RetentionPolicy {
    /// 为每个段返回 (段 id, 决策, 原因)。
    pub fn choose(
        &self,
        segments: &[SegmentDescriptor],
        now: SystemTime,
        durable_checkpoint: u64,
        disk_pressure_per_mille: u16,
    ) -> Result<Vec<(u64, RetentionDecision, String)>, String> {
        if self.minimum_segments == 0 {
            return Err("retention must preserve at least one segment".to_owned());
        }
        if self.minimum_age > self.maximum_age {
            return Err(format!(
                "retention age range is inverted: {:?}..{:?}",
                self.minimum_age, self.maximum_age
            ));
        }
        if disk_pressure_per_mille > 1_000 {
            return Err("disk pressure must be between zero and 1000 per mille".to_owned());
        }
        let mut ids = BTreeSet::new();
        for descriptor in segments {
            if !ids.insert(descriptor.segment_id) {
                return Err(format!(
                    "retention input repeats segment {}",
                    descriptor.segment_id
                ));
            }
            if descriptor.first_sequence > descriptor.last_sequence && descriptor.last_sequence != 0
            {
                return Err(format!(
                    "segment {} has inverted sequence range {}..{}",
                    descriptor.segment_id, descriptor.first_sequence, descriptor.last_sequence
                ));
            }
        }
        let total_bytes = segments
            .iter()
            .map(|descriptor| descriptor.physical_bytes)
            .fold(0u64, u64::saturating_add);
        let over_budget = total_bytes.saturating_sub(self.maximum_total_bytes);
        let highest_sequence = segments
            .iter()
            .map(|descriptor| descriptor.last_sequence)
            .max()
            .unwrap_or(0);
        let protected_sequence_floor = highest_sequence.saturating_sub(self.preserve_sequence_span);
        // 最新 N 段(按末序列倒序)受到保护。
        let mut newest = segments.iter().collect::<Vec<_>>();
        newest.sort_by_key(|descriptor| {
            std::cmp::Reverse((
                descriptor.last_sequence,
                descriptor.generation,
                descriptor.segment_id,
            ))
        });
        let protected_ids = newest
            .iter()
            .take(self.minimum_segments.min(newest.len()))
            .map(|descriptor| descriptor.segment_id)
            .collect::<BTreeSet<_>>();
        // 第一遍:按优先级逐段打分。
        let mut provisional = BTreeMap::new();
        for descriptor in segments {
            let created_age = now
                .duration_since(descriptor.created_at)
                .unwrap_or(Duration::ZERO);
            let sealed_age = descriptor
                .sealed_at
                .and_then(|sealed| now.duration_since(sealed).ok())
                .unwrap_or(Duration::ZERO);
            let missing_replicas = self
                .required_replicas
                .difference(&descriptor.replica_acks)
                .cloned()
                .collect::<Vec<_>>();
            let decision = if descriptor.state == SegmentState::Quarantined
                || descriptor.checksum_failures > 0
            {
                (
                    RetentionDecision::Quarantine,
                    format!(
                        "segment is {:?} with {} checksum failures",
                        descriptor.state, descriptor.checksum_failures
                    ),
                )
            } else if descriptor.legal_hold {
                (
                    RetentionDecision::DelayForLegalHold,
                    "segment is protected by a legal hold".to_owned(),
                )
            } else if descriptor.reader_leases > 0 {
                (
                    RetentionDecision::DelayForReader,
                    format!(
                        "segment has {} active reader leases",
                        descriptor.reader_leases
                    ),
                )
            } else if !missing_replicas.is_empty() {
                (
                    RetentionDecision::DelayForReplica,
                    format!(
                        "replicas have not acknowledged: {}",
                        missing_replicas.join(", ")
                    ),
                )
            } else if descriptor.state == SegmentState::Active {
                (
                    RetentionDecision::Preserve,
                    "active segment cannot be deleted".to_owned(),
                )
            } else if protected_ids.contains(&descriptor.segment_id) {
                (
                    RetentionDecision::Preserve,
                    format!("segment is among {} newest segments", self.minimum_segments),
                )
            } else if descriptor.last_sequence >= protected_sequence_floor {
                (
                    RetentionDecision::Preserve,
                    format!(
                        "segment covers protected recent sequence span from {protected_sequence_floor}"
                    ),
                )
            } else if descriptor.last_sequence > durable_checkpoint {
                // 超出检查点的数据可能在恢复时仍需要,不能删。
                (
                    RetentionDecision::Preserve,
                    format!(
                        "segment ends at {}, beyond durable checkpoint {durable_checkpoint}",
                        descriptor.last_sequence
                    ),
                )
            } else if sealed_age < self.minimum_age {
                (
                    RetentionDecision::Preserve,
                    format!(
                        "segment has been sealed for {:?}, below minimum {:?}",
                        sealed_age, self.minimum_age
                    ),
                )
            } else if created_age >= self.maximum_age {
                (
                    RetentionDecision::Delete,
                    format!(
                        "segment age {:?} reached maximum {:?}",
                        created_age, self.maximum_age
                    ),
                )
            } else if descriptor.state == SegmentState::Superseded {
                (
                    RetentionDecision::Delete,
                    "segment was superseded by a completed compaction".to_owned(),
                )
            } else {
                (
                    RetentionDecision::Preserve,
                    format!(
                        "segment age {:?} remains inside retention window",
                        created_age
                    ),
                )
            };
            provisional.insert(descriptor.segment_id, decision);
        }
        // 第二遍:磁盘压力(超预算或 ≥850‰)时,把“可删候选”提升为删除。
        if over_budget > 0 || disk_pressure_per_mille >= 850 {
            // 候选条件:目前 Preserve、非最新 N、非 Active、无保留约束、已过检查点、副本齐全。
            let mut pressure_candidates = segments
                .iter()
                .filter(|descriptor| {
                    provisional
                        .get(&descriptor.segment_id)
                        .is_some_and(|entry| entry.0 == RetentionDecision::Preserve)
                        && !protected_ids.contains(&descriptor.segment_id)
                        && descriptor.state != SegmentState::Active
                        && !descriptor.legal_hold
                        && descriptor.reader_leases == 0
                        && descriptor.last_sequence <= durable_checkpoint
                        && self.required_replicas.is_subset(&descriptor.replica_acks)
                })
                .collect::<Vec<_>>();
            // 从最旧到最新、从小到大地删除,优先清小段。
            pressure_candidates.sort_by_key(|descriptor| {
                (
                    descriptor.last_sequence,
                    descriptor.created_at,
                    std::cmp::Reverse(descriptor.physical_bytes),
                    descriptor.segment_id,
                )
            });
            // 已确定的删除量 + 压力等级决定需要回收多少。
            let mut reclaimed = provisional
                .iter()
                .filter(|(_, entry)| entry.0 == RetentionDecision::Delete)
                .filter_map(|(id, _)| {
                    segments
                        .iter()
                        .find(|descriptor| descriptor.segment_id == *id)
                        .map(|descriptor| descriptor.physical_bytes)
                })
                .fold(0u64, u64::saturating_add);
            let desired_reclaim = over_budget.max(if disk_pressure_per_mille >= 950 {
                total_bytes / 5
            } else if disk_pressure_per_mille >= 900 {
                total_bytes / 10
            } else {
                total_bytes / 20
            });
            let mut promoted = 0usize;
            for descriptor in pressure_candidates {
                if reclaimed >= desired_reclaim || promoted >= self.pressure_delete_batch {
                    break;
                }
                provisional.insert(
                    descriptor.segment_id,
                    (
                        RetentionDecision::Delete,
                        format!(
                            "storage pressure {disk_pressure_per_mille} per mille requires reclaim; cumulative {} bytes",
                            reclaimed.saturating_add(descriptor.physical_bytes)
                        ),
                    ),
                );
                reclaimed = reclaimed.saturating_add(descriptor.physical_bytes);
                promoted = promoted.saturating_add(1);
            }
        }
        // 第三遍:保证至少保留 minimum_segments 个段(从删除候选中按最新优先恢复)。
        let mut delete_ids = provisional
            .iter()
            .filter(|(_, entry)| entry.0 == RetentionDecision::Delete)
            .map(|(id, _)| *id)
            .collect::<BTreeSet<_>>();
        let retained_count = segments.len().saturating_sub(delete_ids.len());
        if retained_count < self.minimum_segments {
            let restore_count = self.minimum_segments - retained_count;
            let mut restore = segments
                .iter()
                .filter(|descriptor| delete_ids.contains(&descriptor.segment_id))
                .collect::<Vec<_>>();
            restore.sort_by_key(|descriptor| {
                std::cmp::Reverse((descriptor.last_sequence, descriptor.segment_id))
            });
            for descriptor in restore.into_iter().take(restore_count) {
                delete_ids.remove(&descriptor.segment_id);
                provisional.insert(
                    descriptor.segment_id,
                    (
                        RetentionDecision::Preserve,
                        "restored to satisfy minimum retained segment count".to_owned(),
                    ),
                );
            }
        }
        // 输出:保持输入顺序,未命中的段兜底 Preserve。
        let mut output = segments
            .iter()
            .map(|descriptor| {
                let entry = provisional.remove(&descriptor.segment_id).unwrap_or((
                    RetentionDecision::Preserve,
                    "no retention rule matched".to_owned(),
                ));
                (descriptor.segment_id, entry.0, entry.1)
            })
            .collect::<Vec<_>>();
        output.sort_by_key(|entry| entry.0);
        Ok(output)
    }
}
