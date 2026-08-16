use std::collections::{BTreeMap, BTreeSet};

/// 观察一条序列号后产生的事件,驱动调用方做差异化处理。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SequenceObservation {
    /// 该流的第一条记录。
    First {
        sequence: u64,
    },
    /// 序列号顺延推进(无间隙)。
    Advanced {
        previous: u64,
        sequence: u64,
    },
    /// 出现了新的空洞:之前的 `previous` 与 `sequence` 之间存在缺失序列。
    GapOpened {
        previous: u64,
        sequence: u64,
        missing: Vec<u64>,
    },
    /// 填补了一个此前缺失的序列,`remaining` 是剩余空洞数。
    GapFilled {
        sequence: u64,
        remaining: usize,
    },
    /// 重复观察:该序列号此前已出现。
    Duplicate {
        sequence: u64,
    },
    /// 滞后到达:序列号早于水位,但此前未登记(不属于已登记空洞,属乱序迟达)。
    Behind {
        high_water: u64,
        sequence: u64,
    },
}

/// 单个流的序列状态。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct StreamPosition {
    /// 已观察到的最大序列号。
    high_water: u64,
    /// 所有已观察序列号(用于去重判断)。
    observed: BTreeSet<u64>,
    /// 已知缺失、等待填补的序列号。
    missing: BTreeSet<u64>,
    duplicate_count: u64,
    /// 迟到事件(乱序晚到或被填补的空洞)计数。
    late_count: u64,
}

/// 多流序列账本:按流跟踪观察进度、空洞与迟到/重复统计。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SequenceLedger {
    streams: BTreeMap<String, StreamPosition>,
}

/// 单个流的序列快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SequenceSnapshot {
    pub stream: String,
    pub high_water: u64,
    pub observed_count: usize,
    /// 仍缺失的序列号(升序)。
    pub missing: Vec<u64>,
    pub duplicate_count: u64,
    pub late_count: u64,
}

impl SequenceLedger {
    /// 登记一条序列观察并返回对应事件。
    ///
    /// 分类优先级:重复 → 首条 → 填补空洞 → 迟到 → 顺延/开新洞。
    pub fn observe(&mut self, stream: &str, sequence: u64) -> Result<SequenceObservation, String> {
        let stream = stream.trim();
        if stream.is_empty() {
            return Err("stream identity is required".to_owned());
        }
        // 序列号 0 保留作“尚未开始”哨兵。
        if sequence == 0 {
            return Err("sequence must be positive".to_owned());
        }
        let position = self.streams.entry(stream.to_owned()).or_default();
        if position.observed.contains(&sequence) {
            position.duplicate_count = position.duplicate_count.saturating_add(1);
            return Ok(SequenceObservation::Duplicate { sequence });
        }
        position.observed.insert(sequence);
        // 首条观察:若从非 1 开始,则 1..sequence 全部登记为缺失。
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
        // 命中已知空洞:记为迟到并返回剩余空洞数。
        if position.missing.remove(&sequence) {
            position.late_count = position.late_count.saturating_add(1);
            return Ok(SequenceObservation::GapFilled {
                sequence,
                remaining: position.missing.len(),
            });
        }
        // 低于水位且不在空洞中:纯乱序迟达。
        if sequence < position.high_water {
            position.late_count = position.late_count.saturating_add(1);
            return Ok(SequenceObservation::Behind {
                high_water: position.high_water,
                sequence,
            });
        }
        let previous = position.high_water;
        position.high_water = sequence;
        // 跳号:中间未观察过的序列成为新空洞(已观察过的部分不算缺失)。
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

    /// 返回流的当前水位。
    pub fn high_water(&self, stream: &str) -> Option<u64> {
        self.streams.get(stream).map(|position| position.high_water)
    }

    /// 返回流当前缺失的序列号列表。
    pub fn missing(&self, stream: &str) -> Vec<u64> {
        self.streams
            .get(stream)
            .map(|position| position.missing.iter().copied().collect())
            .unwrap_or_default()
    }

    /// 返回流已连续处理到的序列号:即第一个空洞之前的序列号(无空洞时为水位)。
    pub fn contiguous_through(&self, stream: &str) -> Option<u64> {
        let position = self.streams.get(stream)?;
        match position.missing.first() {
            Some(first_gap) => Some(first_gap.saturating_sub(1)),
            None => Some(position.high_water),
        }
    }

    /// 所有流的快照,按流名排序输出。
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

    /// 将另一个账本的观察历史重放进本账本,返回全部事件。
    /// 用于合并两个副本/分区的进度,天然保持去重语义。
    pub fn merge(&mut self, other: &Self) -> Result<Vec<SequenceObservation>, String> {
        let mut outcomes = Vec::new();
        for (stream, position) in &other.streams {
            for sequence in &position.observed {
                outcomes.push(self.observe(stream, *sequence)?);
            }
        }
        Ok(outcomes)
    }

    /// 剪除 <= `sequence` 的已观察与缺失记录,释放内存;返回移除的已观察记录数。
    /// 调用方保证这些序列已持久化(例如已写入检查点)后才可安全调用。
    pub fn prune_observed_through(&mut self, stream: &str, sequence: u64) -> usize {
        let Some(position) = self.streams.get_mut(stream) else {
            return 0;
        };
        let before = position.observed.len();
        position.observed.retain(|value| *value > sequence);
        position.missing.retain(|value| *value > sequence);
        before - position.observed.len()
    }

    /// 移除整个流;返回该流是否存在。
    pub fn remove_stream(&mut self, stream: &str) -> bool {
        self.streams.remove(stream).is_some()
    }
}
