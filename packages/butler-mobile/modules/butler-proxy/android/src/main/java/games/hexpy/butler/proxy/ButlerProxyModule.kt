package games.hexpy.butler.proxy

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class ButlerProxyModule : Module() {
  private class Conn(val port: Int, val socket: Socket, val writer: ExecutorService)

  private val servers = ConcurrentHashMap<Int, ServerSocket>()
  private val accepted = ConcurrentHashMap<Socket, Int>()
  private val conns = ConcurrentHashMap<Int, Conn>()
  private val nextId = AtomicInteger(1)

  override fun definition() = ModuleDefinition {
    Name("ButlerProxy")
    Events("onRequest", "onCancel")

    AsyncFunction("start") { promise: Promise ->
      try {
        val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val port = server.localPort
        servers[port] = server
        thread(isDaemon = true, name = "butler-proxy-$port") { accept(server, port) }
        promise.resolve(port)
      } catch (error: IOException) {
        promise.reject("ERR_PROXY_START", "Could not start listener", error)
      }
    }

    Function("stop") { port: Int -> stop(port) }

    Function("respondHead") { id: Int, status: Int, headers: Map<String, String> ->
      val conn = conns[id] ?: return@Function
      val head = buildString {
        append("HTTP/1.1 $status \r\n")
        for ((name, value) in headers) {
          if ('\r' !in name && '\n' !in name && '\r' !in value && '\n' !in value) append("$name: $value\r\n")
        }
        append("connection: close\r\n\r\n")
      }
      try {
        conn.writer.execute {
          try {
            conn.socket.getOutputStream().write(head.toByteArray())
          } catch (_: IOException) {
            cancelled(id, conn)
          }
        }
      } catch (_: RejectedExecutionException) {}
    }

    // Expo copies a JS Uint8Array into ByteArray before dispatching.
    AsyncFunction("respondChunk") { id: Int, bytes: ByteArray, promise: Promise ->
      val conn = conns[id]
      if (conn == null) {
        closed(promise)
        return@AsyncFunction
      }
      val write = object : FutureTask<Unit>({
        try {
          conn.socket.getOutputStream().write(bytes)
          promise.resolve(null)
        } catch (_: IOException) {
          cancelled(id, conn)
          closed(promise)
        }
      }) {
        override fun done() {
          if (isCancelled) closed(promise)
        }
      }
      try {
        conn.writer.execute(write)
      } catch (_: RejectedExecutionException) {
        closed(promise)
      }
    }

    Function("respondEnd") { id: Int ->
      val conn = conns.remove(id) ?: return@Function
      conn.writer.execute {
        try {
          conn.socket.getOutputStream().flush()
        } catch (_: IOException) {
        } finally {
          close(conn.socket)
          conn.writer.shutdown()
        }
      }
    }

    Function("respondAbort") { id: Int -> conns.remove(id)?.let(::abort) }
    OnDestroy { servers.keys.toList().forEach(::stop) }
  }

  private fun accept(server: ServerSocket, port: Int) {
    try {
      while (true) {
        val socket = server.accept()
        synchronized(server) {
          if (server.isClosed) {
            close(socket)
            return
          }
          accepted[socket] = port
        }
        thread(isDaemon = true) { request(server, socket, port) }
      }
    } catch (_: IOException) {}
  }

  private fun request(server: ServerSocket, socket: Socket, port: Int) {
    try {
      socket.soTimeout = 30_000
      val lines = readHead(socket)?.split("\r\n") ?: return close(socket)
      val request = lines[0].split(' ')
      if (request.size != 3 || !request[1].startsWith("/")) return close(socket)
      val headers = mutableMapOf<String, String>()
      for (line in lines.drop(1)) {
        val colon = line.indexOf(':')
        if (colon < 0) continue
        val name = line.substring(0, colon).lowercase()
        val value = line.substring(colon + 1).trim()
        val separator = if (name == "cookie") "; " else ", "
        headers[name] = headers[name]?.let { it + separator + value } ?: value
      }
      synchronized(server) {
        if (server.isClosed) return close(socket)
        val id = nextId.getAndIncrement()
        conns[id] = Conn(port, socket, Executors.newSingleThreadExecutor())
        sendEvent("onRequest", mapOf("id" to id, "port" to port, "method" to request[0], "target" to request[1], "headers" to headers))
      }
    } catch (_: IOException) {
      close(socket)
    }
  }

  private fun readHead(socket: Socket): String? {
    val input = socket.getInputStream()
    val head = ByteArrayOutputStream()
    var tail = 0
    repeat(16_384) {
      val byte = input.read()
      if (byte < 0) return null
      head.write(byte)
      tail = (tail shl 8) or byte
      if (tail == 0x0d0a0d0a) {
        val bytes = head.toByteArray()
        return String(bytes, 0, bytes.size - 4, Charsets.UTF_8)
      }
    }
    return null
  }

  private fun closed(promise: Promise) {
    promise.reject("ERR_PROXY_CLOSED", "Connection closed", null)
  }

  private fun cancelled(id: Int, conn: Conn) {
    if (conns.remove(id, conn)) {
      abort(conn)
      sendEvent("onCancel", mapOf("id" to id))
    }
  }

  private fun abort(conn: Conn) {
    close(conn.socket)
    conn.writer.shutdownNow().forEach { (it as? FutureTask<*>)?.cancel(false) }
  }

  private fun close(socket: Socket) {
    accepted.remove(socket)
    try { socket.close() } catch (_: IOException) {}
  }

  private fun stop(port: Int) {
    val server = servers.remove(port) ?: return
    synchronized(server) {
      try { server.close() } catch (_: IOException) {}
      for ((id, conn) in conns) if (conn.port == port && conns.remove(id, conn)) abort(conn)
      for ((socket, number) in accepted) if (number == port) close(socket)
    }
  }
}
