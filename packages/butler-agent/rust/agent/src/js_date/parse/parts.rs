// Adapted from Bun's BSD-licensed JSDateMath-v8 parser. See LICENSE.txt.

#[derive(Default)]
pub(super) struct Day {
    values: [i64; 3],
    pub(super) count: usize,
    pub(super) month: Option<i64>,
    pub(super) iso: bool,
}
impl Day {
    pub(super) fn add(&mut self, value: i64) -> Option<()> {
        *self.values.get_mut(self.count)? = value;
        self.count += 1;
        Some(())
    }
    pub(super) fn finish(mut self) -> Option<(i64, i64, i64)> {
        if self.count == 0 {
            return None;
        }
        while self.count < 3 {
            self.add(1)?;
        }
        let [first, second, third] = self.values;
        let (mut year, month, day) = match self.month {
            None if self.iso || !(1..=31).contains(&first) => (first, second, third),
            None => (third, first, second),
            Some(month) if !(1..=31).contains(&first) => (first, month, second),
            Some(month) => (second, month, first),
        };
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        ((-1_000_000..=1_000_000).contains(&year)
            && (1..=12).contains(&month)
            && (1..=31).contains(&day))
        .then_some((year, month, day))
    }
}

#[derive(Default)]
pub(super) struct Time {
    values: [i64; 4],
    pub(super) count: usize,
    pub(super) hour_offset: Option<i64>,
}
impl Time {
    pub(super) fn add(&mut self, value: i64) -> Option<()> {
        *self.values.get_mut(self.count)? = value;
        self.count += 1;
        Some(())
    }
    pub(super) fn final_value(&mut self, value: i64) -> Option<()> {
        self.add(value)?;
        while self.count < 4 {
            self.add(0)?;
        }
        Some(())
    }
    pub(super) fn expecting(&self, value: i64) -> bool {
        match self.count {
            1 | 2 => (0..=59).contains(&value),
            3 => (0..=999).contains(&value),
            _ => false,
        }
    }
    pub(super) fn finish(self) -> Option<i64> {
        let [mut hour, minute, second, millis] = self.values;
        if let Some(offset) = self.hour_offset {
            if !(0..=12).contains(&hour) {
                return None;
            }
            hour = hour % 12 + offset;
        }
        let valid = (0..=23).contains(&hour)
            && (0..=59).contains(&minute)
            && (0..=59).contains(&second)
            && (0..=999).contains(&millis);
        (valid || (hour == 24 && minute == 0 && second == 0 && millis == 0))
            .then_some(hour * 3_600_000 + minute * 60_000 + second * 1000 + millis)
    }
}

#[derive(Default)]
pub(super) struct Zone {
    pub(super) sign: Option<i64>,
    pub(super) hour: Option<i64>,
    pub(super) minute: Option<i64>,
}
impl Zone {
    pub(super) fn set(&mut self, offset: i64) {
        self.sign = Some(if offset < 0 { -1 } else { 1 });
        self.hour = Some(offset.abs());
        self.minute = Some(0);
    }
    pub(super) fn utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }
    pub(super) fn expecting(&self, value: i64) -> bool {
        self.hour.is_some() && self.minute.is_none() && (0..=59).contains(&value)
    }
    pub(super) fn finish(&self) -> Option<Option<i64>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        // Source explicitly uses 32-bit unsigned arithmetic before its range
        // check. Retain that behavior even for unusual legacy zone numerals.
        let seconds = (self.hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute.unwrap_or(0) as u32).wrapping_mul(60));
        i32::try_from(seconds)
            .is_ok()
            .then_some(Some(i64::from(seconds) * sign))
    }
}
