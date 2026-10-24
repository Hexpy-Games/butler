//! RS256 verification. ID tokens never enter the credential store or diagnostics.
use super::{
    Error,
    authority::{ChatGptAuthority, Discovery},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub enum InvalidReason {
    Alg,
    Kid,
    Signature,
    Iss,
    Aud,
    Exp,
    Nonce,
    Sub,
    Malformed,
}

fn decode(value: &str) -> Result<Vec<u8>, InvalidReason> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| InvalidReason::Malformed)
}

pub async fn verify(
    authority: &ChatGptAuthority,
    discovery: &Discovery,
    token: &str,
    client: &str,
    nonce: &str,
    now: i64,
) -> Result<Value, Error> {
    validate(authority, discovery, token, client, nonce, now)
        .await
        .map_err(|_| "oauth_id_token_invalid")
}
async fn validate(
    authority: &ChatGptAuthority,
    discovery: &Discovery,
    token: &str,
    client: &str,
    nonce: &str,
    now: i64,
) -> Result<Value, InvalidReason> {
    let parts = token.split('.').collect::<Vec<_>>();
    let [header, payload, signature] = parts.as_slice() else {
        return Err(InvalidReason::Malformed);
    };
    let header_json: Value =
        serde_json::from_slice(&decode(header)?).map_err(|_| InvalidReason::Malformed)?;
    let claims: Value =
        serde_json::from_slice(&decode(payload)?).map_err(|_| InvalidReason::Malformed)?;
    if header_json["alg"] != "RS256" {
        return Err(InvalidReason::Alg);
    }
    let kid = header_json["kid"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(InvalidReason::Kid)?;
    let key = authority
        .key(discovery, kid)
        .await
        .map_err(|_| InvalidReason::Kid)?;
    let n = decode(key["n"].as_str().ok_or(InvalidReason::Malformed)?)?;
    let e = decode(key["e"].as_str().ok_or(InvalidReason::Malformed)?)?;
    RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            format!("{header}.{payload}").as_bytes(),
            &decode(signature)?,
        )
        .map_err(|_| InvalidReason::Signature)?;
    if claims["iss"] != discovery.issuer {
        return Err(InvalidReason::Iss);
    }
    let audience = &claims["aud"];
    let valid_audience = audience == client
        || audience.as_array().is_some_and(|a| {
            a.iter().all(Value::is_string)
                && a.iter().any(|v| v == client)
                && (a.len() == 1 || claims["azp"] == client)
        });
    if !valid_audience {
        return Err(InvalidReason::Aud);
    }
    if claims["exp"].as_i64().is_none_or(|exp| exp <= now - 5) || claims["iat"].as_i64().is_none() {
        return Err(InvalidReason::Exp);
    }
    if claims["nonce"] != nonce {
        return Err(InvalidReason::Nonce);
    }
    if claims["sub"].as_str().is_none_or(str::is_empty) {
        return Err(InvalidReason::Sub);
    }
    for key in ["email", "name"] {
        if !claims[key].is_null() && !claims[key].is_string() {
            return Err(InvalidReason::Malformed);
        }
    }
    Ok(claims)
}
