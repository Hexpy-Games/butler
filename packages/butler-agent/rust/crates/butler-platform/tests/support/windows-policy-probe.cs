// Diagnostic executable compiled only by the desktop test harness. It runs
// under the same filesystem/network/token policy as the tested command.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
public static class WindowsPolicyProbe {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct HostInformation {
        public uint revision;
        public uint hostId;
        [MarshalAs(UnmanagedType.LPWStr)] public string source;
        public IntPtr handle;
    }
    [DllImport("wldp.dll", CharSet=CharSet.Unicode)]
    static extern int WldpGetLockdownPolicy(ref HostInformation host, out uint state, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint QueryDosDevice(string name, System.Text.StringBuilder target, int length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path,
        uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
        System.Text.StringBuilder path, uint length, uint flags);
    static string PhysicalRoot(string drive) {
        using (var handle = CreateFile(drive, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) return "error:" + Marshal.GetLastWin32Error();
            var path = new System.Text.StringBuilder(32768);
            uint result = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
            return result == 0 ? "error:" + Marshal.GetLastWin32Error() : path.ToString();
        }
    }
    static void Attempt(string stage, Action action) {
        try { action(); Console.WriteLine(stage + "_ok=True"); }
        catch (Exception error) {
            while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
            Console.WriteLine(stage + "_ok=False");
            Console.WriteLine(stage + "_exception=" + error.GetType().FullName);
            Console.WriteLine(stage + "_hresult=0x" + error.HResult.ToString("X8"));
            Console.WriteLine(stage + "_message=" + error.Message.Replace('\r',' ').Replace('\n',' '));
        }
    }
    static void ProbeFile(string temp, string extension) {
        string path = Path.Combine(temp, "__PSScriptPolicyTest_" + Path.GetRandomFileName() + extension);
        string stage = "policy_file_" + extension.Substring(1);
        Console.WriteLine(stage + "_path=" + path);
        Console.WriteLine(stage + "_length=" + path.Length);
        Console.WriteLine(stage + "_extended=" + path.StartsWith(@"\\?\"));
        Attempt(stage, delegate {
            try {
                File.WriteAllText(path, "# PowerShell test file to determine AppLocker lockdown mode");
                Console.WriteLine(stage + "_roundtrip=" + File.ReadAllText(path).StartsWith("# PowerShell"));
            } finally { File.Delete(path); }
            Console.WriteLine(stage + "_removed=" + !File.Exists(path));
        });
    }
    static void ProbeTemp() {
        foreach (string name in new [] { "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "BUTLER_COMMAND_TEMP" }) {
            string value = Environment.GetEnvironmentVariable(name) ?? "";
            Console.WriteLine(name + "=" + value);
            Console.WriteLine(name + "_length=" + value.Length);
        }
        string temp = Path.GetTempPath();
        Console.WriteLine("resolved_temp=" + temp);
        Console.WriteLine("resolved_temp_length=" + temp.Length);
        var target = new System.Text.StringBuilder(4096);
        uint result = QueryDosDevice(Path.GetPathRoot(temp).TrimEnd('\\'), target, target.Capacity);
        Console.WriteLine("temp_device_target=" + (result == 0 ? "unavailable" : target.ToString()));
        Console.WriteLine("temp_is_subst=" + (result != 0 && target.ToString().StartsWith(@"\??\")));
        Console.WriteLine("temp_extended=" + temp.StartsWith(@"\\?\"));
        foreach (string extension in new [] { ".ps1", ".psm1" }) ProbeFile(temp, extension);
    }
    static int Drives() {
        foreach (string drive in Environment.GetLogicalDrives()) {
            var target = new System.Text.StringBuilder(32768);
            uint result = QueryDosDevice(drive.TrimEnd('\\'), target, target.Capacity);
            Console.WriteLine("drive=" + drive + " physical=" + (result == 0
                ? "error:" + Marshal.GetLastWin32Error() : target.ToString()));
            Console.WriteLine("drive=" + drive + " final_path=" + PhysicalRoot(drive));
        }
        return 0;
    }
    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--drives") return Drives();
        Attempt("wldp", delegate {
            var host = new HostInformation { revision=1, hostId=4 };
            uint state;
            int hr = WldpGetLockdownPolicy(ref host, out state, 0);
            Console.WriteLine("wldp_hresult=0x{0:X8}", hr);
            Console.WriteLine("wldp_state=0x{0:X8}", state);
        });
        Console.WriteLine("lockdown_env_present=" + (Environment.GetEnvironmentVariable("__PSLockdownPolicy") != null));
        Attempt("temp", ProbeTemp);
        Attempt("policy", delegate {
            var assembly = Assembly.Load("System.Management.Automation, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35");
            Console.WriteLine("policy_assembly=" + assembly.FullName);
            var policy = assembly.GetType("System.Management.Automation.Security.SystemPolicy", true);
            Attempt("system_policy", delegate {
                Console.WriteLine("system_policy=" + policy.GetMethod("GetSystemLockdownPolicy").Invoke(null, null));
            });
            foreach (string name in new [] { "GetWldpPolicy", "GetAppLockerPolicy" }) {
                var method = policy.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic);
                if (method == null) { Console.WriteLine(name + "=unavailable"); continue; }
                Attempt(name, delegate { Console.WriteLine(name + "=" + method.Invoke(null, new object[] { null, null })); });
            }
        });
        return 0;
    }
}
