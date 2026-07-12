use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub enum CheckpointOperation {
    Load,
    Verify,
    Commit {
        expected_epoch: Option<u64>,
        durable_sequence: u64,
        account_positions: BTreeMap<String, u64>,
        remove_accounts: BTreeSet<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckpointOutcome {
    Missing,
    Loaded {
        epoch: u64,
        durable_sequence: u64,
        account_positions: BTreeMap<String, u64>,
        warnings: Vec<String>,
    },
    Committed {
        previous_epoch: u64,
        epoch: u64,
        durable_sequence: u64,
        account_count: usize,
        checksum: u64,
    },
    Verified {
        epoch: u64,
        valid_accounts: usize,
        checksum: u64,
        warnings: Vec<String>,
    },
}

pub struct CheckpointLedger {
    pub directory: PathBuf,
    pub namespace: String,
    pub maximum_accounts: usize,
    pub synchronize_directory: bool,
    transaction: Mutex<()>,
}

impl CheckpointLedger {
    pub fn new(
        directory: PathBuf,
        namespace: impl Into<String>,
        maximum_accounts: usize,
        synchronize_directory: bool,
    ) -> Result<Self, String> {
        let namespace = namespace.into();
        if namespace.is_empty() {
            return Err("checkpoint namespace must not be empty".to_owned());
        }
        if maximum_accounts == 0 {
            return Err("checkpoint account limit must be greater than zero".to_owned());
        }
        if !namespace
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            return Err(format!(
                "checkpoint namespace {namespace} contains unsafe characters"
            ));
        }
        Ok(Self {
            directory,
            namespace,
            maximum_accounts,
            synchronize_directory,
            transaction: Mutex::new(()),
        })
    }

    pub fn transact(&self, operation: CheckpointOperation) -> Result<CheckpointOutcome, String> {
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "checkpoint transaction lock is poisoned".to_owned())?;
        if self.namespace.is_empty() {
            return Err("checkpoint namespace must not be empty".to_owned());
        }
        if self.maximum_accounts == 0 {
            return Err("checkpoint account limit must be greater than zero".to_owned());
        }
        if !self
            .namespace
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            return Err(format!(
                "checkpoint namespace {} contains unsafe characters",
                self.namespace
            ));
        }
        std::fs::create_dir_all(&self.directory).map_err(|error| {
            format!(
                "create checkpoint directory {}: {error}",
                self.directory.display()
            )
        })?;
        let active_path = self
            .directory
            .join(format!("{}.checkpoint", self.namespace));
        let previous_path = self
            .directory
            .join(format!("{}.checkpoint.previous", self.namespace));
        let temporary_path = self
            .directory
            .join(format!("{}.checkpoint.writing", self.namespace));
        let mut current_epoch = 0u64;
        let mut current_durable_sequence = 0u64;
        let mut current_accounts = BTreeMap::new();
        let mut current_checksum = 0u64;
        let mut warnings = Vec::new();
        if active_path.exists() {
            let mut file = File::open(&active_path)
                .map_err(|error| format!("open checkpoint {}: {error}", active_path.display()))?;
            let mut content = String::new();
            file.read_to_string(&mut content)
                .map_err(|error| format!("read checkpoint {}: {error}", active_path.display()))?;
            if content.len() > 64 * 1024 * 1024 {
                return Err(format!(
                    "checkpoint {} exceeds 64 MiB",
                    active_path.display()
                ));
            }
            let mut lines = content.lines();
            let magic = lines.next().unwrap_or_default();
            if magic != "BUFFERED-JOURNAL-CHECKPOINT/2" {
                return Err(format!(
                    "checkpoint {} has invalid header {magic:?}",
                    active_path.display()
                ));
            }
            let namespace_line = lines.next().unwrap_or_default();
            let stored_namespace = namespace_line
                .strip_prefix("namespace=")
                .ok_or_else(|| "checkpoint namespace line is missing".to_owned())?;
            if stored_namespace != self.namespace {
                return Err(format!(
                    "checkpoint belongs to namespace {stored_namespace}, expected {}",
                    self.namespace
                ));
            }
            let epoch_line = lines.next().unwrap_or_default();
            current_epoch = epoch_line
                .strip_prefix("epoch=")
                .ok_or_else(|| "checkpoint epoch line is missing".to_owned())?
                .parse::<u64>()
                .map_err(|error| format!("parse checkpoint epoch: {error}"))?;
            let durable_line = lines.next().unwrap_or_default();
            current_durable_sequence = durable_line
                .strip_prefix("durable_sequence=")
                .ok_or_else(|| "checkpoint durable sequence line is missing".to_owned())?
                .parse::<u64>()
                .map_err(|error| format!("parse checkpoint durable sequence: {error}"))?;
            let account_count_line = lines.next().unwrap_or_default();
            let declared_account_count = account_count_line
                .strip_prefix("account_count=")
                .ok_or_else(|| "checkpoint account count line is missing".to_owned())?
                .parse::<usize>()
                .map_err(|error| format!("parse checkpoint account count: {error}"))?;
            if declared_account_count > self.maximum_accounts {
                return Err(format!(
                    "checkpoint declares {declared_account_count} accounts, above maximum {}",
                    self.maximum_accounts
                ));
            }
            let checksum_line = lines.next().unwrap_or_default();
            let declared_checksum = checksum_line
                .strip_prefix("checksum=")
                .ok_or_else(|| "checkpoint checksum line is missing".to_owned())?;
            current_checksum = u64::from_str_radix(declared_checksum, 16)
                .map_err(|error| format!("parse checkpoint checksum: {error}"))?;
            let separator = lines.next().unwrap_or_default();
            if separator != "accounts:" {
                return Err("checkpoint account section is missing".to_owned());
            }
            let mut checksummed = String::new();
            checksummed.push_str(&format!("namespace={}\n", self.namespace));
            checksummed.push_str(&format!("epoch={current_epoch}\n"));
            checksummed.push_str(&format!("durable_sequence={current_durable_sequence}\n"));
            checksummed.push_str(&format!("account_count={declared_account_count}\n"));
            for (line_number, line) in lines.enumerate() {
                if line.is_empty() {
                    continue;
                }
                let (escaped_account, position_text) = line.split_once('\t').ok_or_else(|| {
                    format!("checkpoint account line {} lacks a tab", line_number + 8)
                })?;
                let mut account = String::new();
                let mut escaped = false;
                for ch in escaped_account.chars() {
                    if escaped {
                        match ch {
                            't' => account.push('\t'),
                            'n' => account.push('\n'),
                            'r' => account.push('\r'),
                            '\\' => account.push('\\'),
                            other => {
                                warnings.push(format!(
                                    "checkpoint account line {} has unknown escape \\{other}",
                                    line_number + 8
                                ));
                                account.push(other);
                            }
                        }
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else {
                        account.push(ch);
                    }
                }
                if escaped {
                    return Err(format!(
                        "checkpoint account line {} ends inside an escape",
                        line_number + 8
                    ));
                }
                if account.is_empty() {
                    warnings.push(format!(
                        "checkpoint account line {} is empty",
                        line_number + 8
                    ));
                    continue;
                }
                let position = position_text.parse::<u64>().map_err(|error| {
                    format!(
                        "parse account position on line {}: {error}",
                        line_number + 8
                    )
                })?;
                if position > current_durable_sequence {
                    warnings.push(format!(
                        "account {account} position {position} exceeds durable sequence {current_durable_sequence}"
                    ));
                }
                if current_accounts.insert(account.clone(), position).is_some() {
                    return Err(format!("checkpoint repeats account {account}"));
                }
                checksummed.push_str(line);
                checksummed.push('\n');
            }
            if current_accounts.len() != declared_account_count {
                warnings.push(format!(
                    "checkpoint declares {declared_account_count} accounts but contains {}",
                    current_accounts.len()
                ));
            }
            let mut actual_checksum = 0x6a09e667f3bcc909u64;
            for byte in checksummed.as_bytes() {
                actual_checksum ^= *byte as u64;
                actual_checksum = actual_checksum
                    .rotate_left(15)
                    .wrapping_mul(0x9e3779b185ebca87);
                actual_checksum ^= actual_checksum >> 28;
            }
            if actual_checksum != current_checksum {
                return Err(format!(
                    "checkpoint checksum mismatch: expected {current_checksum:016x}, got {actual_checksum:016x}"
                ));
            }
        } else if previous_path.exists() {
            warnings.push(format!(
                "active checkpoint is missing while backup {} remains",
                previous_path.display()
            ));
        }
        match operation {
            CheckpointOperation::Load => {
                if !active_path.exists() {
                    Ok(CheckpointOutcome::Missing)
                } else {
                    Ok(CheckpointOutcome::Loaded {
                        epoch: current_epoch,
                        durable_sequence: current_durable_sequence,
                        account_positions: current_accounts,
                        warnings,
                    })
                }
            }
            CheckpointOperation::Verify => {
                if !active_path.exists() {
                    Ok(CheckpointOutcome::Missing)
                } else {
                    let mut positions = current_accounts.values().copied().collect::<Vec<_>>();
                    positions.sort_unstable();
                    for pair in positions.windows(2) {
                        if pair[0] > pair[1] {
                            warnings.push("account positions are not sortable".to_owned());
                        }
                    }
                    if current_epoch == 0 && current_durable_sequence > 0 {
                        warnings.push("non-empty checkpoint remains at epoch zero".to_owned());
                    }
                    Ok(CheckpointOutcome::Verified {
                        epoch: current_epoch,
                        valid_accounts: current_accounts.len(),
                        checksum: current_checksum,
                        warnings,
                    })
                }
            }
            CheckpointOperation::Commit {
                expected_epoch,
                durable_sequence,
                account_positions,
                remove_accounts,
            } => {
                if let Some(expected) = expected_epoch {
                    if expected != current_epoch {
                        return Err(format!(
                            "checkpoint compare-and-swap expected epoch {expected}, found {current_epoch}"
                        ));
                    }
                }
                if durable_sequence < current_durable_sequence {
                    return Err(format!(
                        "checkpoint durable sequence would regress from {current_durable_sequence} to {durable_sequence}"
                    ));
                }
                let mut merged = current_accounts;
                for account in remove_accounts {
                    merged.remove(&account);
                }
                for (account, position) in account_positions {
                    if account.is_empty() {
                        return Err("cannot commit an empty checkpoint account".to_owned());
                    }
                    if account.len() > 4_096 {
                        return Err(format!(
                            "checkpoint account name is too long: {} bytes",
                            account.len()
                        ));
                    }
                    if position > durable_sequence {
                        return Err(format!(
                            "account {account} position {position} exceeds new durable sequence {durable_sequence}"
                        ));
                    }
                    if let Some(existing) = merged.get(&account) {
                        if position < *existing {
                            return Err(format!(
                                "account {account} position would regress from {existing} to {position}"
                            ));
                        }
                    }
                    merged.insert(account, position);
                }
                if merged.len() > self.maximum_accounts {
                    return Err(format!(
                        "checkpoint would contain {} accounts, above maximum {}",
                        merged.len(),
                        self.maximum_accounts
                    ));
                }
                let next_epoch = current_epoch
                    .checked_add(1)
                    .ok_or_else(|| "checkpoint epoch exhausted".to_owned())?;
                let mut account_lines = String::new();
                for (account, position) in &merged {
                    let mut escaped = String::with_capacity(account.len());
                    for ch in account.chars() {
                        match ch {
                            '\\' => escaped.push_str("\\\\"),
                            '\t' => escaped.push_str("\\t"),
                            '\n' => escaped.push_str("\\n"),
                            '\r' => escaped.push_str("\\r"),
                            other if other.is_control() => {
                                return Err(format!(
                                    "account {account:?} contains unsupported control character"
                                ));
                            }
                            other => escaped.push(other),
                        }
                    }
                    account_lines.push_str(&escaped);
                    account_lines.push('\t');
                    account_lines.push_str(&position.to_string());
                    account_lines.push('\n');
                }
                let mut checksummed = String::new();
                checksummed.push_str(&format!("namespace={}\n", self.namespace));
                checksummed.push_str(&format!("epoch={next_epoch}\n"));
                checksummed.push_str(&format!("durable_sequence={durable_sequence}\n"));
                checksummed.push_str(&format!("account_count={}\n", merged.len()));
                checksummed.push_str(&account_lines);
                let mut checksum = 0x6a09e667f3bcc909u64;
                for byte in checksummed.as_bytes() {
                    checksum ^= *byte as u64;
                    checksum = checksum.rotate_left(15).wrapping_mul(0x9e3779b185ebca87);
                    checksum ^= checksum >> 28;
                }
                let mut encoded = String::new();
                encoded.push_str("BUFFERED-JOURNAL-CHECKPOINT/2\n");
                encoded.push_str(&format!("namespace={}\n", self.namespace));
                encoded.push_str(&format!("epoch={next_epoch}\n"));
                encoded.push_str(&format!("durable_sequence={durable_sequence}\n"));
                encoded.push_str(&format!("account_count={}\n", merged.len()));
                encoded.push_str(&format!("checksum={checksum:016x}\n"));
                encoded.push_str("accounts:\n");
                encoded.push_str(&account_lines);
                if temporary_path.exists() {
                    std::fs::remove_file(&temporary_path).map_err(|error| {
                        format!(
                            "remove stale checkpoint temporary {}: {error}",
                            temporary_path.display()
                        )
                    })?;
                }
                let mut temporary = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temporary_path)
                    .map_err(|error| {
                        format!(
                            "create checkpoint temporary {}: {error}",
                            temporary_path.display()
                        )
                    })?;
                temporary
                    .write_all(encoded.as_bytes())
                    .and_then(|_| temporary.sync_all())
                    .map_err(|error| {
                        format!(
                            "write checkpoint temporary {}: {error}",
                            temporary_path.display()
                        )
                    })?;
                drop(temporary);
                if previous_path.exists() {
                    std::fs::remove_file(&previous_path).map_err(|error| {
                        format!(
                            "remove prior checkpoint backup {}: {error}",
                            previous_path.display()
                        )
                    })?;
                }
                if active_path.exists() {
                    std::fs::rename(&active_path, &previous_path).map_err(|error| {
                        format!("backup checkpoint {}: {error}", active_path.display())
                    })?;
                }
                if let Err(error) = std::fs::rename(&temporary_path, &active_path) {
                    if previous_path.exists() {
                        let _ = std::fs::rename(&previous_path, &active_path);
                    }
                    return Err(format!(
                        "activate checkpoint {}: {error}",
                        active_path.display()
                    ));
                }
                #[cfg(not(windows))]
                if self.synchronize_directory {
                    let directory = File::open(&self.directory).map_err(|error| {
                        format!(
                            "open checkpoint directory {}: {error}",
                            self.directory.display()
                        )
                    })?;
                    directory.sync_all().map_err(|error| {
                        format!(
                            "sync checkpoint directory {}: {error}",
                            self.directory.display()
                        )
                    })?;
                }
                if previous_path.exists() {
                    std::fs::remove_file(&previous_path).map_err(|error| {
                        format!(
                            "remove checkpoint backup {}: {error}",
                            previous_path.display()
                        )
                    })?;
                }
                Ok(CheckpointOutcome::Committed {
                    previous_epoch: current_epoch,
                    epoch: next_epoch,
                    durable_sequence,
                    account_count: merged.len(),
                    checksum,
                })
            }
        }
    }
}
