$ErrorActionPreference = 'Stop'
try {
    # PowerShell 5.1 providers impose MAX_PATH; the .NET APIs accept extended paths.
    [AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
    [AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
    $path = $env:BUTLER_ACL_PATH
    $directory = [System.IO.Directory]::Exists($path)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($env:BUTLER_ACL_OPERATION -eq 'protect') {
        if ($directory) {
            $acl = [System.Security.AccessControl.DirectorySecurity]::new()
            $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $acl = [System.Security.AccessControl.FileSecurity]::new()
            $inherit = [System.Security.AccessControl.InheritanceFlags]::None
        }
        $existing = if ($directory) { [System.IO.Directory]::GetAccessControl($path) }
        else { [System.IO.File]::GetAccessControl($path) }
        $owner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        # Writing the current owner requests WRITE_OWNER unnecessarily,
        # which a non-elevated token can lack even when it can replace the DACL.
        if ($owner -ne $sid.Value) { $acl.SetOwner($sid) }
        $acl.SetAccessRuleProtection($true, $false)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
        if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
        else { [System.IO.File]::SetAccessControl($path, $acl) }
    } else {
        $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path) }
        else { [System.IO.File]::GetAccessControl($path) }
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        # Elevated tokens may default new inherited children to Administrators
        # ownership. Built-in privileged owners grant no data access here;
        # an unrelated ordinary owner could change the DACL and is not private.
        $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        $private = $owner -in @($sid.Value, 'S-1-5-32-544', 'S-1-5-18')
        $allowed = $false
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq 'Allow') {
                if ($rule.IdentityReference.Value -ne $sid.Value) { $private = $false }
                if ($rule.IdentityReference.Value -eq $sid.Value -and
                    ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData)) {
                    $allowed = $true
                }
            }
        }
        $private -and $allowed
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
