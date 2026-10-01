$ErrorActionPreference = 'Stop'
try {
    $path = $env:BUTLER_ACL_PATH
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($env:BUTLER_ACL_OPERATION -eq 'protect') {
        $directory = [System.IO.Directory]::Exists($path)
        if ($directory) {
            $acl = [System.Security.AccessControl.DirectorySecurity]::new()
            $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $acl = [System.Security.AccessControl.FileSecurity]::new()
            $inherit = [System.Security.AccessControl.InheritanceFlags]::None
        }
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $path -AclObject $acl
    } else {
        $acl = Get-Acl -LiteralPath $path
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        # Elevated tokens may default new inherited children to Administrators
        # ownership. Ownership is not a file-data read grant; inspect every ACE.
        $private = $true
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
