use std::path::Path;

use zeroize::Zeroizing;

use super::{KeychainSlot, Vault, VaultError, device_key::DeviceKey, store};

#[expect(
    clippy::expect_used,
    reason = "a fixed age HRP and 32-byte secret form a valid identity"
)]
fn recovery_identity(secret: &[u8; 32]) -> DeviceKey {
    let hrp = bech32::Hrp::parse("age-secret-key-").expect("fixed age HRP");
    let mut text = Zeroizing::new(
        bech32::encode::<bech32::Bech32>(hrp, secret).expect("fixed age secret length"),
    );
    text.make_ascii_uppercase();
    DeviceKey::parse(&text).expect("encoded age identity")
}

pub fn recovery_recipient(secret: &[u8; 32]) -> String {
    recovery_identity(secret).recipient().to_owned()
}

impl Vault {
    pub fn set_recovery_recipient(
        &self,
        old: Option<&str>,
        new: Option<&str>,
    ) -> Result<(), VaultError> {
        self.save(|payload, _, _| {
            if old == new {
                return Ok(false);
            }
            let len = payload.recipients.len();
            payload
                .recipients
                .retain(|recipient| Some(recipient.as_str()) != old);
            if let Some(new) = new
                && !payload.recipients.iter().any(|recipient| recipient == new)
            {
                payload.recipients.push(new.to_owned());
                Ok(true)
            } else {
                Ok(payload.recipients.len() != len)
            }
        })?;
        Ok(())
    }
}

pub fn rekey_restored(
    staged: &Path,
    recovery_secret: &[u8; 32],
    slot: &KeychainSlot,
    folder: &Path,
) -> Result<(), VaultError> {
    let device = DeviceKey::generate();
    let sealed = rekey_payload(
        &std::fs::read(staged).map_err(VaultError::Io)?,
        recovery_secret,
        &device,
    )?;
    slot.write(&device)?;
    store::write_private(&folder.join("vault.age"), &sealed)
}

fn rekey_payload(
    staged: &[u8],
    recovery_secret: &[u8; 32],
    device: &DeviceKey,
) -> Result<Vec<u8>, VaultError> {
    let recovery = recovery_identity(recovery_secret);
    let mut payload = store::decode(&recovery, staged)?;
    payload.recipients = vec![
        device.recipient().to_owned(),
        recovery.recipient().to_owned(),
    ];
    let sealed = store::seal(&payload)?;
    store::decode(device, &sealed)?;
    Ok(sealed)
}
