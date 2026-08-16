use std::time::Duration;

/// 指数退避 + 抖动(jitter)的重试计划参数。
///
/// 第 n 次尝试的标称延迟 = `base * multiplier^(n-1)`,封顶于 `maximum`;
/// 在此基础上叠加以 `seed` 派生出的确定性抖动,保证同参数下结果可复现。
#[derive(Clone, Debug, PartialEq)]
pub struct RetrySchedule {
    /// 首次尝试的基准延迟。
    pub base: Duration,
    /// 任何单次延迟的上限。
    pub maximum: Duration,
    /// 每次尝试的倍增系数,必须 ≥ 1。
    pub multiplier: f64,
    /// 抖动幅度占标称延迟的比例,取值 [0, 1]。
    pub jitter_fraction: f64,
    /// 随机数种子,使重试时间线可预测、可测试。
    pub seed: u64,
}

impl RetrySchedule {
    /// 校验参数组合的合法性。
    pub fn validate(&self) -> Result<(), String> {
        if self.base.is_zero() || self.maximum < self.base {
            return Err("retry delay bounds are invalid".to_owned());
        }
        // multiplier < 1 会导致延迟不增反减,违背退避的单调性。
        if !self.multiplier.is_finite() || self.multiplier < 1.0 {
            return Err("retry multiplier must be finite and at least one".to_owned());
        }
        if !self.jitter_fraction.is_finite()
            || self.jitter_fraction < 0.0
            || self.jitter_fraction > 1.0
        {
            return Err("retry jitter must be between zero and one".to_owned());
        }
        Ok(())
    }

    /// 计算第 `attempt` 次尝试(从 1 开始)应等待的延迟。
    ///
    /// 抖动在 ±jitter_fraction 范围内均匀扰动标称值,最终结果被钳制在 [0, maximum] 内,
    /// 避免退避过大导致下游长时间无请求。
    pub fn delay(&self, attempt: u32) -> Result<Duration, String> {
        self.validate()?;
        // 指数上限 63 防止 powi 溢出;attempt 从 1 开始,首次尝试无退避。
        let exponent = attempt.saturating_sub(1).min(63) as i32;
        let nominal = self.base.as_secs_f64() * self.multiplier.powi(exponent);
        let capped = nominal.min(self.maximum.as_secs_f64());
        // 用种子与尝试次数的混合值派生伪随机数,保证确定性。
        let random =
            pseudo_fraction(self.seed ^ u64::from(attempt).wrapping_mul(0x9e3779b97f4a7c15));
        let jitter = (random * 2.0 - 1.0) * self.jitter_fraction;
        let adjusted = (capped * (1.0 + jitter)).clamp(0.0, self.maximum.as_secs_f64());
        Ok(Duration::from_secs_f64(adjusted))
    }

    /// 生成前 `attempts` 次尝试的完整延迟序列。
    pub fn sequence(&self, attempts: u32) -> Result<Vec<Duration>, String> {
        (1..=attempts).map(|attempt| self.delay(attempt)).collect()
    }

    /// 前 `attempts` 次尝试的延迟总和(饱和加法,不会溢出)。
    pub fn budget(&self, attempts: u32) -> Result<Duration, String> {
        let mut total = Duration::ZERO;
        for delay in self.sequence(attempts)? {
            total = total.saturating_add(delay);
        }
        Ok(total)
    }

    /// 在给定预算内最多可完成的尝试次数(不含会超预算的那次)。
    pub fn attempts_within(&self, budget: Duration, maximum_attempts: u32) -> Result<u32, String> {
        self.validate()?;
        let mut spent = Duration::ZERO;
        for attempt in 1..=maximum_attempts {
            let delay = self.delay(attempt)?;
            if spent.saturating_add(delay) > budget {
                return Ok(attempt - 1);
            }
            spent = spent.saturating_add(delay);
        }
        Ok(maximum_attempts)
    }
}

/// SplitMix64 风格伪随机数生成,将 u64 状态打散为 [0, 1) 内的 f64。
fn pseudo_fraction(mut state: u64) -> f64 {
    state ^= state >> 30;
    state = state.wrapping_mul(0xbf58476d1ce4e5b9);
    state ^= state >> 27;
    state = state.wrapping_mul(0x94d049bb133111eb);
    state ^= state >> 31;
    (state >> 11) as f64 / ((1_u64 << 53) as f64)
}
