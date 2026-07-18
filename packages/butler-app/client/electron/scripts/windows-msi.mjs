export const BUTLER_MSI_UPGRADE_CODE = "63999A0D-C024-4425-A8FB-C279A1D93332";
export const BUTLER_MSI_COMPONENT_GUID = "EDA74360-3586-45C0-A1DD-AAE697B5D1A6";

export function butlerPerUserMsiWix({ version }) {
  const msiVersion = windowsMsiVersion(version);
  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Butler" Language="1033" Codepage="1252" Version="${msiVersion}" UpgradeCode="${BUTLER_MSI_UPGRADE_CODE}" Manufacturer="Hexpy Games">
    <Package Description="Installs Butler for the current user." InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" Platform="x64" />
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A later version of Butler is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
    <Property Id="MSIINSTALLPERUSER" Value="1" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="ButlerInstallerDirectory" Name="Butler Installer" />
      </Directory>
    </Directory>

    <DirectoryRef Id="ButlerInstallerDirectory">
      <Component Id="ButlerBootstrapperComponent" Guid="${BUTLER_MSI_COMPONENT_GUID}" Win64="yes">
        <File Id="ButlerBootstrapper" Name="butler_update_setup.exe" Source="butler_update_setup.exe" />
        <RegistryValue Root="HKCU" Key="Software\\Hexpy Games\\Butler Installer" Name="Installed" Type="integer" Value="1" KeyPath="yes" />
        <RemoveFolder Id="RemoveButlerInstallerDirectory" On="uninstall" />
      </Component>
    </DirectoryRef>

    <Feature Id="ButlerFeature" Title="Butler" Level="1">
      <ComponentRef Id="ButlerBootstrapperComponent" />
    </Feature>

    <CustomAction Id="InstallButler" FileKey="ButlerBootstrapper" ExeCommand="--silent" Execute="deferred" Impersonate="yes" Return="check" />
    <CustomAction Id="UninstallButler" FileKey="ButlerBootstrapper" ExeCommand="--uninstall -s" Execute="deferred" Impersonate="yes" Return="ignore" />
    <InstallExecuteSequence>
      <Custom Action="UninstallButler" Before="RemoveFiles">REMOVE=&quot;ALL&quot;</Custom>
      <Custom Action="InstallButler" After="InstallFiles">NOT REMOVE</Custom>
    </InstallExecuteSequence>
  </Product>
</Wix>
`;
}

function windowsMsiVersion(version) {
  const parts = String(version).split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/u.test(part))) {
    throw new Error("Windows MSI version must contain three numeric components");
  }
  const values = parts.map(Number);
  if (values.some((value) => value < 0 || value > 65_534)) {
    throw new Error("Windows MSI version component is out of range");
  }
  return values.join(".");
}
