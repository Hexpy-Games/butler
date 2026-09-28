//! Typed profile understanding: what a candidate or stable entry says about
//! the user, how sure Butler is, and how Butler should act on it.
//!
//! [`Understanding`] is the part of a `payload_json` row that candidates and
//! stable entries share; its fields are declared in the stored key order.
//! [`StoredUnderstanding`] reads a stored payload the way the legacy readers
//! did, treating a field with the wrong type as absent.

use indexmap::IndexMap;
use serde::de::{Deserializer, Error as _};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Number, Value};

use crate::lenient::{self, Arg};

/// Declares the stored names of a closed set of profile values and their
/// JSON form.
macro_rules! stored_names {
    ($(#[$meta:meta])* $name:ident { $($(#[$doc:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub(crate) enum $name {
            $($(#[$doc])* $variant),+
        }

        impl $name {
            const ALL: &[Self] = &[$(Self::$variant),+];

            /// The stored name.
            pub(crate) fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            /// The value with this stored name.
            pub(crate) fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }

        impl From<$name> for &'static str {
            fn from(value: $name) -> Self {
                value.as_str()
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = String::deserialize(deserializer)?;
                Self::parse(&text)
                    .ok_or_else(|| D::Error::custom(format!("unknown {}", stringify!($name))))
            }
        }
    };
}

stored_names! {
    /// Which part of the user's profile an entry describes.
    Layer {
        /// Durable tendencies and values.
        StableDisposition = "stable_disposition",
        /// Situation-specific collaboration rules.
        ContextualAdaptation = "contextual_adaptation",
        /// Active interests and projects.
        CurrentAttention = "current_attention",
        /// Meaningful events, identity stories and unresolved threads.
        NarrativeMeaning = "narrative_meaning",
    }
}

stored_names! {
    /// How long an entry is expected to hold.
    TemporalScope {
        /// Momentary.
        Transient = "transient",
        /// Holds while it stays relevant.
        Active = "active",
        /// Holds until corrected.
        Durable = "durable",
    }
}

stored_names! {
    /// How an entry fades without new evidence.
    DecayPolicy {
        /// Drops out of the projection a week after its latest evidence.
        Days7 = "days_7",
        /// Drops out of the projection a month after its latest evidence.
        Days30 = "days_30",
        /// Kept while evidence keeps arriving.
        ReinforceOrDecay = "reinforce_or_decay",
        /// Kept until the user says otherwise.
        NeverWithoutConsent = "never_without_consent",
    }
}

stored_names! {
    /// How carefully an entry must be handled, in increasing order.
    Sensitivity {
        /// Ordinary.
        Normal = "normal",
        /// Personal; ask before relying on it.
        Sensitive = "sensitive",
        /// Never surfaced without consent.
        Restricted = "restricted",
    }
}

stored_names! {
    /// Where an observation came from, in increasing strength.
    SourceType {
        /// A cautious interpretation.
        Inference = "inference",
        /// Behaviour seen more than once.
        RepeatedObservation = "repeated_observation",
        /// Stated by the user.
        Explicit = "explicit",
        /// Confirmed by the user.
        UserConfirmed = "user_confirmed",
    }
}

stored_names! {
    /// How sure the extractor was, in increasing order.
    Confidence {
        /// Weak.
        Low = "low",
        /// Moderate.
        Medium = "medium",
        /// Strong.
        High = "high",
    }
}

stored_names! {
    /// Review state of a profile candidate.
    CandidateStatus {
        /// Waiting for more evidence.
        Candidate = "candidate",
        /// Copied into the stable profile.
        Promoted = "promoted",
        /// Rejected by review.
        Rejected = "rejected",
        /// Aged out without enough evidence.
        Expired = "expired",
    }
}

stored_names! {
    /// Whether a candidate expires outright or decays.
    Expiry {
        /// Expires.
        Expires = "expires",
        /// Decays when its evidence ages.
        Decay = "decay",
    }
}

/// When each evidence ref was observed. Values are ISO times or `null`; a
/// stable entry keeps the values it already stored verbatim.
pub(crate) type ObservedTimes = IndexMap<String, Arg<String>>;

/// What an entry says and how Butler should act on it: the stored payload
/// keys from `facet` through `evidence_count`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Understanding {
    /// Profile facet, when the extractor named a known one.
    pub facet: Option<String>,
    /// Short description of the observation, without raw user text.
    pub summary: String,
    /// Situations the entry applies to.
    pub applies_when: Vec<String>,
    /// What Butler should do.
    pub butler_should: Vec<String>,
    /// What Butler should avoid.
    pub butler_should_not: Vec<String>,
    /// How long the entry is expected to hold.
    pub temporal_scope: TemporalScope,
    /// How the entry fades.
    pub decay_policy: DecayPolicy,
    /// Stable entries this one corrects.
    pub contradiction_refs: Vec<String>,
    /// How carefully the entry must be handled.
    pub sensitivity: Sensitivity,
    /// Observations the entry rests on.
    pub evidence_refs: Vec<String>,
    /// When each evidence ref was observed.
    pub evidence_observed_at: ObservedTimes,
    /// Evidence seen so far (a legacy row may hold a fraction).
    pub evidence_count: Number,
}

