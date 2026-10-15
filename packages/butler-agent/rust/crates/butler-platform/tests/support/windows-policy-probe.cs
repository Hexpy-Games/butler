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
    public static int Main() {
        try {
            var host = new HostInformation { revision=1, hostId=4 };
            uint state;
            int hr = WldpGetLockdownPolicy(ref host, out state, 0);
            Console.WriteLine("wldp_hresult=0x{0:X8} state=0x{1:X8}", hr, state);
            Console.WriteLine("lockdown_env_present=" + (Environment.GetEnvironmentVariable("__PSLockdownPolicy") != null));
            var path = Path.Combine(Path.GetTempPath(), "butler-policy-probe.txt");
            File.WriteAllText(path, "complete");
            Console.WriteLine("temp_roundtrip=" + (File.ReadAllText(path) == "complete"));
            File.Delete(path);
            var assembly = Assembly.Load("System.Management.Automation, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35");
            var policy = assembly.GetType("System.Management.Automation.Security.SystemPolicy", true);
            Console.WriteLine("system_policy=" + policy.GetMethod("GetSystemLockdownPolicy").Invoke(null, null));
            foreach (string name in new [] { "GetWldpPolicy", "GetAppLockerPolicy" }) {
                var method = policy.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic);
                if (method == null) { Console.WriteLine(name + "=unavailable"); continue; }
                try { Console.WriteLine(name + "=" + method.Invoke(null, new object[] { null, null })); }
                catch (TargetInvocationException error) {
                    Console.WriteLine(name + "_error=" + error.InnerException.GetType().Name);
                }
            }
            return 0;
        } catch (Exception error) {
            Console.WriteLine("policy_probe_error=" + error.GetType().Name + " hresult=0x" + error.HResult.ToString("X8"));
            return 1;
        }
    }
}
