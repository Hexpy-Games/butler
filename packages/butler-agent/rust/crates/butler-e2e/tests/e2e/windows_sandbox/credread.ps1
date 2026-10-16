$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CredentialProbe {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr credentials);
 public static bool Visible() {
  int count; IntPtr all;
  if (CredEnumerate(null,0,out count,out all)) { CredFree(all); if (count > 0) return true; }
  IntPtr credential;
  if (!CredRead("Butler",1,0,out credential)) return false;
  CredFree(credential); return true;
 }
}
'@
if ([CredentialProbe]::Visible()) { exit 1 }
exit 0