/// A candidate as the extractor proposed it, before it is merged with what
/// the store already holds.
#[derive(Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(Deserialize), serde(default))]
pub(crate) struct CandidateDraft {
    /// Short description of the observation.
    pub summary: String,
    /// Profile facet, when known.
    pub facet: Option<String>,
    /// Layer, when the extractor chose a valid one.
    pub layer: Option<Layer>,
    /// Situations the candidate applies to.
    pub applies_when: Vec<String>,
    /// What Butler should do.
    pub butler_should: Vec<String>,
    /// What Butler should avoid.
    pub butler_should_not: Vec<String>,
    /// Stable entries the candidate corrects.
    pub contradiction_refs: Vec<String>,
    /// Temporal scope, when valid.
    pub temporal_scope: Option<TemporalScope>,
    /// Decay policy, when valid.
    pub decay_policy: Option<DecayPolicy>,
    /// Sensitivity, when valid.
    pub sensitivity: Option<Sensitivity>,
}

/// A stored `payload_json` as the legacy readers saw it: a field with the
/// wrong type reads as absent.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct StoredUnderstanding {
    /// Layer, when a valid one is stored.
    #[serde(deserialize_with = "lenient::option")]
    pub layer: Option<Layer>,
    /// Facet as stored.
    pub facet: Arg<String>,
    /// Summary as stored.
    pub summary: Arg<String>,
    /// String items of `applies_when`.
    #[serde(deserialize_with = "lenient::string_list")]
    pub applies_when: Vec<String>,
    /// String items of `butler_should`.
    #[serde(deserialize_with = "lenient::string_list")]
    pub butler_should: Vec<String>,
    /// String items of `butler_should_not`.
    #[serde(deserialize_with = "lenient::string_list")]
    pub butler_should_not: Vec<String>,
    /// Temporal scope, when a valid one is stored.
    #[serde(deserialize_with = "lenient::option")]
    pub temporal_scope: Option<TemporalScope>,
    /// Decay policy, when a valid one is stored.
    #[serde(deserialize_with = "lenient::option")]
    pub decay_policy: Option<DecayPolicy>,
    /// String items of `contradiction_refs`.
    #[serde(deserialize_with = "lenient::string_list")]
    pub contradiction_refs: Vec<String>,
    /// Sensitivity, when a valid one is stored.
    #[serde(deserialize_with = "lenient::option")]
    pub sensitivity: Option<Sensitivity>,
    /// String items of `evidence_refs`.
    #[serde(deserialize_with = "lenient::string_list")]
    pub evidence_refs: Vec<String>,
    /// Observation times; empty when not an object.
    #[serde(deserialize_with = "observed_times")]
    pub evidence_observed_at: ObservedTimes,
    /// Evidence count, when a number is stored.
    #[serde(deserialize_with = "lenient::option")]
    pub evidence_count: Option<Number>,
    /// Whether the entry touches a sensitive domain, when stored.
    #[serde(deserialize_with = "lenient::option")]
    pub sensitive_domain: Option<bool>,
}

impl StoredUnderstanding {
    /// Parses a stored `payload_json`; JSON that is not an object reads as
    /// empty.
    pub(crate) fn parse(raw: &str) -> serde_json::Result<Self> {
        serde_json::from_str::<Value>(raw).map(|value| lenient::view(&value))
    }

    /// The stored summary, or `""`.
    pub(crate) fn summary_text(&self) -> &str {
        self.summary.valid().map_or("", String::as_str)
    }

    /// The stored facet when it is a string.
    pub(crate) fn facet_text(&self) -> Option<&str> {
        self.facet.valid().map(String::as_str)
    }
}

fn observed_times<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ObservedTimes, D::Error> {
    let Value::Object(times) = Value::deserialize(deserializer)? else {
        return Ok(ObservedTimes::new());
    };
    Ok(times
        .into_iter()
        .map(|(reference, time)| {
            let time = serde_json::from_value(time).unwrap_or_default();
            (reference, time)
        })
        .collect())
}
