// Read-only timestamp access for the dev acceptance harness. Never opens a key for writing.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
public static class ButlerRegistrySnapshot {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern int RegQueryInfoKey(SafeRegistryHandle key, IntPtr keyClass,
        IntPtr classLength, IntPtr reserved, IntPtr subkeys, IntPtr maxSubkey,
        IntPtr maxClass, IntPtr values, IntPtr maxValueName, IntPtr maxValue,
        IntPtr securityLength, out long lastWrite);
    public static string LastWriteUtc(RegistryKey key) {
        long value;
        int error = RegQueryInfoKey(key.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
            IntPtr.Zero, out value);
        if (error != 0) throw new Win32Exception(error);
        return DateTime.FromFileTimeUtc(value).ToString("o");
    }
}
