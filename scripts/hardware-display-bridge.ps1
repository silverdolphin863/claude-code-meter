param(
  [string]$PortName = 'auto',
  [int]$BaudRate = 115200
)

$ErrorActionPreference = 'Stop'

if ($PortName -eq 'auto') {
  $taskDevice = Get-CimInstance Win32_PnPEntity |
    Where-Object {
      $_.PNPDeviceID -like 'USB\VID_1A86&PID_7523*' -and
      $_.Name -match '\((COM\d+)\)'
    } |
    Select-Object -First 1
  if ($taskDevice -and $taskDevice.Name -match '\((COM\d+)\)') {
    $PortName = $Matches[1]
  } else {
    $taskPorts = @([System.IO.Ports.SerialPort]::GetPortNames())
    if ($taskPorts.Count -eq 1) {
      $PortName = $taskPorts[0]
    } else {
      [Console]::Error.WriteLine('BRIDGE_ERROR CC Meter display not found')
      exit 2
    }
  }
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Ports;
using System.Text;
using System.Threading;

public static class CCMeterSerialBridge
{
    private const int WriteChunkSize = 16;
    private const int WritePauseMs = 10;

    private static void WritePacedLine(SerialPort port, string line)
    {
        byte[] bytes = port.Encoding.GetBytes(line + "\n");
        for (int offset = 0; offset < bytes.Length; offset += WriteChunkSize)
        {
            int count = Math.Min(WriteChunkSize, bytes.Length - offset);
            port.Write(bytes, offset, count);
            if (offset + count < bytes.Length) Thread.Sleep(WritePauseMs);
        }
    }

    public static int Run(string portName, int baudRate)
    {
        using (var port = new SerialPort(portName, baudRate, Parity.None, 8, StopBits.One))
        {
            port.DtrEnable = false;
            port.RtsEnable = false;
            port.Encoding = new UTF8Encoding(false);
            port.NewLine = "\n";
            port.ReadTimeout = 250;
            port.WriteTimeout = 2000;
            port.Open();

            bool stopping = false;
            var reader = new Thread(() =>
            {
                while (!stopping)
                {
                    try
                    {
                        string line = port.ReadLine();
                        if (line.Length <= 4096)
                        {
                            Console.Out.WriteLine(line.TrimEnd('\r', '\n'));
                            Console.Out.Flush();
                        }
                    }
                    catch (TimeoutException) { }
                    catch (Exception error)
                    {
                        Console.Error.WriteLine("SERIAL_ERROR " + error.GetType().Name);
                        Console.Error.Flush();
                        break;
                    }
                }
            });
            reader.IsBackground = true;
            reader.Start();

            Console.Out.WriteLine("READY " + portName);
            Console.Out.Flush();
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Length == 0 || line.Length > 65536) continue;
                    WritePacedLine(port, line);
                }
            }
            finally
            {
                stopping = true;
                if (reader.IsAlive) reader.Join(500);
            }
        }
        return 0;
    }
}
'@

try {
  exit [CCMeterSerialBridge]::Run($PortName, $BaudRate)
} catch {
  [Console]::Error.WriteLine('BRIDGE_ERROR ' + $_.Exception.GetType().Name)
  exit 3
}
