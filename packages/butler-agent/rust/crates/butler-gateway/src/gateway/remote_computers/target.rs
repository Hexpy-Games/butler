use super::{Computer, HostInput, HttpError, ssh, ssh_key, store::KnownHosts};

pub(super) struct SshTarget {
    pub input: HostInput,
    pub known_hosts: KnownHosts,
    _key: Option<ssh_key::KeyFile>,
}

impl SshTarget {
    pub(super) async fn of(computer: &Computer) -> Result<Self, HttpError> {
        let known_hosts = KnownHosts::write(computer.host_keys.iter().cloned().collect()).await?;
        let mut input = HostInput {
            address: computer.address.clone(),
            port: computer.port.map(i64::from),
            key_file: computer.key_file.clone(),
            identity: None,
        };
        let key = if computer.managed_key {
            Some(ssh_key::managed_target(&mut input).await?)
        } else {
            None
        };
        Ok(Self {
            input,
            known_hosts,
            _key: key,
        })
    }

    pub(super) fn arguments(
        &self,
        mode: &str,
        extra: &[&str],
        command: &str,
    ) -> Result<Vec<String>, HttpError> {
        let home = butler_platform::user_dirs::non_empty_home_dir();
        ssh::arguments(
            &self.input,
            &self.known_hosts.0,
            mode,
            extra,
            command,
            home.as_deref(),
        )
    }
}
