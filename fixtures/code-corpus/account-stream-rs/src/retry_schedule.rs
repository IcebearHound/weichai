use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub struct RetrySchedule {
    pub base: Duration,
    pub maximum: Duration,
    pub multiplier: f64,
    pub jitter_fraction: f64,
    pub seed: u64,
}

impl RetrySchedule {
    pub fn validate(&self) -> Result<(), String> {
        if self.base.is_zero() || self.maximum < self.base {
            return Err("retry delay bounds are invalid".to_owned());
        }
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

    pub fn delay(&self, attempt: u32) -> Result<Duration, String> {
        self.validate()?;
        let exponent = attempt.saturating_sub(1).min(63) as i32;
        let nominal = self.base.as_secs_f64() * self.multiplier.powi(exponent);
        let capped = nominal.min(self.maximum.as_secs_f64());
        let random =
            pseudo_fraction(self.seed ^ u64::from(attempt).wrapping_mul(0x9e3779b97f4a7c15));
        let jitter = (random * 2.0 - 1.0) * self.jitter_fraction;
        let adjusted = (capped * (1.0 + jitter)).clamp(0.0, self.maximum.as_secs_f64());
        Ok(Duration::from_secs_f64(adjusted))
    }

    pub fn sequence(&self, attempts: u32) -> Result<Vec<Duration>, String> {
        (1..=attempts).map(|attempt| self.delay(attempt)).collect()
    }

    pub fn budget(&self, attempts: u32) -> Result<Duration, String> {
        let mut total = Duration::ZERO;
        for delay in self.sequence(attempts)? {
            total = total.saturating_add(delay);
        }
        Ok(total)
    }

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

fn pseudo_fraction(mut state: u64) -> f64 {
    state ^= state >> 30;
    state = state.wrapping_mul(0xbf58476d1ce4e5b9);
    state ^= state >> 27;
    state = state.wrapping_mul(0x94d049bb133111eb);
    state ^= state >> 31;
    (state >> 11) as f64 / ((1_u64 << 53) as f64)
}
