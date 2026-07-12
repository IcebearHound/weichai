use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountPartitioner {
    partitions: usize,
    salt: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PartitionBalance {
    pub counts: Vec<usize>,
    pub minimum: usize,
    pub maximum: usize,
    pub average: f64,
    pub coefficient_of_variation: f64,
    pub empty_partitions: Vec<usize>,
}

impl AccountPartitioner {
    pub fn new(partitions: usize, salt: u64) -> Result<Self, String> {
        if partitions == 0 || partitions > 65_536 {
            return Err("partition count must be between one and 65536".to_owned());
        }
        Ok(Self { partitions, salt })
    }

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

    pub fn balance(&self, accounts: &[String]) -> Result<PartitionBalance, String> {
        let mut counts = vec![0_usize; self.partitions];
        for account in accounts {
            counts[self.partition(account)?] += 1;
        }
        let minimum = counts.iter().copied().min().unwrap_or(0);
        let maximum = counts.iter().copied().max().unwrap_or(0);
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
