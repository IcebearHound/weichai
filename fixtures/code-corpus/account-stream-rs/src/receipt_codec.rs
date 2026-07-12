use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptEnvelope {
    pub instruction: String,
    pub receipt: String,
    pub account: String,
    pub sequence: u64,
    pub committed_millis: i64,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReceiptCodec {
    version: u8,
    maximum_frame: usize,
}

impl ReceiptCodec {
    pub fn new(version: u8, maximum_frame: usize) -> Result<Self, String> {
        if version == 0 {
            return Err("receipt frame version must be positive".to_owned());
        }
        if !(64..=16 * 1024 * 1024).contains(&maximum_frame) {
            return Err("receipt frame limit is outside supported range".to_owned());
        }
        Ok(Self {
            version,
            maximum_frame,
        })
    }

    pub fn encode(&self, envelope: &ReceiptEnvelope) -> Result<Vec<u8>, String> {
        validate_envelope(envelope)?;
        let mut frame = Vec::with_capacity(256);
        frame.push(self.version);
        frame.extend_from_slice(&envelope.sequence.to_be_bytes());
        frame.extend_from_slice(&envelope.committed_millis.to_be_bytes());
        write_string(&mut frame, &envelope.instruction)?;
        write_string(&mut frame, &envelope.receipt)?;
        write_string(&mut frame, &envelope.account)?;
        let attribute_count = u16::try_from(envelope.attributes.len())
            .map_err(|_| "too many receipt attributes".to_owned())?;
        frame.extend_from_slice(&attribute_count.to_be_bytes());
        for (key, value) in &envelope.attributes {
            write_string(&mut frame, key)?;
            write_string(&mut frame, value)?;
        }
        let checksum = crc32c(&frame);
        frame.extend_from_slice(&checksum.to_be_bytes());
        if frame.len() > self.maximum_frame {
            return Err("receipt frame exceeds configured limit".to_owned());
        }
        Ok(frame)
    }

    pub fn decode(&self, frame: &[u8]) -> Result<ReceiptEnvelope, String> {
        if frame.len() < 25 || frame.len() > self.maximum_frame {
            return Err("receipt frame length is invalid".to_owned());
        }
        if frame[0] != self.version {
            return Err("receipt frame version mismatch".to_owned());
        }
        let payload_end = frame.len() - 4;
        let written = u32::from_be_bytes(
            frame[payload_end..]
                .try_into()
                .map_err(|_| "receipt checksum is truncated".to_owned())?,
        );
        if crc32c(&frame[..payload_end]) != written {
            return Err("receipt frame checksum mismatch".to_owned());
        }
        let mut cursor = 1;
        let sequence = read_u64(frame, &mut cursor, payload_end)?;
        let committed_millis = read_i64(frame, &mut cursor, payload_end)?;
        let instruction = read_string(frame, &mut cursor, payload_end)?;
        let receipt = read_string(frame, &mut cursor, payload_end)?;
        let account = read_string(frame, &mut cursor, payload_end)?;
        let attribute_count = read_u16(frame, &mut cursor, payload_end)?;
        let mut attributes = BTreeMap::new();
        for _ in 0..attribute_count {
            let key = read_string(frame, &mut cursor, payload_end)?;
            let value = read_string(frame, &mut cursor, payload_end)?;
            if attributes.insert(key.clone(), value).is_some() {
                return Err(format!("duplicate receipt attribute {key}"));
            }
        }
        if cursor != payload_end {
            return Err("receipt frame contains trailing payload bytes".to_owned());
        }
        let envelope = ReceiptEnvelope {
            instruction,
            receipt,
            account,
            sequence,
            committed_millis,
            attributes,
        };
        validate_envelope(&envelope)?;
        Ok(envelope)
    }

    pub fn inspect_version(frame: &[u8]) -> Option<u8> {
        frame.first().copied()
    }
}

fn validate_envelope(envelope: &ReceiptEnvelope) -> Result<(), String> {
    if envelope.instruction.trim().is_empty()
        || envelope.receipt.trim().is_empty()
        || envelope.account.trim().is_empty()
    {
        return Err("receipt instruction, identity, and account are required".to_owned());
    }
    if envelope.sequence == 0 {
        return Err("receipt sequence must be positive".to_owned());
    }
    if envelope.attributes.len() > 128 {
        return Err("receipt attribute count exceeds 128".to_owned());
    }
    for (key, value) in &envelope.attributes {
        if key.trim().is_empty() || key.len() > 80 || value.len() > 1_024 {
            return Err("receipt attribute is invalid".to_owned());
        }
    }
    Ok(())
}

fn write_string(target: &mut Vec<u8>, value: &str) -> Result<(), String> {
    let length =
        u32::try_from(value.len()).map_err(|_| "receipt string is too large".to_owned())?;
    target.extend_from_slice(&length.to_be_bytes());
    target.extend_from_slice(value.as_bytes());
    Ok(())
}

fn read_string(frame: &[u8], cursor: &mut usize, end: usize) -> Result<String, String> {
    let length = read_u32(frame, cursor, end)? as usize;
    let next = cursor
        .checked_add(length)
        .ok_or_else(|| "receipt string length overflows".to_owned())?;
    if next > end {
        return Err("receipt string is truncated".to_owned());
    }
    let value = std::str::from_utf8(&frame[*cursor..next])
        .map_err(|_| "receipt string is not UTF-8".to_owned())?
        .to_owned();
    *cursor = next;
    Ok(value)
}

fn read_u16(frame: &[u8], cursor: &mut usize, end: usize) -> Result<u16, String> {
    let next = cursor
        .checked_add(2)
        .ok_or_else(|| "u16 cursor overflows".to_owned())?;
    if next > end {
        return Err("u16 field is truncated".to_owned());
    }
    let value = u16::from_be_bytes(
        frame[*cursor..next]
            .try_into()
            .map_err(|_| "u16 conversion failed".to_owned())?,
    );
    *cursor = next;
    Ok(value)
}

fn read_u32(frame: &[u8], cursor: &mut usize, end: usize) -> Result<u32, String> {
    let next = cursor
        .checked_add(4)
        .ok_or_else(|| "u32 cursor overflows".to_owned())?;
    if next > end {
        return Err("u32 field is truncated".to_owned());
    }
    let value = u32::from_be_bytes(
        frame[*cursor..next]
            .try_into()
            .map_err(|_| "u32 conversion failed".to_owned())?,
    );
    *cursor = next;
    Ok(value)
}

fn read_u64(frame: &[u8], cursor: &mut usize, end: usize) -> Result<u64, String> {
    let next = cursor
        .checked_add(8)
        .ok_or_else(|| "u64 cursor overflows".to_owned())?;
    if next > end {
        return Err("u64 field is truncated".to_owned());
    }
    let value = u64::from_be_bytes(
        frame[*cursor..next]
            .try_into()
            .map_err(|_| "u64 conversion failed".to_owned())?,
    );
    *cursor = next;
    Ok(value)
}

fn read_i64(frame: &[u8], cursor: &mut usize, end: usize) -> Result<i64, String> {
    let next = cursor
        .checked_add(8)
        .ok_or_else(|| "i64 cursor overflows".to_owned())?;
    if next > end {
        return Err("i64 field is truncated".to_owned());
    }
    let value = i64::from_be_bytes(
        frame[*cursor..next]
            .try_into()
            .map_err(|_| "i64 conversion failed".to_owned())?,
    );
    *cursor = next;
    Ok(value)
}

fn crc32c(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0x82f63b78 & mask);
        }
    }
    !crc
}
