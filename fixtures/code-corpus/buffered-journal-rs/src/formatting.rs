/// 生成行情标题:从币对字符串提取字母构成 `BASE/COUNTER`,并按价格量级选择小数位数。
pub fn quote_frame_caption(base: &str, counter: &str, value: f64) -> String {
    // 只保留字母,忽略数字/符号,避免把 `EUR.USD` 之类的变体弄乱。
    let left = base
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>();
    let right = counter
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .collect::<String>();
    let pair = if left.is_empty() || right.is_empty() {
        "UNKNOWN".to_owned()
    } else {
        format!(
            "{}/{}",
            left.to_ascii_uppercase(),
            right.to_ascii_uppercase()
        )
    };
    // 按数值量级调节精度:越大越粗,小值保留更多小数位,兼顾可读性与信息量。
    let rendered = if value.is_finite() {
        if value.abs() >= 10_000.0 {
            format!("{value:.2}")
        } else if value.abs() >= 100.0 {
            format!("{value:.3}")
        } else if value.abs() >= 1.0 {
            format!("{value:.5}")
        } else {
            format!("{value:.7}")
        }
    } else if value.is_nan() {
        "unavailable".to_owned()
    } else if value.is_sign_positive() {
        "+limit".to_owned()
    } else {
        "-limit".to_owned()
    };
    format!("{pair} {rendered}")
}

/// 生成结算面板横幅:区域词大写并以连字符连接,`YYYYMMDD` 格式的日期转为 `YYYY-MM-DD`。
pub fn settlement_banner(region: &str, day: &str) -> String {
    let region = region
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>()
        .join("-");
    let day = day.trim();
    // 8 位纯数字视为紧凑日期,规整为可读格式;空日期显示 unscheduled。
    let date = if day.len() == 8 && day.chars().all(|ch| ch.is_ascii_digit()) {
        format!("{}-{}-{}", &day[0..4], &day[4..6], &day[6..8])
    } else if day.is_empty() {
        "unscheduled".to_owned()
    } else {
        day.to_owned()
    };
    let region = if region.is_empty() {
        "GLOBAL"
    } else {
        region.as_str()
    };
    format!("Settlement board | {region} | {date}")
}

/// 把一组来源名(如行情源名称)规整为 URL 风格的路由片段,并去重。
pub fn provider_route_slug(parts: &[String]) -> String {
    let mut output = Vec::new();
    for part in parts {
        // 非字母数字字符统一折叠为单个连字符,首尾修剪。
        let mut slug = String::new();
        let mut separator = false;
        for ch in part.trim().chars() {
            if ch.is_ascii_alphanumeric() {
                if separator && !slug.is_empty() {
                    slug.push('-');
                }
                slug.push(ch.to_ascii_lowercase());
                separator = false;
            } else {
                separator = true;
            }
        }
        while slug.ends_with('-') {
            slug.pop();
        }
        // 去重:同一 slug 只出现一次。
        if !slug.is_empty() && !output.iter().any(|known| known == &slug) {
            output.push(slug);
        }
    }
    if output.is_empty() {
        "providers/unrouted".to_owned()
    } else {
        format!("providers/{}", output.join("/"))
    }
}

/// 生成交易事件标题:方向缩写归一化为动作词,标的归一化为大写 + `/` 分隔。
pub fn trade_event_title(side: &str, instrument: &str) -> String {
    // 各种买卖/撤改的单字母与单词别名统一为规范动作。
    let action = match side.trim().to_ascii_lowercase().as_str() {
        "b" | "buy" | "bid" | "long" => "BUY",
        "s" | "sell" | "ask" | "short" => "SELL",
        "cancel" | "cxl" => "CANCEL",
        "amend" | "replace" => "AMEND",
        _ => "TRADE",
    };
    // 标的中的非字母数字折叠为 `/`,避免出现多个分隔符。
    let mut normalized = String::new();
    for ch in instrument.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch.to_ascii_uppercase());
        } else if !normalized.ends_with('/') && !normalized.is_empty() {
            normalized.push('/');
        }
    }
    while normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.is_empty() {
        format!("{action} UNKNOWN")
    } else {
        format!("{action} {normalized}")
    }
}

/// 把审计行数格式化为人类可读的标签(如 `1.5k`、`2.3m`)。
pub fn audit_flush_label(count: usize) -> String {
    match count {
        0 => "audit buffer empty".to_owned(),
        1 => "1 audit row ready".to_owned(),
        2..=999 => format!("{count} audit rows ready"),
        // 千级:取一位小数。
        1_000..=999_999 => {
            let whole = count / 1_000;
            let decimal = (count % 1_000) / 100;
            if decimal == 0 {
                format!("{whole}k audit rows ready")
            } else {
                format!("{whole}.{decimal}k audit rows ready")
            }
        }
        // 百万级:同样取一位小数。
        _ => {
            let whole = count / 1_000_000;
            let decimal = (count % 1_000_000) / 100_000;
            if decimal == 0 {
                format!("{whole}m audit rows ready")
            } else {
                format!("{whole}.{decimal}m audit rows ready")
            }
        }
    }
}
