use std::collections::{BTreeMap, BTreeSet};

/// 确定性账户分片器:将账户标识映射到固定数量的分区,并保持映射稳定。
///
/// 分区结果只取决于账户字符串、分区总数和盐值,与调用顺序、线程等无关;
/// 因此用于消费端分片时,重放同一批账户总能得到一致的分区归属。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountPartitioner {
    partitions: usize,
    salt: u64,
}

/// 一组账户在分区上的分布统计,用于评估分片是否均匀。
#[derive(Clone, Debug, PartialEq)]
pub struct PartitionBalance {
    /// 每个分区落入的账户数。
    pub counts: Vec<usize>,
    /// 各分区计数的最小值。
    pub minimum: usize,
    /// 各分区计数的最大值。
    pub maximum: usize,
    /// 平均每分区账户数。
    pub average: f64,
    /// 变异系数(标准差/平均值),衡量分片的不均匀程度。
    pub coefficient_of_variation: f64,
    /// 没有任何账户的空分区索引列表。
    pub empty_partitions: Vec<usize>,
}

impl AccountPartitioner {
    /// 创建分片器。分区数必须位于 1 到 65536 之间(上限对应 u16 的容量,便于下游存储分片元数据)。
    pub fn new(partitions: usize, salt: u64) -> Result<Self, String> {
        if partitions == 0 || partitions > 65_536 {
            return Err("partition count must be between one and 65536".to_owned());
        }
        Ok(Self { partitions, salt })
    }

    /// 计算账户归属的分区号。
    ///
    /// 使用 FNV 风格的多轮混合散列:先以盐值异或初态,再逐字节混入账户内容,
    /// 最后取模分区数。盐值用于在调整分区数时打散重映射,避免大量账户集中迁移。
    pub fn partition(&self, account: &str) -> Result<usize, String> {
        let account = account.trim();
        if account.is_empty() {
            return Err("account identity is required".to_owned());
        }
        let mut state = 2_166_136_261_u64 ^ self.salt;
        for byte in account.as_bytes() {
            state ^= u64::from(*byte);
            state = state.wrapping_mul(16_777_619);
            state ^= state >> 29;
        }
        Ok(state as usize % self.partitions)
    }

    /// 将一组账户按分区归类,并保证每个分区内的账户按字典序排序,便于下游批量处理。
    pub fn group<'a>(
        &self,
        accounts: &'a [String],
    ) -> Result<BTreeMap<usize, Vec<&'a str>>, String> {
        let mut result = BTreeMap::new();
        for account in accounts {
            result
                .entry(self.partition(account)?)
                .or_insert_with(Vec::new)
                .push(account.as_str());
        }
        for values in result.values_mut() {
            values.sort_unstable();
        }
        Ok(result)
    }

    /// 计算账户集在各分区上的分布指标,用于校验分片方案是否均衡。
    pub fn balance(&self, accounts: &[String]) -> Result<PartitionBalance, String> {
        let mut counts = vec![0_usize; self.partitions];
        for account in accounts {
            counts[self.partition(account)?] += 1;
        }
        let minimum = counts.iter().copied().min().unwrap_or(0);
        let maximum = counts.iter().copied().max().unwrap_or(0);
        // 平均数为账户总数除以分区数(而不是除以有账户的分区数),用于和最大/最小值对比。
        let average = if counts.is_empty() {
            0.0
        } else {
            accounts.len() as f64 / counts.len() as f64
        };
        let variance = if counts.is_empty() {
            0.0
        } else {
            counts
                .iter()
                .map(|count| (*count as f64 - average).powi(2))
                .sum::<f64>()
                / counts.len() as f64
        };
        // 变异系数越小说明分布越均匀;平均值为 0(空集)时按 0 处理避免除零。
        let coefficient_of_variation = if average == 0.0 {
            0.0
        } else {
            variance.sqrt() / average
        };
        let empty_partitions = counts
            .iter()
            .enumerate()
            .filter_map(|(index, count)| (*count == 0).then_some(index))
            .collect();
        Ok(PartitionBalance {
            counts,
            minimum,
            maximum,
            average,
            coefficient_of_variation,
            empty_partitions,
        })
    }

    /// 对比新旧两个分片方案,找出分区归属发生变化的账户集合。
    ///
    /// 用于评估扩容/缩容或换盐时的迁移成本:只有这些账户需要跨分区搬迁数据。
    pub fn moved_accounts(
        &self,
        replacement: &Self,
        accounts: &[String],
    ) -> Result<BTreeSet<String>, String> {
        let mut moved = BTreeSet::new();
        for account in accounts {
            if self.partition(account)? != replacement.partition(account)? {
                moved.insert(account.clone());
            }
        }
        Ok(moved)
    }
}
