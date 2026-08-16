use std::collections::BTreeMap;

/// 回执信封:一条支付/结算回执的业务字段集合,是编解码的输入输出单位。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptEnvelope {
    pub instruction: String,
    pub receipt: String,
    pub account: String,
    pub sequence: u64,
    pub committed_millis: i64,
    pub attributes: BTreeMap<String, String>,
}

/// 回执帧编解码器:将信封编码为带版本号与 CRC32C 校验的二进制帧。
///
/// 帧布局:`版本(1 字节) | 序列(8) | 提交毫秒(8) | 各字符串(长度前缀) | 属性数(2) | 属性键值对 | 校验和(4)`。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReceiptCodec {
    version: u8,
    maximum_frame: usize,
}

impl ReceiptCodec {
    /// 创建编解码器。`maximum_frame` 必须在 [64, 16 MiB] 内。
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

    /// 编码信封为帧。所有字段使用大端序,保证跨平台字节布局一致。
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
        // 校验和覆盖整个帧(不含校验和本身),解码端据此发现任何位翻转。
        let checksum = crc32c(&frame);
        frame.extend_from_slice(&checksum.to_be_bytes());
        if frame.len() > self.maximum_frame {
            return Err("receipt frame exceeds configured limit".to_owned());
        }
        Ok(frame)
    }

    /// 解码帧为信封;按相反顺序校验长度、版本、校验和与剩余字节,防止截断或伪造帧。
    pub fn decode(&self, frame: &[u8]) -> Result<ReceiptEnvelope, String> {
        // 最小帧:版本(1)+序列(8)+毫秒(8)+三个长度前缀字符串至少 4*3 字节+属性数(2)+校验和(4)。
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
        // 先验校验和再解析字段,避免把损坏数据当作业务字段处理。
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
        // 解析游标必须精确停在载荷末尾,多余字节说明帧结构异常。
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

    /// 不解析整帧,仅读取首字节返回版本号,用于快速路由/筛选。
    pub fn inspect_version(frame: &[u8]) -> Option<u8> {
        frame.first().copied()
    }
}

/// 业务字段合法性校验(与编码共享,保证编码前拒绝畸形信封)。
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

/// 以 u32 大端长度前缀 + 字节序列写入字符串。
fn write_string(target: &mut Vec<u8>, value: &str) -> Result<(), String> {
    let length =
        u32::try_from(value.len()).map_err(|_| "receipt string is too large".to_owned())?;
    target.extend_from_slice(&length.to_be_bytes());
    target.extend_from_slice(value.as_bytes());
    Ok(())
}

/// 读取带长度前缀的字符串;长度先经 `checked_add` 防溢出,再与帧末尾比对防截断。
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

/// CRC32C(Castagnoli 多项式 0x82f63b78)逐字节实现,无依赖、可移植。
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
