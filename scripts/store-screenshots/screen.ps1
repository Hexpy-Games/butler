param(
    [Parameter(Mandatory)]
    [ValidateSet('Resolution', 'Capture', 'Pointer')]
    [string]$Mode,
    [string]$Out,
    [int]$X = 900,
    [int]$Y = 24
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class StoreScreen
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public short SpecVersion, DriverVersion, Size, DriverExtra;
        public int Fields;
        public int PositionX, PositionY, DisplayOrientation, DisplayFixedOutput;
        public short Color, Duplex, YResolution, TTOption, Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
        public short LogPixels;
        public int BitsPerPel, Width, Height, DisplayFlags, Frequency;
        public int ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2;
        public int PanningWidth, PanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettings(string device, int mode, ref DevMode settings);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsEx(
        string device, ref DevMode mode, IntPtr window, int flags, IntPtr parameters);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    private static DevMode Current()
    {
        var mode = new DevMode { Size = (short)Marshal.SizeOf(typeof(DevMode)) };
        if (!EnumDisplaySettings(null, -1, ref mode))
            throw new InvalidOperationException("Cannot read primary display settings");
        return mode;
    }

    public static void Resolution()
    {
        var mode = Current();
        if (mode.Width != 1920 || mode.Height != 1080)
        {
            mode.Width = 1920;
            mode.Height = 1080;
            mode.Fields = 0x00040000 | 0x00080000 | 0x00100000 | 0x00400000;
            int result = ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 1, IntPtr.Zero);
            if (result != 0) Console.Error.WriteLine("ChangeDisplaySettingsEx returned " + result);
        }
        mode = Current();
        Console.WriteLine("{0}x{1}", mode.Width, mode.Height);
        if (mode.Width != 1920 || mode.Height != 1080)
            throw new InvalidOperationException("Primary display must be 1920x1080");
    }

    public static void Pointer(int x, int y)
    {
        if (!SetCursorPos(x, y)) throw new Win32Exception();
    }

    public static void Capture(string path)
    {
        using (var bitmap = new Bitmap(1920, 1080, PixelFormat.Format24bppRgb))
        {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(0, 0, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
            for (int y = 8; y < bitmap.Height; y += 16)
            {
                for (int x = 8; x < bitmap.Width; x += 16)
                {
                    if ((bitmap.GetPixel(x, y).ToArgb() & 0xffffff) == 0) continue;
                    bitmap.Save(path, ImageFormat.Png);
                    return;
                }
            }
        }
        throw new InvalidOperationException("All sampled screen pixels were black");
    }
}
'@

switch ($Mode) {
    Resolution { [StoreScreen]::Resolution() }
    Pointer { [StoreScreen]::Pointer($X, $Y) }
    Capture {
        if (-not $Out) { throw '-Out is required for Capture' }
        [StoreScreen]::Capture($Out)
    }
}
