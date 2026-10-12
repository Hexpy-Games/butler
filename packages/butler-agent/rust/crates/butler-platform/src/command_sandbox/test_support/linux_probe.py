"""Linux syscall ABI fixture; compiled into test-support builds only."""
import ctypes
import errno
import platform
import socket
import os
import fcntl

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def denied(number, *args):
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(number), *args)
    assert result == -1 and ctypes.get_errno() == errno.EPERM, (
        number, args, result, ctypes.get_errno()
    )


if platform.machine() == 'x86_64':
    sockets, pairs, connect = 41, 53, 42
    metadata = [90, 91, 268, 452, 92, 93, 94, 260, 132, 235, 280, 261,
                188, 189, 190, 197, 198, 199, 463, 466]
    encodings = [0, 0x40000000]
elif platform.machine() in ('aarch64', 'riscv64'):
    sockets, pairs, connect = 198, 199, 203
    metadata = [52, 53, 452, 54, 55, 88, 5, 6, 7, 14, 15, 16, 463, 466]
    encodings = [0]
else:
    raise AssertionError('unsupported syscall probe architecture')

for encoding in encodings:
    for family in range(64):
        # AF_VSOCK=40, TIPC=30, RDS=21, BLUETOOTH=31, ALG=38, XDP=44,
        # and unknown families all fail closed before protocol validation.
        denied(sockets | encoding, family, socket.SOCK_STREAM, 0)
        if family != socket.AF_UNIX:
            denied(pairs | encoding, family, socket.SOCK_STREAM, 0, 0)
    for kind in (socket.SOCK_DGRAM, socket.SOCK_SEQPACKET, socket.SOCK_RAW):
        denied(pairs | encoding, socket.AF_UNIX, kind, 0, 0)
    for protocol in (1, 3, -1):
        denied(pairs | encoding, socket.AF_UNIX, socket.SOCK_STREAM, protocol, 0)
    denied(425 | encoding, 1, 0)  # io_uring_setup
    denied(connect | encoding, -1, 0, 0)
    for number in metadata:
        # Invalid arguments would yield EFAULT/EBADF/ENOSYS without seccomp.
        denied(number | encoding, -1, 0, 0, 0, 0, 0)

# Allowed anonymous streams remain local, including both permitted flags.
for flags in (0, socket.SOCK_CLOEXEC, socket.SOCK_NONBLOCK,
              socket.SOCK_CLOEXEC | socket.SOCK_NONBLOCK):
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM | flags)
    a.send(b'complete-local-message')
    assert b.recv(100) == b'complete-local-message'
    try:
        a.connect('/missing-external-peer')
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError('connected stream reconnected')
    a.close()
    b.close()

# An unknown device ioctl would normally yield ENOTTY on /dev/null. Landlock
# v5 must reject it before reaching the device driver, including readable fds.
fd = os.open('/dev/null', os.O_RDONLY)
try:
    fcntl.ioctl(fd, 0x1234, 0)
except OSError as error:
    assert error.errno == errno.EACCES, error
else:
    raise AssertionError('device ioctl escaped')
os.close(fd)
print('all-syscalls-covered')
