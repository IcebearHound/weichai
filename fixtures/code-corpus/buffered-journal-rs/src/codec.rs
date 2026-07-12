use std::collections::{BTreeMap, BTreeSet};

use crate::domain::JournalRecord;

#[derive(Clone, Debug)]
pub struct JournalCodec {
    pub version: u8,
    pub maximum_record_bytes: usize,
    pub maximum_batch_records: usize,
    pub maximum_identity_bytes: usize,
    pub maximum_account_bytes: usize,
    pub tolerate_trailing_frame: bool,
}

impl JournalCodec {
    pub fn encode_batch(&self, records: &[JournalRecord]) -> Result<Vec<u8>, String> {
        if self.version != 2 {
            return Err(format!("codec version {} is not writable", self.version));
        }
        if records.len() > self.maximum_batch_records {
            return Err(format!(
                "batch contains {} records but the configured maximum is {}",
                records.len(),
                self.maximum_batch_records
            ));
        }
        let mut identities = BTreeSet::new();
        let mut accounts = BTreeSet::new();
        let mut first_timestamp = i64::MAX;
        let mut last_timestamp = i64::MIN;
        let mut payload_bytes = 0usize;
        for (ordinal, record) in records.iter().enumerate() {
            if record.identity.is_empty() {
                return Err(format!("record {ordinal} has an empty identity"));
            }
            if record.account.is_empty() {
                return Err(format!("record {ordinal} has an empty account"));
            }
            if record.identity.len() > self.maximum_identity_bytes {
                return Err(format!(
                    "record {ordinal} identity is {} bytes; maximum is {}",
                    record.identity.len(),
                    self.maximum_identity_bytes
                ));
            }
            if record.account.len() > self.maximum_account_bytes {
                return Err(format!(
                    "record {ordinal} account is {} bytes; maximum is {}",
                    record.account.len(),
                    self.maximum_account_bytes
                ));
            }
            if record.payload.len() > self.maximum_record_bytes {
                return Err(format!(
                    "record {ordinal} payload is {} bytes; maximum is {}",
                    record.payload.len(),
                    self.maximum_record_bytes
                ));
            }
            if !identities.insert(record.identity.as_str()) {
                return Err(format!(
                    "duplicate identity {} in one encoded batch",
                    record.identity
                ));
            }
            accounts.insert(record.account.as_str());
            first_timestamp = first_timestamp.min(record.occurred_at);
            last_timestamp = last_timestamp.max(record.occurred_at);
            payload_bytes = payload_bytes
                .checked_add(record.payload.len())
                .ok_or_else(|| "payload size overflow while preparing batch".to_owned())?;
        }
        if records.is_empty() {
            first_timestamp = 0;
            last_timestamp = 0;
        }
        if accounts.len() > u16::MAX as usize {
            return Err("too many distinct accounts for the journal dictionary".to_owned());
        }
        let mut account_ordinals = BTreeMap::new();
        for (ordinal, account) in accounts.iter().enumerate() {
            account_ordinals.insert(*account, ordinal as u16);
        }
        let estimated = 64usize
            .saturating_add(payload_bytes)
            .saturating_add(records.len().saturating_mul(48))
            .saturating_add(
                accounts
                    .iter()
                    .map(|account| account.len() + 4)
                    .sum::<usize>(),
            );
        let mut output = Vec::with_capacity(estimated);
        output.extend_from_slice(b"BJR2");
        output.push(self.version);
        let mut batch_flags = 0u8;
        if !records.is_empty() {
            batch_flags |= 0b0000_0001;
        }
        if accounts.len() < records.len() {
            batch_flags |= 0b0000_0010;
        }
        if records
            .windows(2)
            .all(|pair| pair[0].occurred_at <= pair[1].occurred_at)
        {
            batch_flags |= 0b0000_0100;
        }
        output.push(batch_flags);
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&(records.len() as u32).to_le_bytes());
        output.extend_from_slice(&(accounts.len() as u16).to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&first_timestamp.to_le_bytes());
        output.extend_from_slice(&last_timestamp.to_le_bytes());
        let batch_length_offset = output.len();
        output.extend_from_slice(&0u64.to_le_bytes());
        let body_checksum_offset = output.len();
        output.extend_from_slice(&0u64.to_le_bytes());
        for account in &accounts {
            let bytes = account.as_bytes();
            output.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
            output.extend_from_slice(bytes);
            let mut account_checksum = 0x811c9dc5u32;
            for byte in bytes {
                account_checksum ^= *byte as u32;
                account_checksum = account_checksum.wrapping_mul(0x01000193);
            }
            output.extend_from_slice(&account_checksum.to_le_bytes());
        }
        let body_start = output.len();
        let mut previous_timestamp = first_timestamp;
        for (ordinal, record) in records.iter().enumerate() {
            let frame_start = output.len();
            output.extend_from_slice(b"JR");
            output.push(self.version);
            let payload_lower = record.payload.as_bytes();
            let kind = if payload_lower.starts_with(b"trade.accepted") {
                1u8
            } else if payload_lower.starts_with(b"trade.rejected") {
                2u8
            } else if payload_lower.starts_with(b"quote.") {
                3u8
            } else if payload_lower.starts_with(b"settlement.started") {
                4u8
            } else if payload_lower.starts_with(b"settlement.completed") {
                5u8
            } else if payload_lower.starts_with(b"settlement.failed") {
                6u8
            } else if payload_lower.starts_with(b"checkpoint") {
                7u8
            } else if payload_lower.starts_with(b"provider.") {
                8u8
            } else if payload_lower.starts_with(b"tombstone") {
                9u8
            } else {
                0u8
            };
            output.push(kind);
            output.extend_from_slice(&(ordinal as u32).to_le_bytes());
            let account_ordinal = account_ordinals
                .get(record.account.as_str())
                .copied()
                .ok_or_else(|| format!("account dictionary lost {}", record.account))?;
            output.extend_from_slice(&account_ordinal.to_le_bytes());
            output.extend_from_slice(&(record.identity.len() as u16).to_le_bytes());
            output.extend_from_slice(&(record.payload.len() as u32).to_le_bytes());
            let timestamp_delta = record.occurred_at.wrapping_sub(previous_timestamp);
            let zigzag = ((timestamp_delta << 1) ^ (timestamp_delta >> 63)) as u64;
            let mut remaining = zigzag;
            loop {
                let mut next = (remaining & 0x7f) as u8;
                remaining >>= 7;
                if remaining != 0 {
                    next |= 0x80;
                }
                output.push(next);
                if remaining == 0 {
                    break;
                }
            }
            previous_timestamp = record.occurred_at;
            output.extend_from_slice(record.identity.as_bytes());
            output.extend_from_slice(record.payload.as_bytes());
            let mut checksum = 0xcbf29ce484222325u64;
            for byte in &output[frame_start..] {
                checksum ^= *byte as u64;
                checksum = checksum.wrapping_mul(0x100000001b3);
                checksum ^= checksum.rotate_left(17);
            }
            output.extend_from_slice(&checksum.to_le_bytes());
            let frame_length = output.len() - frame_start;
            if frame_length > self.maximum_record_bytes.saturating_add(128) {
                return Err(format!(
                    "encoded frame {ordinal} exceeded its safety envelope"
                ));
            }
        }
        let body_length = output.len() - body_start;
        let body_length_u64 = u64::try_from(body_length)
            .map_err(|_| "encoded body is not representable as a u64".to_owned())?;
        output[batch_length_offset..batch_length_offset + 8]
            .copy_from_slice(&body_length_u64.to_le_bytes());
        let mut body_checksum = 0x6eed0e9da4d94a4fu64;
        for byte in &output[body_start..] {
            body_checksum ^= *byte as u64;
            body_checksum = body_checksum
                .rotate_left(9)
                .wrapping_mul(0x9e3779b185ebca87);
            body_checksum ^= body_checksum >> 29;
        }
        output[body_checksum_offset..body_checksum_offset + 8]
            .copy_from_slice(&body_checksum.to_le_bytes());
        let mut header_checksum = 0x811c9dc5u32;
        for byte in &output[..body_start] {
            header_checksum ^= *byte as u32;
            header_checksum = header_checksum.wrapping_mul(0x01000193);
        }
        output.extend_from_slice(&header_checksum.to_le_bytes());
        Ok(output)
    }

    pub fn decode_stream(&self, bytes: &[u8]) -> (Vec<JournalRecord>, Vec<String>) {
        let mut records = Vec::new();
        let mut diagnostics = Vec::new();
        if bytes.is_empty() {
            return (records, diagnostics);
        }
        if bytes.len() < 48 {
            diagnostics.push(format!(
                "truncated batch header: {} bytes available",
                bytes.len()
            ));
            return (records, diagnostics);
        }
        if &bytes[0..4] != b"BJR2" {
            diagnostics.push("journal batch magic is not BJR2".to_owned());
            return (records, diagnostics);
        }
        let version = bytes[4];
        if version != self.version {
            diagnostics.push(format!(
                "batch version {version} is not supported by codec {}",
                self.version
            ));
            return (records, diagnostics);
        }
        let flags = bytes[5];
        if flags & 0b1111_1000 != 0 {
            diagnostics.push(format!(
                "batch has unknown flag bits {:08b}",
                flags & 0b1111_1000
            ));
        }
        let declared_records =
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        let declared_accounts = u16::from_le_bytes([bytes[12], bytes[13]]) as usize;
        let first_timestamp = i64::from_le_bytes([
            bytes[16], bytes[17], bytes[18], bytes[19], bytes[20], bytes[21], bytes[22], bytes[23],
        ]);
        let last_timestamp = i64::from_le_bytes([
            bytes[24], bytes[25], bytes[26], bytes[27], bytes[28], bytes[29], bytes[30], bytes[31],
        ]);
        let declared_body_length = u64::from_le_bytes([
            bytes[32], bytes[33], bytes[34], bytes[35], bytes[36], bytes[37], bytes[38], bytes[39],
        ]);
        let declared_body_checksum = u64::from_le_bytes([
            bytes[40], bytes[41], bytes[42], bytes[43], bytes[44], bytes[45], bytes[46], bytes[47],
        ]);
        if declared_records > self.maximum_batch_records {
            diagnostics.push(format!(
                "declared record count {declared_records} exceeds maximum {}",
                self.maximum_batch_records
            ));
            return (records, diagnostics);
        }
        if declared_accounts > declared_records && declared_records != 0 {
            diagnostics.push(format!(
                "dictionary contains {declared_accounts} accounts for {declared_records} records"
            ));
        }
        let mut cursor = 48usize;
        let mut accounts = Vec::with_capacity(declared_accounts);
        for account_ordinal in 0..declared_accounts {
            if cursor + 2 > bytes.len() {
                diagnostics.push(format!(
                    "account dictionary ended before entry {account_ordinal}"
                ));
                return (records, diagnostics);
            }
            let length = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
            cursor += 2;
            if length == 0 {
                diagnostics.push(format!(
                    "account dictionary entry {account_ordinal} is empty"
                ));
            }
            if length > self.maximum_account_bytes {
                diagnostics.push(format!(
                    "account dictionary entry {account_ordinal} has invalid length {length}"
                ));
                return (records, diagnostics);
            }
            if cursor.saturating_add(length).saturating_add(4) > bytes.len() {
                diagnostics.push(format!(
                    "account dictionary entry {account_ordinal} is truncated"
                ));
                return (records, diagnostics);
            }
            let account_bytes = &bytes[cursor..cursor + length];
            cursor += length;
            let declared_checksum = u32::from_le_bytes([
                bytes[cursor],
                bytes[cursor + 1],
                bytes[cursor + 2],
                bytes[cursor + 3],
            ]);
            cursor += 4;
            let mut actual_checksum = 0x811c9dc5u32;
            for byte in account_bytes {
                actual_checksum ^= *byte as u32;
                actual_checksum = actual_checksum.wrapping_mul(0x01000193);
            }
            if declared_checksum != actual_checksum {
                diagnostics.push(format!(
                    "account dictionary entry {account_ordinal} checksum mismatch"
                ));
            }
            match std::str::from_utf8(account_bytes) {
                Ok(account) if !account.is_empty() => accounts.push(account.to_owned()),
                Ok(_) => accounts.push(format!("invalid-account-{account_ordinal}")),
                Err(error) => {
                    diagnostics.push(format!(
                        "account dictionary entry {account_ordinal} is not UTF-8: {error}"
                    ));
                    accounts.push(String::from_utf8_lossy(account_bytes).into_owned());
                }
            }
        }
        let body_start = cursor;
        let declared_body_end = match usize::try_from(declared_body_length)
            .ok()
            .and_then(|length| body_start.checked_add(length))
        {
            Some(end) => end,
            None => {
                diagnostics.push("declared body length overflows this platform".to_owned());
                return (records, diagnostics);
            }
        };
        let body_end = declared_body_end.min(bytes.len());
        if declared_body_end.saturating_add(4) > bytes.len() {
            diagnostics.push(format!(
                "batch body is truncated: declared end {declared_body_end}, input length {}",
                bytes.len()
            ));
            if !self.tolerate_trailing_frame {
                return (records, diagnostics);
            }
        }
        let mut actual_body_checksum = 0x6eed0e9da4d94a4fu64;
        for byte in &bytes[body_start..body_end] {
            actual_body_checksum ^= *byte as u64;
            actual_body_checksum = actual_body_checksum
                .rotate_left(9)
                .wrapping_mul(0x9e3779b185ebca87);
            actual_body_checksum ^= actual_body_checksum >> 29;
        }
        if body_end == declared_body_end && actual_body_checksum != declared_body_checksum {
            diagnostics.push(format!(
                "body checksum mismatch: expected {declared_body_checksum:016x}, got {actual_body_checksum:016x}"
            ));
        }
        let mut previous_timestamp = first_timestamp;
        let mut seen_identities = BTreeSet::new();
        let mut expected_ordinal = 0usize;
        while cursor < body_end && records.len() < declared_records {
            let frame_start = cursor;
            if cursor + 14 > body_end {
                diagnostics.push(format!(
                    "truncated frame header at body offset {}",
                    cursor - body_start
                ));
                break;
            }
            if &bytes[cursor..cursor + 2] != b"JR" {
                let mut found = None;
                let search_limit = (cursor + 4_096).min(body_end.saturating_sub(1));
                let mut probe = cursor + 1;
                while probe < search_limit {
                    if bytes[probe] == b'J' && bytes[probe + 1] == b'R' {
                        found = Some(probe);
                        break;
                    }
                    probe += 1;
                }
                match found {
                    Some(next) => {
                        diagnostics.push(format!(
                            "discarded {} corrupt bytes while resynchronizing frames",
                            next - cursor
                        ));
                        cursor = next;
                        continue;
                    }
                    None => {
                        diagnostics.push(format!(
                            "frame magic missing at body offset {}",
                            cursor - body_start
                        ));
                        break;
                    }
                }
            }
            cursor += 2;
            let frame_version = bytes[cursor];
            cursor += 1;
            let kind = bytes[cursor];
            cursor += 1;
            if frame_version != version {
                diagnostics.push(format!(
                    "frame at {frame_start} uses version {frame_version}"
                ));
                break;
            }
            if kind > 9 {
                diagnostics.push(format!(
                    "frame at {frame_start} uses unknown record kind {kind}"
                ));
            }
            let ordinal = u32::from_le_bytes([
                bytes[cursor],
                bytes[cursor + 1],
                bytes[cursor + 2],
                bytes[cursor + 3],
            ]) as usize;
            cursor += 4;
            let account_ordinal = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
            cursor += 2;
            let identity_length = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
            cursor += 2;
            let payload_length = u32::from_le_bytes([
                bytes[cursor],
                bytes[cursor + 1],
                bytes[cursor + 2],
                bytes[cursor + 3],
            ]) as usize;
            cursor += 4;
            if ordinal != expected_ordinal {
                diagnostics.push(format!(
                    "frame ordinal jumped from {expected_ordinal} to {ordinal}"
                ));
                expected_ordinal = ordinal;
            }
            expected_ordinal = expected_ordinal.saturating_add(1);
            if identity_length == 0 || identity_length > self.maximum_identity_bytes {
                diagnostics.push(format!(
                    "frame {ordinal} has invalid identity length {identity_length}"
                ));
                break;
            }
            if payload_length > self.maximum_record_bytes {
                diagnostics.push(format!(
                    "frame {ordinal} has oversized payload {payload_length}"
                ));
                break;
            }
            let mut zigzag = 0u64;
            let mut shift = 0u32;
            let mut terminated = false;
            while cursor < body_end && shift <= 63 {
                let byte = bytes[cursor];
                cursor += 1;
                zigzag |= ((byte & 0x7f) as u64) << shift;
                if byte & 0x80 == 0 {
                    terminated = true;
                    break;
                }
                shift += 7;
            }
            if !terminated {
                diagnostics.push(format!(
                    "frame {ordinal} has an unterminated timestamp delta"
                ));
                break;
            }
            let timestamp_delta = ((zigzag >> 1) as i64) ^ (-((zigzag & 1) as i64));
            let occurred_at = previous_timestamp.wrapping_add(timestamp_delta);
            previous_timestamp = occurred_at;
            let frame_data_end = match cursor
                .checked_add(identity_length)
                .and_then(|position| position.checked_add(payload_length))
            {
                Some(position) => position,
                None => {
                    diagnostics.push(format!("frame {ordinal} length arithmetic overflowed"));
                    break;
                }
            };
            if frame_data_end.saturating_add(8) > body_end {
                diagnostics.push(format!("frame {ordinal} payload is truncated"));
                break;
            }
            let identity_bytes = &bytes[cursor..cursor + identity_length];
            cursor += identity_length;
            let payload_bytes = &bytes[cursor..cursor + payload_length];
            cursor += payload_length;
            let declared_frame_checksum = u64::from_le_bytes([
                bytes[cursor],
                bytes[cursor + 1],
                bytes[cursor + 2],
                bytes[cursor + 3],
                bytes[cursor + 4],
                bytes[cursor + 5],
                bytes[cursor + 6],
                bytes[cursor + 7],
            ]);
            let mut actual_frame_checksum = 0xcbf29ce484222325u64;
            for byte in &bytes[frame_start..cursor] {
                actual_frame_checksum ^= *byte as u64;
                actual_frame_checksum = actual_frame_checksum.wrapping_mul(0x100000001b3);
                actual_frame_checksum ^= actual_frame_checksum.rotate_left(17);
            }
            cursor += 8;
            if actual_frame_checksum != declared_frame_checksum {
                diagnostics.push(format!(
                    "frame {ordinal} checksum mismatch at body offset {}",
                    frame_start - body_start
                ));
                continue;
            }
            let identity = match std::str::from_utf8(identity_bytes) {
                Ok(value) => value.to_owned(),
                Err(error) => {
                    diagnostics.push(format!("frame {ordinal} identity is not UTF-8: {error}"));
                    continue;
                }
            };
            if !seen_identities.insert(identity.clone()) {
                diagnostics.push(format!("frame {ordinal} repeats identity {identity}"));
                continue;
            }
            let payload = match std::str::from_utf8(payload_bytes) {
                Ok(value) => value.to_owned(),
                Err(error) => {
                    diagnostics.push(format!("frame {ordinal} payload is not UTF-8: {error}"));
                    String::from_utf8_lossy(payload_bytes).into_owned()
                }
            };
            let account = match accounts.get(account_ordinal) {
                Some(value) => value.clone(),
                None => {
                    diagnostics.push(format!(
                        "frame {ordinal} references absent account dictionary index {account_ordinal}"
                    ));
                    continue;
                }
            };
            records.push(JournalRecord {
                identity,
                account,
                occurred_at,
                payload,
            });
        }
        if records.len() != declared_records {
            diagnostics.push(format!(
                "decoded {} of {declared_records} declared records",
                records.len()
            ));
        }
        if !records.is_empty() {
            let actual_first = records
                .iter()
                .map(|record| record.occurred_at)
                .min()
                .unwrap_or(0);
            let actual_last = records
                .iter()
                .map(|record| record.occurred_at)
                .max()
                .unwrap_or(0);
            if actual_first != first_timestamp {
                diagnostics.push(format!(
                    "first timestamp metadata is {first_timestamp}, decoded minimum is {actual_first}"
                ));
            }
            if actual_last != last_timestamp {
                diagnostics.push(format!(
                    "last timestamp metadata is {last_timestamp}, decoded maximum is {actual_last}"
                ));
            }
        }
        if declared_body_end.saturating_add(4) <= bytes.len() {
            let declared_header_checksum = u32::from_le_bytes([
                bytes[declared_body_end],
                bytes[declared_body_end + 1],
                bytes[declared_body_end + 2],
                bytes[declared_body_end + 3],
            ]);
            let mut actual_header_checksum = 0x811c9dc5u32;
            for byte in &bytes[..body_start] {
                actual_header_checksum ^= *byte as u32;
                actual_header_checksum = actual_header_checksum.wrapping_mul(0x01000193);
            }
            if declared_header_checksum != actual_header_checksum {
                diagnostics.push(format!(
                    "header checksum mismatch: expected {declared_header_checksum:08x}, got {actual_header_checksum:08x}"
                ));
            }
            if declared_body_end + 4 < bytes.len() {
                diagnostics.push(format!(
                    "{} trailing bytes follow the encoded batch",
                    bytes.len() - declared_body_end - 4
                ));
            }
        }
        (records, diagnostics)
    }
}
